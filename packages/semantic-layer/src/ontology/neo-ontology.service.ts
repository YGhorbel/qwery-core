import { getLogger } from '@qwery/shared/logger';
import { HumanMessage } from '@langchain/core/messages';
import { z } from 'zod';
import type {
  ManagedTransaction,
  Record as Neo4jRecord,
  Session,
} from 'neo4j-driver';

import {
  generateEmbedding,
  datasetEmbeddingText,
  EMBEDDING_DIMENSIONS,
} from '../embedding';
import { extractJsonFromText, getChatModel } from '../llm';
import { getNeo4jDriver } from '../neo4j';
import type { OSIDataset, OSIField, OSISemanticModel } from '../osi/types';

export interface DatasetResult {
  name: string;
  label: string;
  source: string;
  description: string;
}

export interface DatasetSearchResult extends DatasetResult {
  score: number;
  fields: string; // JSON string
}

export interface GraphStats {
  nodeCount: number;
  relationshipCount: number;
  datasetCount: number;
}

export class NeoOntologyService {
  async createGraph(
    datasourceId: string,
    model: OSISemanticModel,
  ): Promise<GraphStats> {
    const logger = await getLogger();
    const def = model.semantic_model[0];
    if (!def) throw new Error('Empty semantic model');

    const driver = getNeo4jDriver();
    const session = driver.session();

    try {
      await this.clearSubgraph(session, datasourceId);

      const concepts = await this.resolveConcepts(def.datasets);
      await this.createConceptNodes(session, datasourceId, concepts);

      const datasetToConcept = await this.resolveDatasetConceptAssignments(
        def.datasets,
        concepts.map((c) => c.name),
      );
      await this.createDatasetNodes(
        session,
        datasourceId,
        def.datasets,
        datasetToConcept,
      );

      await this.createFieldNodes(session, datasourceId, def.datasets);

      // Join edges for the Data Agent remain RELATES_TO
      await this.createJoinEdges(
        session,
        datasourceId,
        def.relationships ?? [],
      );

      // Semantic enrichment
      const semanticEdgesFromPairs =
        await this.extractSemanticEdgesFromJoinPairs(
          def.datasets,
          def.relationships ?? [],
        );
      const triples = await this.extractSemanticTriplesFromDescriptions(
        def.datasets,
      );
      const validatedTriples = await this.validateTriples(
        def.datasets,
        triples,
      );

      const semanticEdges = [
        ...semanticEdgesFromPairs,
        ...validatedTriples.map((t) => ({
          from: t.subject,
          to: t.object,
          relation: t.relation,
          confidence: t.confidence,
          source: 'description_extracted' as const,
          validated: true,
          validationReason: t.validationReason,
        })),
      ];
      await this.writeSemanticEdges(session, datasourceId, semanticEdges);

      // Ensure vector index exists
      await session.run(
        `CREATE VECTOR INDEX dataset_embedding IF NOT EXISTS
         FOR (n:Dataset) ON (n.embedding)
         OPTIONS {
           indexConfig: {
             \`vector.dimensions\`: ${EMBEDDING_DIMENSIONS},
             \`vector.similarity_function\`: 'cosine'
           }
         }`,
      );

      // Generate and store embeddings (enriched)
      logger.info(
        { datasourceId, datasets: def.datasets.length },
        'semantic-layer: generating embeddings',
      );
      const embeddingCache = await this.generateAndStoreEmbeddings(
        session,
        datasourceId,
        def.datasets,
        datasetToConcept,
        semanticEdges,
      );

      await this.deduplicateSynonyms(
        session,
        datasourceId,
        def.datasets,
        embeddingCache,
      );

      // Count results
      const statsResult = await session.run(
        `MATCH (n {ontologyId: $ontologyId})
         RETURN
           count(n) AS nodeCount,
           count(CASE WHEN n:Dataset THEN 1 END) AS datasetCount`,
        { ontologyId: datasourceId },
      );

      const relResult = await session.run(
        `MATCH ()-[r {ontologyId: $ontologyId}]->()
         RETURN count(r) AS relationshipCount`,
        { ontologyId: datasourceId },
      );

      const stats = statsResult.records[0];
      const relStats = relResult.records[0];

      return {
        nodeCount: stats?.get('nodeCount').toNumber() ?? 0,
        datasetCount: stats?.get('datasetCount').toNumber() ?? 0,
        relationshipCount: relStats?.get('relationshipCount').toNumber() ?? 0,
      };
    } finally {
      await session.close();
    }
  }

  private async clearSubgraph(session: Session, datasourceId: string) {
    await session.run('MATCH (n {ontologyId: $ontologyId}) DETACH DELETE n', {
      ontologyId: datasourceId,
    });
  }

  private getDatasetAiContext(dataset: OSIDataset): Record<string, unknown> {
    if (dataset.ai_context && typeof dataset.ai_context === 'object') {
      return dataset.ai_context as Record<string, unknown>;
    }
    return {};
  }

  private getFieldAiContext(field: OSIField): Record<string, unknown> {
    if (field.ai_context && typeof field.ai_context === 'object') {
      return field.ai_context as Record<string, unknown>;
    }
    return {};
  }

  private async resolveConcepts(
    datasets: OSIDataset[],
  ): Promise<Array<{ name: string; description: string }>> {
    const categories = new Set<string>();
    for (const d of datasets) {
      const aiCtx = this.getDatasetAiContext(d);
      const category = aiCtx['category'];
      if (typeof category === 'string' && category.trim())
        categories.add(category.trim());
    }
    if (categories.size > 0) {
      return [...categories].map((name) => ({ name, description: '' }));
    }

    // LLM fallback: infer 4–8 top-level concepts
    const prompt = `Given these dataset names and descriptions, identify 4-8 top-level categories that group them semantically.\nReturn JSON: [{ "name": string, "description": string }]\n\nDatasets:\n${datasets
      .map((d) => `- ${d.name}: ${d.description ?? ''}`)
      .join('\n')}`;

    try {
      const llm = getChatModel(0.2);
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const text =
        typeof response.content === 'string'
          ? response.content
          : String(response.content);
      const parsed = extractJsonFromText(text);
      const schema = z
        .array(
          z.object({
            name: z.string().min(1),
            description: z.string().optional().default(''),
          }),
        )
        .min(1);
      return schema.parse(parsed).slice(0, 8);
    } catch {
      return [{ name: 'General', description: 'General category' }];
    }
  }

  private async resolveDatasetConceptAssignments(
    datasets: OSIDataset[],
    conceptNames: string[],
  ): Promise<Map<string, string>> {
    const assignments = new Map<string, string>();

    for (const d of datasets) {
      const aiCtx = this.getDatasetAiContext(d);
      const category = aiCtx['category'];
      if (typeof category === 'string' && category.trim()) {
        const trimmed = category.trim();
        if (conceptNames.includes(trimmed)) assignments.set(d.name, trimmed);
      }
    }

    const missing = datasets.filter((d) => !assignments.has(d.name));
    if (missing.length === 0) return assignments;

    const prompt = `You are categorizing datasets into existing categories.\n\nCategories:\n${conceptNames
      .map((c) => `- ${c}`)
      .join('\n')}\n\nDatasets:\n${missing
      .map((d) => `- ${d.name}: ${d.description ?? ''}`)
      .join(
        '\n',
      )}\n\nReturn JSON array: [{ "dataset": string, "category": string }] where category is one of the categories above. Return only JSON.`;

    try {
      const llm = getChatModel(0.2);
      const response = await llm.invoke([new HumanMessage(prompt)]);
      const text =
        typeof response.content === 'string'
          ? response.content
          : String(response.content);
      const parsed = extractJsonFromText(text);
      const schema = z.array(
        z.object({
          dataset: z.string().min(1),
          category: z.string().min(1),
        }),
      );
      const out = schema.parse(parsed);
      for (const a of out) {
        if (conceptNames.includes(a.category))
          assignments.set(a.dataset, a.category);
      }
    } catch {
      // ignore
    }

    // Final fallback
    const fallback = conceptNames[0] ?? 'General';
    for (const d of missing) {
      if (!assignments.has(d.name)) assignments.set(d.name, fallback);
    }
    return assignments;
  }

  private async createConceptNodes(
    session: Session,
    datasourceId: string,
    concepts: Array<{ name: string; description: string }>,
  ) {
    await session.executeWrite(async (tx: ManagedTransaction) => {
      for (const c of concepts) {
        await tx.run(
          `CREATE (:Concept { name: $name, ontologyId: $ontologyId, description: $description })`,
          {
            ontologyId: datasourceId,
            name: c.name,
            description: c.description ?? '',
          },
        );
      }
    });
  }

  private async createDatasetNodes(
    session: Session,
    datasourceId: string,
    datasets: OSIDataset[],
    datasetToConcept: Map<string, string>,
  ) {
    await session.executeWrite(async (tx: ManagedTransaction) => {
      for (const dataset of datasets) {
        const conceptName = datasetToConcept.get(dataset.name) ?? null;
        await tx.run(
          `CREATE (d:Dataset {
            id: $id,
            ontologyId: $ontologyId,
            name: $name,
            label: $label,
            source: $source,
            description: $description,
            fields: $fields,
            conceptName: $conceptName
          })`,
          {
            id: dataset.name,
            ontologyId: datasourceId,
            name: dataset.name,
            label: dataset.label ?? dataset.name,
            source: dataset.source,
            description: dataset.description ?? '',
            fields: JSON.stringify(dataset.fields ?? []),
            conceptName,
          },
        );

        if (conceptName) {
          await tx.run(
            `MATCH (c:Concept {name: $conceptName, ontologyId: $ontologyId})
             MATCH (d:Dataset {id: $datasetId, ontologyId: $ontologyId})
             CREATE (d)-[:IS_A {ontologyId: $ontologyId}]->(c)`,
            {
              ontologyId: datasourceId,
              conceptName,
              datasetId: dataset.name,
            },
          );
        }
      }
    });
  }

  private fieldRelationType(field: OSIField): string {
    const ctx = this.getFieldAiContext(field);
    if (ctx['is_primary_key'] === true) return 'HAS_IDENTIFIER';
    if (field.dimension?.is_time) return 'HAS_TIMESTAMP';
    const dataType = String(ctx['data_type'] ?? '').toLowerCase();
    if (
      [
        'int',
        'integer',
        'float',
        'decimal',
        'numeric',
        'double',
        'real',
        'bigint',
        'smallint',
      ].includes(dataType)
    ) {
      return 'HAS_MEASURE';
    }
    return 'HAS_DIMENSION';
  }

  private async createFieldNodes(
    session: Session,
    datasourceId: string,
    datasets: OSIDataset[],
  ) {
    await session.executeWrite(async (tx: ManagedTransaction) => {
      for (const dataset of datasets) {
        for (const field of dataset.fields ?? []) {
          const aiCtx = this.getFieldAiContext(field);
          const relType = this.fieldRelationType(field);

          await tx.run(
            `MATCH (d:Dataset {id: $datasetId, ontologyId: $ontologyId})
             CREATE (f:Field {
               name: $name,
               ontologyId: $ontologyId,
               datasetId: $datasetId,
               label: $label,
               description: $description,
               dataType: $dataType,
               isPrimaryKey: $isPrimaryKey,
               isTime: $isTime
             })
             CREATE (d)-[:${relType} {ontologyId: $ontologyId}]->(f)`,
            {
              datasetId: dataset.name,
              ontologyId: datasourceId,
              name: field.name,
              label: field.label ?? field.name,
              description: field.description ?? '',
              dataType: String(aiCtx['data_type'] ?? ''),
              isPrimaryKey: Boolean(aiCtx['is_primary_key'] ?? false),
              isTime: field.dimension?.is_time ?? false,
            },
          );
        }
      }
    });
  }

  private async createJoinEdges(
    session: Session,
    datasourceId: string,
    relationships: Array<{
      name: string;
      from: string;
      to: string;
      from_columns: string[];
      to_columns: string[];
    }>,
  ) {
    await session.executeWrite(async (tx: ManagedTransaction) => {
      for (const rel of relationships) {
        await tx.run(
          `MATCH (from:Dataset {id: $from, ontologyId: $ontologyId})
           MATCH (to:Dataset {id: $to, ontologyId: $ontologyId})
           CREATE (from)-[:RELATES_TO {
             name: $name,
             ontologyId: $ontologyId,
             fromColumns: $fromColumns,
             toColumns: $toColumns
           }]->(to)`,
          {
            from: rel.from,
            to: rel.to,
            ontologyId: datasourceId,
            name: rel.name,
            fromColumns: JSON.stringify(rel.from_columns),
            toColumns: JSON.stringify(rel.to_columns),
          },
        );
      }
    });
  }

  private sanitizeRelationType(rel: string): string {
    return rel
      .toUpperCase()
      .replace(/[^A-Z0-9_]/g, '_')
      .slice(0, 50);
  }

  private async extractSemanticEdgesFromJoinPairs(
    datasets: OSIDataset[],
    relationships: Array<{ from: string; to: string }>,
  ): Promise<
    Array<{
      from: string;
      to: string;
      relation: string;
      confidence: number;
      source: 'llm_extracted';
      validated: true;
      validationReason: string;
    }>
  > {
    const byName = new Map(datasets.map((d) => [d.name, d]));
    const llm = getChatModel(0.4);

    const out: Array<{
      from: string;
      to: string;
      relation: string;
      confidence: number;
      source: 'llm_extracted';
      validated: true;
      validationReason: string;
    }> = [];

    for (const rel of relationships) {
      const a = byName.get(rel.from);
      const b = byName.get(rel.to);
      if (!a || !b) continue;

      const prompt = `You are a semantic knowledge graph expert.\nGiven two datasets and their descriptions, extract the semantic relationship between them.\nReturn a single JSON object: { "relation": string, "confidence": number, "direction": "forward"|"backward" }\nThe relation must be a short verb phrase (e.g. "belongs_to", "contains", "influences", "produces").\n\nDataset A: ${a.name}\nDescription A: ${a.description ?? ''}\n\nDataset B: ${b.name}\nDescription B: ${b.description ?? ''}\n\nReturn only JSON.`;

      try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const text =
          typeof response.content === 'string'
            ? response.content
            : String(response.content);
        const parsed = extractJsonFromText(text);
        const schema = z.object({
          relation: z.string().min(1),
          confidence: z.number().min(0).max(1),
          direction: z.union([z.literal('forward'), z.literal('backward')]),
        });
        const r = schema.parse(parsed);
        const relationType = this.sanitizeRelationType(r.relation);
        out.push({
          from: r.direction === 'forward' ? a.name : b.name,
          to: r.direction === 'forward' ? b.name : a.name,
          relation: relationType,
          confidence: r.confidence,
          source: 'llm_extracted',
          validated: true,
          validationReason: 'pair_relation_extracted',
        });
      } catch {
        // ignore individual pair failures
      }
    }
    return out;
  }

  private async extractSemanticTriplesFromDescriptions(
    datasets: OSIDataset[],
  ): Promise<Array<{ subject: string; relation: string; object: string }>> {
    const llm = getChatModel(0.3);
    const datasetNames = datasets.map((d) => d.name);
    const out: Array<{ subject: string; relation: string; object: string }> =
      [];

    for (const dataset of datasets) {
      const text = dataset.description?.trim();
      if (!text) continue;
      const prompt = `You are a knowledge graph extraction expert.\nExtract semantic triples from the text below.\nEach triple must be: { subject, relation, object }\n- subject and object must be dataset names from this list: [${datasetNames.join(
        ', ',
      )}]\n- relation must be a short verb phrase\n- Only extract triples with high confidence\n\nText: ${text}\n\nReturn JSON array of triples. If none found, return []. Return only JSON.`;
      try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const raw =
          typeof response.content === 'string'
            ? response.content
            : String(response.content);
        const parsed = extractJsonFromText(raw);
        const schema = z.array(
          z.object({
            subject: z.string().min(1),
            relation: z.string().min(1),
            object: z.string().min(1),
          }),
        );
        const triples = schema.parse(parsed);
        for (const t of triples) {
          if (
            !datasetNames.includes(t.subject) ||
            !datasetNames.includes(t.object)
          )
            continue;
          out.push({
            subject: t.subject,
            relation: this.sanitizeRelationType(t.relation),
            object: t.object,
          });
        }
      } catch {
        // ignore
      }
    }
    return out;
  }

  private async validateTriples(
    datasets: OSIDataset[],
    triples: Array<{ subject: string; relation: string; object: string }>,
  ): Promise<
    Array<{
      subject: string;
      relation: string;
      object: string;
      confidence: number;
      validationReason: string;
    }>
  > {
    if (triples.length === 0) return [];
    const byName = new Map(datasets.map((d) => [d.name, d]));
    const llm = getChatModel(0.2);

    const out: Array<{
      subject: string;
      relation: string;
      object: string;
      confidence: number;
      validationReason: string;
    }> = [];

    // Batch validate to reduce calls
    const BATCH = 10;
    for (let i = 0; i < triples.length; i += BATCH) {
      const batch = triples.slice(i, i + BATCH);
      const prompt = `You are a domain knowledge validator.\nFor each triple, decide if it is factually correct and meaningful.\n\nReturn JSON array with one item per input triple in the same order:\n[{ "valid": boolean, "confidence": number, "reason": string }]\n\nTriples:\n${batch
        .map((t) => {
          const s = byName.get(t.subject)?.description ?? '';
          const o = byName.get(t.object)?.description ?? '';
          return `- Triple: (${t.subject}) -[${t.relation}]-> (${t.object})\n  Context: ${s} | ${o}`;
        })
        .join('\n')}\n\nReturn only JSON.`;

      try {
        const response = await llm.invoke([new HumanMessage(prompt)]);
        const raw =
          typeof response.content === 'string'
            ? response.content
            : String(response.content);
        const parsed = extractJsonFromText(raw);
        const schema = z.array(
          z.object({
            valid: z.boolean(),
            confidence: z.number().min(0).max(1),
            reason: z.string().optional().default(''),
          }),
        );
        const results = schema.parse(parsed);
        for (let j = 0; j < batch.length; j++) {
          const t = batch[j]!;
          const r = results[j];
          if (!r) continue;
          if (r.valid && r.confidence >= 0.75) {
            out.push({
              subject: t.subject,
              relation: t.relation,
              object: t.object,
              confidence: r.confidence,
              validationReason: r.reason ?? '',
            });
          }
        }
      } catch {
        // ignore batch failure
      }
    }
    return out;
  }

  private async writeSemanticEdges(
    session: Session,
    datasourceId: string,
    edges: Array<{
      from: string;
      to: string;
      relation: string;
      confidence: number;
      source: string;
      validated: boolean;
      validationReason: string;
    }>,
  ) {
    if (edges.length === 0) return;
    await session.executeWrite(async (tx: ManagedTransaction) => {
      for (const e of edges) {
        const relType = this.sanitizeRelationType(e.relation);
        const cypher = `MATCH (a:Dataset {id: $fromId, ontologyId: $ontologyId})\nMATCH (b:Dataset {id: $toId, ontologyId: $ontologyId})\nCREATE (a)-[:${relType} { ontologyId: $ontologyId, confidence: $confidence, source: $source, validated: $validated, validationReason: $reason }]->(b)`;
        await tx.run(cypher, {
          ontologyId: datasourceId,
          fromId: e.from,
          toId: e.to,
          confidence: e.confidence,
          source: e.source,
          validated: e.validated,
          reason: e.validationReason,
        });
      }
    });
  }

  private buildExtractedRelationsIndex(
    edges: Array<{ from: string; relation: string }>,
  ): Map<string, string[]> {
    const map = new Map<string, Set<string>>();
    for (const e of edges) {
      const set = map.get(e.from) ?? new Set<string>();
      set.add(e.relation);
      map.set(e.from, set);
    }
    return new Map([...map.entries()].map(([k, v]) => [k, [...v]]));
  }

  private async generateAndStoreEmbeddings(
    session: Session,
    datasourceId: string,
    datasets: OSIDataset[],
    datasetToConcept: Map<string, string>,
    semanticEdges: Array<{ from: string; relation: string }>,
  ): Promise<Map<string, number[]>> {
    const extractedRelations = this.buildExtractedRelationsIndex(semanticEdges);
    const cache = new Map<string, number[]>();

    for (const dataset of datasets) {
      const conceptName = datasetToConcept.get(dataset.name);
      const relations = extractedRelations.get(dataset.name) ?? [];
      const text = datasetEmbeddingText(dataset, {
        conceptName,
        extractedRelations: relations,
      });
      const embedding = await generateEmbedding(text);
      cache.set(dataset.name, embedding);

      await session.run(
        `MATCH (d:Dataset {id: $id, ontologyId: $ontologyId})
         CALL db.create.setNodeVectorProperty(d, 'embedding', $embedding)`,
        { id: dataset.name, ontologyId: datasourceId, embedding },
      );
    }
    return cache;
  }

  private async deduplicateSynonyms(
    session: Session,
    datasourceId: string,
    datasets: OSIDataset[],
    embeddingCache: Map<string, number[]>,
  ) {
    const THRESHOLD = 0.92;
    const K = 10;
    const seenPairs = new Set<string>();

    // Prefer apoc merge when available; otherwise skip silently
    for (const dataset of datasets) {
      const embedding = embeddingCache.get(dataset.name);
      if (!embedding) continue;

      let neighbors: Array<{ id: string; score: number; name: string }> = [];
      try {
        const res = await session.run(
          `CALL db.index.vector.queryNodes('dataset_embedding', $k, $embedding)\nYIELD node, score\nWHERE node.ontologyId = $ontologyId\nRETURN node.id AS id, node.name AS name, score\nLIMIT $k`,
          { ontologyId: datasourceId, k: K, embedding },
        );
        neighbors = res.records.map((r: Neo4jRecord) => ({
          id: r.get('id'),
          name: r.get('name'),
          score: r.get('score'),
        }));
      } catch {
        return;
      }

      for (const n of neighbors) {
        if (n.id === dataset.name) continue;
        if (n.score < THRESHOLD) continue;
        const a = dataset.name;
        const b = n.id;
        const key = [a, b].sort().join('::');
        if (seenPairs.has(key)) continue;
        seenPairs.add(key);

        // choose survivor by degree then description length
        try {
          const stats = await session.run(
            `MATCH (a:Dataset {id: $a, ontologyId: $ontologyId})\nMATCH (b:Dataset {id: $b, ontologyId: $ontologyId})\nRETURN size((a)--()) AS aDeg, size((b)--()) AS bDeg, size(a.description) AS aDesc, size(b.description) AS bDesc, a.name AS aName, b.name AS bName`,
            { ontologyId: datasourceId, a, b },
          );
          const row = stats.records[0];
          if (!row) continue;
          const aDeg = Number(row.get('aDeg'));
          const bDeg = Number(row.get('bDeg'));
          const aDesc = Number(row.get('aDesc'));
          const bDesc = Number(row.get('bDesc'));

          const survivorId =
            aDeg > bDeg ? a : bDeg > aDeg ? b : aDesc >= bDesc ? a : b;
          const duplicateId = survivorId === a ? b : a;

          await session.executeWrite(async (tx: ManagedTransaction) => {
            await tx.run(
              `MATCH (s:Dataset {id: $survivorId, ontologyId: $ontologyId})\nMATCH (d:Dataset {id: $duplicateId, ontologyId: $ontologyId})\nSET s.synonyms = apoc.coll.toSet(coalesce(s.synonyms, []) + [d.name])\nCALL apoc.refactor.mergeNodes([s, d], {properties: 'discard', mergeRels: true})\nYIELD node\nRETURN node`,
              { ontologyId: datasourceId, survivorId, duplicateId },
            );
          });
        } catch {
          // apoc not installed or merge failed; skip
        }
      }
    }
  }

  async listDatasets(datasourceId: string): Promise<DatasetResult[]> {
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (d:Dataset {ontologyId: $ontologyId})
         RETURN d.name AS name, d.label AS label, d.source AS source, d.description AS description`,
        { ontologyId: datasourceId },
      );
      return result.records.map((r) => ({
        name: r.get('name'),
        label: r.get('label'),
        source: r.get('source'),
        description: r.get('description'),
      }));
    } finally {
      await session.close();
    }
  }

  async getDatasetDetails(
    datasourceId: string,
    datasetNames: string[],
  ): Promise<(DatasetResult & { fields: string })[]> {
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (d:Dataset {ontologyId: $ontologyId})
         WHERE d.name IN $names
         RETURN d.name AS name, d.label AS label, d.source AS source,
                d.description AS description, d.fields AS fields`,
        { ontologyId: datasourceId, names: datasetNames },
      );
      return result.records.map((r) => ({
        name: r.get('name'),
        label: r.get('label'),
        source: r.get('source'),
        description: r.get('description'),
        fields: r.get('fields'),
      }));
    } finally {
      await session.close();
    }
  }

  async getRelationships(datasourceId: string): Promise<
    Array<{
      fromDataset: string;
      toDataset: string;
      name: string;
      fromColumns: string[];
      toColumns: string[];
    }>
  > {
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      const result = await session.run(
        `MATCH (from:Dataset {ontologyId: $ontologyId})-[r:RELATES_TO]->(to:Dataset)
         RETURN from.name AS fromDataset, to.name AS toDataset,
                r.name AS name, r.fromColumns AS fromColumns, r.toColumns AS toColumns`,
        { ontologyId: datasourceId },
      );
      return result.records.map((r) => ({
        fromDataset: r.get('fromDataset'),
        toDataset: r.get('toDataset'),
        name: r.get('name'),
        fromColumns: JSON.parse(r.get('fromColumns')),
        toColumns: JSON.parse(r.get('toColumns')),
      }));
    } finally {
      await session.close();
    }
  }

  async searchSimilar(
    datasourceId: string,
    query: string,
    topK = 5,
  ): Promise<DatasetSearchResult[]> {
    const embedding = await generateEmbedding(query);
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      const limit = Math.floor(topK) * 8;
      const top = Math.floor(topK);
      const result = await session.run(
        `CALL db.index.vector.queryNodes('dataset_embedding', ${limit}, $embedding)
         YIELD node, score
         WHERE node.ontologyId = $ontologyId
         RETURN node.name AS name, node.label AS label, node.source AS source,
                node.description AS description, node.fields AS fields, score
         LIMIT ${top}`,
        { ontologyId: datasourceId, embedding },
      );
      return result.records.map((r) => ({
        name: r.get('name'),
        label: r.get('label'),
        source: r.get('source'),
        description: r.get('description'),
        fields: r.get('fields'),
        score: r.get('score'),
      }));
    } finally {
      await session.close();
    }
  }

  async deleteGraph(datasourceId: string): Promise<void> {
    const driver = getNeo4jDriver();
    const session = driver.session();
    try {
      await session.run('MATCH (n {ontologyId: $ontologyId}) DETACH DELETE n', {
        ontologyId: datasourceId,
      });
    } finally {
      await session.close();
    }
  }
}

export const neoOntologyService = new NeoOntologyService();
