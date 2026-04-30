import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Tool } from './tool.js';
import { getLogger } from '@qwery/shared/logger';
import { buildQueryPlan } from '../planning/query-decomposer.js';
import { loadOntologyConcepts } from '../planning/intent-classifier.js';
import type { TribalStore } from '@qwery/vector-store';

const DESCRIPTION = [
  'Resolve natural language concepts to specific field definitions, SQL expressions, filters, and join paths.',
  'Call this BEFORE writing any SQL when a semantic layer is available for the datasource.',
  'Pass the user question VERBATIM as the "question" parameter — do NOT extract keywords yourself.',
  'Returns pre-validated field definitions — use the SQL expressions verbatim.',
  'If it returns { available: false }, write SQL directly using standard SQL patterns.',
].join(' ');

export type ResolvedField = {
  field_id: string;
  label: string;
  type: 'measure' | 'dimension' | 'business_rule' | 'workload_hint';
  table: string;
  sql: string;
  filters?: string[];
  format?: string;
  description: string;
  synonyms: string[];
  join_ref?: string;
  score: number;
  matchedKeyword: string;
  when_to_use?: string;
};

type OntologyShape = {
  concepts?: Record<string, { maps_to?: string }>;
  relationships?: Array<{
    from: string;
    to: string;
    join_ref: string;
  }>;
};

type SemanticFieldDef = {
  hidden?: boolean;
  table?: string;
  sql?: string;
  description?: string;
  when_to_use?: string;
};

type SemanticLayerShape = {
  measures?: Record<string, SemanticFieldDef>;
  dimensions?: Record<string, SemanticFieldDef>;
  business_rules?: Record<string, SemanticFieldDef>;
  joins?: Record<string, unknown>;
};

const STOP_WORDS = new Set([
  'what', 'was', 'our', 'their', 'the', 'a', 'an', 'is', 'are', 'were',
  'be', 'been', 'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would',
  'could', 'should', 'may', 'might', 'show', 'me', 'give', 'get', 'find',
  'tell', 'list', 'how', 'many', 'much', 'by', 'in', 'of', 'for', 'and',
  'or', 'with', 'to', 'from', 'at', 'on', 'about', 'between', 'across',
  'compare', 'top', 'bottom', 'all', 'each', 'per', 'total', 'count',
  'number', 'amount', 'value', 'data', 'report', 'chart', 'graph', 'table',
  // pronouns and conversational filler
  'you', 'your', 'we', 'they', 'them', 'him', 'her', 'his', 'its', 'who',
  'that', 'this', 'these', 'those', 'i', 'it', 'my', 'can', 'let', 'just',
  'please', 'okay', 'yes', 'no', 'not', 'any', 'some', 'more', 'less',
  'doing', 'going', 'looking', 'happened', 'happened', 'using', 'like',
]);

// Temporal patterns — date filters, not field names
const TEMPORAL_PATTERN =
  /\b(last|this|next|previous|current|yesterday|today|tomorrow|week|month|quarter|year|q1|q2|q3|q4|january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|oct|nov|dec|\d{4}|\d{1,2}\/\d{1,2})\b/gi;

export function extractKeywords(question: string): string[] {
  return question
    .toLowerCase()
    .replace(TEMPORAL_PATTERN, ' ')
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w))
    .slice(0, 6);
}

function resolveJoinIds(
  fields: ResolvedField[],
  ontology: OntologyShape,
): string[] {
  const tables = [...new Set(fields.map((f) => f.table))];
  if (tables.length <= 1) return [];

  const tableToConceptMap = new Map<string, string>();
  for (const [name, concept] of Object.entries(ontology.concepts ?? {})) {
    const tableName = concept.maps_to?.split('.').pop();
    if (tableName) tableToConceptMap.set(tableName, name);
  }

  const joinIds: string[] = [];
  for (const rel of ontology.relationships ?? []) {
    const fromTable = tableToConceptMap.get(rel.from)
      ? ontology.concepts?.[rel.from]?.maps_to?.split('.').pop()
      : rel.from;
    const toTable = tableToConceptMap.get(rel.to)
      ? ontology.concepts?.[rel.to]?.maps_to?.split('.').pop()
      : rel.to;
    if (
      fromTable &&
      toTable &&
      tables.includes(fromTable) &&
      tables.includes(toTable) &&
      rel.join_ref
    ) {
      joinIds.push(rel.join_ref);
    }
  }
  return joinIds;
}

function resolveAutoRules(
  fields: ResolvedField[],
  semanticLayer: SemanticLayerShape,
): string[] {
  const tables = [...new Set(fields.map((f) => f.table))];
  return Object.values(semanticLayer.business_rules ?? {})
    .filter((rule) => rule.hidden && rule.table && tables.includes(rule.table))
    .map((rule) => rule.sql ?? '')
    .filter(Boolean);
}

/**
 * Uses the ontology concept map to find tables that match entity words in the
 * question. Returns table names whose concept name or table name appears in the
 * keyword set — used to prefer fields from the right table when multiple fields
 * share a similar label (e.g. results.points vs driverStandings.points).
 */
async function deriveTableHints(
  keywords: string[],
  datasourceId: string,
): Promise<string[]> {
  const conceptMap = await loadOntologyConcepts(datasourceId);
  const hints: string[] = [];
  for (const [tableName] of conceptMap) {
    const tl = tableName.toLowerCase();
    if (keywords.some((k) => tl.includes(k) || k.includes(tl))) {
      hints.push(tableName);
    }
  }
  return hints;
}

/**
 * Reads description and when_to_use from the semantic layer YAML and patches
 * each ResolvedField. The vector index only stores description; when_to_use
 * is read here on demand so no re-indexing is required.
 */
function enrichFieldsFromSemanticLayer(
  fields: ResolvedField[],
  semanticLayer: SemanticLayerShape,
): ResolvedField[] {
  const allDefs: Record<string, SemanticFieldDef> = {
    ...(semanticLayer.measures ?? {}),
    ...(semanticLayer.dimensions ?? {}),
    ...(semanticLayer.business_rules ?? {}),
  };
  return fields.map((f) => {
    const def = allDefs[f.field_id];
    if (!def) return f;
    return {
      ...f,
      description: f.description || def.description || '',
      when_to_use: def.when_to_use,
    };
  });
}

function deduplicateByHighestScore(fields: ResolvedField[]): ResolvedField[] {
  const map = new Map<string, ResolvedField>();
  for (const field of fields) {
    const existing = map.get(field.field_id);
    if (!existing || field.score > existing.score) {
      map.set(field.field_id, field);
    }
  }
  return [...map.values()];
}

export const GetSemanticContextTool = Tool.define('getSemanticContext', {
  description: DESCRIPTION,
  parameters: z.object({
    question: z
      .string()
      .describe(
        'The user question exactly as typed. Do not rephrase, summarize, or extract keywords yourself. Pass the raw question verbatim.',
      ),
    datasourceId: z
      .string()
      .describe('The datasource ID to search against'),
  }),
  async execute({ question, datasourceId }, ctx) {
    const logger = await getLogger();
    const { attachedDatasources } = ctx.extra as {
      attachedDatasources: string[];
    };

    // Store the question so runQuery can use it for correction
    (ctx.extra as Record<string, unknown>).lastQuestion = question;

    // Extract keywords server-side — deterministic, unaffected by LLM provider
    const keywords = extractKeywords(question);
    (ctx.extra as Record<string, unknown>).lastKeywords = keywords;

    if (keywords.length === 0) {
      return {
        available: false,
        message: 'Could not extract searchable terms from the question. Write SQL directly using standard SQL patterns based on the datasource provider.',
      };
    }

    // Prefer UUID from context over LLM-supplied datasourceId (LLM may pass a name/slug)
    const targetDatasourceId = attachedDatasources[0] || datasourceId || '';
    const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
    const internalDbUrl = process.env.QWERY_INTERNAL_DATABASE_URL;
    const threshold = Number(process.env.QWERY_SEMANTIC_THRESHOLD ?? 0.7);

    const semanticLayerPath = path.join(
      storageDir,
      'datasources',
      targetDatasourceId,
      'semantic_layer.yaml',
    );
    const ontologyPath = path.join(
      storageDir,
      'datasources',
      targetDatasourceId,
      'ontology.json',
    );

    try {
      await fs.access(semanticLayerPath);
    } catch {
      logger.info(
        `[GetSemanticContextTool] No semantic layer for datasource ${targetDatasourceId} — no semantic context available`,
      );
      return {
        available: false,
        message: 'No semantic layer available for this datasource. Write SQL directly using standard SQL patterns. Do not call getSchema.',
      };
    }

    if (!internalDbUrl) {
      logger.info(
        '[GetSemanticContextTool] QWERY_INTERNAL_DATABASE_URL not set — no semantic context available',
      );
      return {
        available: false,
        message: 'Vector store not configured (QWERY_INTERNAL_DATABASE_URL missing). Write SQL directly using standard SQL patterns. Do not call getSchema.',
      };
    }

    try {
      const { VectorStore } = await import('@qwery/vector-store');
      const { Embedder } = await import('@qwery/vector-store');
      const yaml = await import('yaml');

      const embedder = new Embedder();
      const vectorStore = new VectorStore(internalDbUrl);

      const fullPhrase = keywords.join(' ');
      const allTerms = [...keywords, fullPhrase];

      // Parallelize all embedding + vector-search pairs (hybrid: cosine + BM25 via RRF)
      const parallelResults = await Promise.all(
        allTerms.map(async (term, i) => {
          const isFullPhrase = i === allTerms.length - 1;
          const t = isFullPhrase ? Math.max(threshold - 0.05, 0.5) : threshold;
          const embedding = await embedder.embedQuery(term);
          const hits = await vectorStore.hybridSearch(targetDatasourceId, embedding, [term], 3, t);
          return { term, hits, isFullPhrase };
        }),
      );

      await vectorStore.end();

      const perKeywordResults: ResolvedField[] = [];
      const fullResultsTagged: ResolvedField[] = [];
      const workloadHints: string[] = [];

      for (const { term, hits, isFullPhrase } of parallelResults) {
        // Separate workload hints from schema fields
        const fieldHits = hits.filter((h) => (h as { type?: string }).type !== 'workload_hint');
        const hintHits = hits.filter((h) => (h as { type?: string }).type === 'workload_hint');
        workloadHints.push(...hintHits.map((h) => (h as { description?: string }).description ?? ''));

        if (isFullPhrase) {
          fullResultsTagged.push(...fieldHits.map((r) => ({ ...r, matchedKeyword: term })));
        } else if (fieldHits[0]) {
          perKeywordResults.push({ ...fieldHits[0], matchedKeyword: term });
        }
      }

      // Merge per-keyword and full-question results, keep highest score per field
      const rawUniqueFields = deduplicateByHighestScore([
        ...perKeywordResults,
        ...fullResultsTagged,
      ]);

      // Re-rank: fields from ontology-matched tables come first.
      // This disambiguates fields with the same label across tables
      // (e.g. results.points vs driverStandings.points).
      const tableHints = await deriveTableHints(keywords, targetDatasourceId).catch((): string[] => []);
      const uniqueFields =
        tableHints.length > 0
          ? [
              ...rawUniqueFields.filter((f) => tableHints.includes(f.table)),
              ...rawUniqueFields.filter((f) => !tableHints.includes(f.table)),
            ]
          : rawUniqueFields;

      if (uniqueFields.length === 0) {
        logger.info(
          `[GetSemanticContextTool] No fields matched keywords [${keywords.join(', ')}] above threshold ${threshold} — no semantic context available`,
        );
        return {
          available: false,
          message: `No fields matched keywords [${keywords.join(', ')}] above threshold ${threshold}. Write SQL directly using standard SQL patterns. Do not call getSchema.`,
        };
      }

      logger.info(
        `[GetSemanticContextTool] Resolved ${uniqueFields.length} field(s) for question "${question}" → keywords [${keywords.join(', ')}] (scores: ${uniqueFields.map((f) => f.score.toFixed(2)).join(', ')})`,
      );

      // Load ontology for join resolution
      let neededJoins: unknown[] = [];
      try {
        const ontologyRaw = await fs.readFile(ontologyPath, 'utf-8');
        const ontology = JSON.parse(ontologyRaw) as OntologyShape;
        const joinIds = resolveJoinIds(uniqueFields, ontology);

        // Load semantic layer for join definitions and auto-rules
        const semanticLayerRaw = await fs.readFile(semanticLayerPath, 'utf-8');
        const semanticLayer = yaml.parse(semanticLayerRaw) as SemanticLayerShape;

        neededJoins = joinIds
          .map((id) => semanticLayer.joins?.[id])
          .filter(Boolean);

        // Store for runQuery correction loop
        (ctx.extra as Record<string, unknown>).lastSemanticLayer = semanticLayer;

        const autoRules = resolveAutoRules(uniqueFields, semanticLayer);

        // Enrich resolved fields with when_to_use and description from YAML
        const enrichedFields = enrichFieldsFromSemanticLayer(uniqueFields, semanticLayer);

        // Fetch tribal rules for tables referenced by resolved fields
        const uniqueTables = [...new Set(enrichedFields.map((f) => f.table))];
        const tribalStore = (ctx.extra as Record<string, unknown>).tribalStore as TribalStore | undefined;
        const tribalRules = tribalStore
          ? await tribalStore.getRulesForPlan(targetDatasourceId, uniqueTables).catch((): string[] => [])
          : [];
        logger.info(
          `[GetSemanticContextTool] tribal rules: ${tribalRules.length} injected for tables [${uniqueTables.join(', ')}]${tribalRules.length > 0 ? ' → ' + tribalRules.map((r) => `"${r.slice(0, 60)}"`).join(', ') : ''}`,
        );

        const deduplicatedHints = [...new Set(workloadHints)].filter(Boolean);
        if (deduplicatedHints.length > 0) {
          logger.info(`[GetSemanticContextTool] workload hints: ${deduplicatedHints.length} pattern(s) retrieved`);
        }

        // Build tableSchemas — exact column list per resolved table
        const tableSchemas: Record<string, string[]> = {};
        try {
          const schemaPath = path.join(storageDir, 'datasources', targetDatasourceId, 'schema.json');
          const schemaRaw = await fs.readFile(schemaPath, 'utf-8');
          const { metadata } = JSON.parse(schemaRaw) as {
            metadata: { columns: Array<{ table: string; name: string }> };
          };
          const resolvedTableNames = [...new Set(enrichedFields.map((f) => f.table))];
          for (const tbl of resolvedTableNames) {
            tableSchemas[tbl] = metadata.columns
              .filter((c) => c.table.toLowerCase() === tbl.toLowerCase())
              .map((c) => c.name);
          }
        } catch {
          // schema.json not available — omit tableSchemas
        }

        const queryPlan = await buildQueryPlan(question, enrichedFields, tribalRules, tableSchemas);
        (ctx.extra as Record<string, unknown>).lastQueryPlan = queryPlan;

        // Store for multi-path SQL runner
        (ctx.extra as Record<string, unknown>).lastResolvedFields = enrichedFields;
        (ctx.extra as Record<string, unknown>).lastResolvedJoins = neededJoins;
        (ctx.extra as Record<string, unknown>).lastBusinessRules = autoRules;

        const confidenceSignal = ctx.extra?.lastConfidenceSignal as
          | { shouldHedge?: boolean }
          | undefined;
        const hedgeInstruction = confidenceSignal?.shouldHedge
          ? '\n\n<system-reminder>confidenceHint: hedge</system-reminder>'
          : '';

        return {
          available: true,
          instruction: 'Use the sql expressions verbatim. For any filter values (like names, dates, statuses) use WHERE clauses directly in your SQL. Follow the cotPlan step by step.' + hedgeInstruction,
          fields: enrichedFields.map((f) => ({
            field_id: f.field_id,
            label: f.label,
            sql: f.sql,
            filters: f.filters ?? [],
            format: f.format,
            description: f.description,
            when_to_use: f.when_to_use,
            matchedKeyword: f.matchedKeyword,
            score: f.score,
          })),
          joins: neededJoins,
          businessRules: autoRules,
          queryPlan,
          tableSchemas,
          workloadHints: deduplicatedHints,
        };
      } catch {
        // Ontology not yet built — return fields without join resolution.
        // Still enrich from semantic layer (guaranteed to exist — checked above).
        let enrichedFallbackFields = uniqueFields;
        try {
          const yaml = await import('yaml');
          const semanticLayerRaw = await fs.readFile(semanticLayerPath, 'utf-8');
          const semanticLayer = yaml.parse(semanticLayerRaw) as SemanticLayerShape;
          enrichedFallbackFields = enrichFieldsFromSemanticLayer(uniqueFields, semanticLayer);
        } catch {
          /* best-effort — proceed without enrichment */
        }

        const fallbackUniqueTables = [...new Set(enrichedFallbackFields.map((f) => f.table))];
        const fallbackTribalStore = (ctx.extra as Record<string, unknown>).tribalStore as TribalStore | undefined;
        const fallbackTribalRules = fallbackTribalStore
          ? await fallbackTribalStore.getRulesForPlan(targetDatasourceId, fallbackUniqueTables).catch((): string[] => [])
          : [];

        const fallbackTableSchemas: Record<string, string[]> = {};
        try {
          const schemaPath = path.join(storageDir, 'datasources', targetDatasourceId, 'schema.json');
          const schemaRaw = await fs.readFile(schemaPath, 'utf-8');
          const { metadata } = JSON.parse(schemaRaw) as {
            metadata: { columns: Array<{ table: string; name: string }> };
          };
          for (const tbl of [...new Set(enrichedFallbackFields.map((f) => f.table))]) {
            fallbackTableSchemas[tbl] = metadata.columns
              .filter((c) => c.table.toLowerCase() === tbl.toLowerCase())
              .map((c) => c.name);
          }
        } catch { /* omit */ }

        const queryPlan = await buildQueryPlan(question, enrichedFallbackFields, fallbackTribalRules, fallbackTableSchemas);
        (ctx.extra as Record<string, unknown>).lastQueryPlan = queryPlan;

        // Store for multi-path SQL runner
        (ctx.extra as Record<string, unknown>).lastResolvedFields = enrichedFallbackFields;
        (ctx.extra as Record<string, unknown>).lastResolvedJoins = [];
        (ctx.extra as Record<string, unknown>).lastBusinessRules = [];

        return {
          available: true,
          instruction: 'Use the sql expressions verbatim. For any filter values (like names, dates, statuses) use WHERE clauses directly in your SQL. Follow the cotPlan step by step.',
          fields: enrichedFallbackFields.map((f) => ({
            field_id: f.field_id,
            label: f.label,
            sql: f.sql,
            filters: f.filters ?? [],
            format: f.format,
            description: f.description,
            when_to_use: f.when_to_use,
            matchedKeyword: f.matchedKeyword,
            score: f.score,
          })),
          joins: [],
          businessRules: [],
          queryPlan,
          tableSchemas: fallbackTableSchemas,
          workloadHints: [...new Set(workloadHints)].filter(Boolean),
        };
      }
    } catch (err) {
      logger.warn(
        { err },
        '[GetSemanticContextTool] Error during semantic search',
      );
      return {
        available: false,
        message: `Semantic context unavailable (${err instanceof Error ? err.message : String(err)}). Write SQL directly using standard SQL patterns. Do not call getSchema.`,
      };
    }
  },
});
