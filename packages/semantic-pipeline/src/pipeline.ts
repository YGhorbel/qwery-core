/**
 * Main pipeline orchestrator — runs agents 01–08 in order for a single datasource.
 * Called once on datasource connect, or when schema changes are detected.
 */
import type { Datasource } from '@qwery/domain/entities';
import { getLogger } from '@qwery/shared/logger';
import { scanSchema } from './agents/01-schema-scanner.js';
import { runLabeler } from './agents/02-labeler.js';
import { runRelationshipMapper } from './agents/03-relationship-mapper.js';
import { runMetricBuilder } from './agents/04-metric-builder.js';
import { runBusinessRulesInferencer } from './agents/05-business-rules.js';
import { runSemanticValidator } from './agents/06-semantic-validator.js';
import { runConceptClassifier } from './agents/07-concept-classifier.js';
import { runOntologyBuilder } from './agents/08-ontology-builder.js';
import { writeGlossarySkill, writeMetricsSkill } from './writers/skills-writer.js';
import { embedSemanticLayer } from './indexer/embed-semantic-layer.js';
import {
  writeLabelMap,
  writeSemanticLayer,
  writeOntology,
  writeValidationReport,
  readSchemaMetadata,
} from './storage.js';
import type { SemanticLayer } from './types.js';

export type PipelineOptions = {
  /** Skip LLM-heavy agents (02, 04, 05, 07) — useful for testing */
  skipLlm?: boolean;
  /** Skip validation queries (06) */
  skipValidation?: boolean;
  /** Custom slug for skills files (defaults to datasource.name) */
  skillsSlug?: string;
};

export async function run(
  datasource: Datasource,
  options: PipelineOptions = {},
): Promise<void> {
  const logger = await getLogger();
  const tag = `[SemanticPipeline:${datasource.name}]`;

  logger.info(`${tag} Starting pipeline for datasource ${datasource.id}`);
  const startedAt = Date.now();

  const slug =
    options.skillsSlug ??
    (datasource.slug || datasource.name || datasource.id)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-');

  // Agent 01 — scan and cache schema
  logger.info(`${tag} [01/08] Scanning schema`);
  const metadata = await scanSchema(datasource);
  logger.info(
    `${tag} [01/08] Done — ${metadata.tables?.length ?? 0} tables, ${metadata.columns?.length ?? 0} columns`,
  );

  if (options.skipLlm) {
    logger.info(`${tag} skipLlm=true — stopping after schema scan`);
    return;
  }

  // Agent 02 — label cryptic column names
  logger.info(`${tag} [02/08] Labeling columns`);
  const labelMap = await runLabeler(metadata);
  await writeLabelMap(datasource.id, labelMap);
  logger.info(`${tag} [02/08] Done — ${Object.keys(labelMap).length} labels produced`);

  // Agent 03 — detect relationships / join graph
  logger.info(`${tag} [03/08] Mapping relationships`);
  const joins = runRelationshipMapper(metadata);
  logger.info(`${tag} [03/08] Done — ${Object.keys(joins).length} joins detected`);

  // Agent 04 — infer measures and dimensions
  logger.info(`${tag} [04/08] Building metrics`);
  const { measures, dimensions } = await runMetricBuilder(metadata, labelMap);
  logger.info(
    `${tag} [04/08] Done — ${Object.keys(measures).length} measures, ${Object.keys(dimensions).length} dimensions`,
  );

  // Agent 05 — detect business rules (soft-delete, status filters, PII)
  logger.info(`${tag} [05/08] Inferring business rules`);
  const business_rules = await runBusinessRulesInferencer(metadata);
  logger.info(`${tag} [05/08] Done — ${Object.keys(business_rules).length} rules`);

  const semanticLayer: SemanticLayer = {
    measures,
    dimensions,
    business_rules,
    joins,
  };

  await writeSemanticLayer(datasource.id, semanticLayer);

  // Agent 06 — validate measures against the real database
  if (!options.skipValidation) {
    logger.info(`${tag} [06/08] Validating measures`);
    const validationResults = await runSemanticValidator(datasource, semanticLayer);
    await writeValidationReport(datasource.id, validationResults);

    const failed = validationResults.filter((r) => r.status === 'fail');
    const warned = validationResults.filter((r) => r.status === 'warn');
    logger.info(
      `${tag} [06/08] Done — ${validationResults.length - failed.length - warned.length} ok, ${warned.length} warn, ${failed.length} fail (removed)`,
    );

    for (const result of failed) {
      if (result.fieldId in semanticLayer.measures) {
        delete semanticLayer.measures[result.fieldId];
      }
    }
    await writeSemanticLayer(datasource.id, semanticLayer);
  }

  // Agent 07 — classify tables into concept classes
  logger.info(`${tag} [07/08] Classifying concepts`);
  const concepts = await runConceptClassifier(metadata);
  logger.info(`${tag} [07/08] Done — ${Object.keys(concepts).length} concepts`);

  // Agent 08 — build ontology graph
  logger.info(`${tag} [08/08] Building ontology`);
  const ontology = runOntologyBuilder(concepts, joins);
  await writeOntology(datasource.id, ontology);
  logger.info(
    `${tag} [08/08] Done — ${ontology.relationships?.length ?? 0} relationships`,
  );

  // Write human-readable skills files for GetSkillTool
  await writeGlossarySkill(slug, labelMap);
  await writeMetricsSkill(slug, semanticLayer);

  // Index embeddings into pgvector for semantic search
  const internalDbUrl = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (internalDbUrl) {
    logger.info(`${tag} [embed] Indexing semantic layer into vector store`);
    try {
      const { VectorStore, Embedder } = await import('@qwery/vector-store');
      const vectorStore = new VectorStore(internalDbUrl);
      const embedder = new Embedder();
      await embedSemanticLayer(datasource.id, semanticLayer, vectorStore, embedder);
      await vectorStore.end();
      const fieldCount =
        Object.keys(semanticLayer.measures ?? {}).length +
        Object.keys(semanticLayer.dimensions ?? {}).length +
        Object.keys(semanticLayer.business_rules ?? {}).length;
      logger.info(`${tag} [embed] Done — ${fieldCount} fields indexed`);
    } catch (err) {
      logger.warn({ err }, `${tag} [embed] Embedding failed — semantic search will be unavailable`);
    }
  } else {
    logger.info(`${tag} [embed] QWERY_INTERNAL_DATABASE_URL not set — skipping vector indexing`);
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  logger.info(`${tag} Pipeline complete in ${elapsed}s`);
}

/**
 * Checks whether the live schema differs from the cached schema.json.
 * Returns true if tables or columns have changed.
 */
export async function detectSchemaChanges(
  datasource: Datasource,
): Promise<boolean> {
  const cached = await readSchemaMetadata(datasource.id);
  if (!cached) return true;

  // Re-scan live schema without persisting
  const { scanSchema: scan } = await import('./agents/01-schema-scanner.js');
  const live = await scan({ ...datasource });

  const cachedTableNames = new Set((cached.tables ?? []).map((t) => t.name));
  const liveTableNames = new Set((live.tables ?? []).map((t) => t.name));

  if (cachedTableNames.size !== liveTableNames.size) return true;
  for (const name of liveTableNames) {
    if (!cachedTableNames.has(name)) return true;
  }

  const cachedColCount = (cached.columns ?? []).length;
  const liveColCount = (live.columns ?? []).length;
  if (cachedColCount !== liveColCount) return true;

  return false;
}
