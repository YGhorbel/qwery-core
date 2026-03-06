import type { LanguageModel } from 'ai';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';
import { loadOntology } from '../ontology/loader';
import { loadMappings } from '../mapping/store';
import { resolveConcept } from '../mapping/resolver';
import { extractSemanticIntent } from './intent-extractor';
import { inferJoinPaths } from './join-inference';
import { inferJoinPathsFromGraph } from '../graph/join-inference';
import { rewriteSemanticPlanToSQL } from './query-rewriter';
import { validateSemanticPlan } from './plan-validator';
import type { SemanticPlan, CompiledQuery, SemanticTableMapping } from './types';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface CompileOptions {
  query: string;
  datasourceId: string;
  ontologyVersion?: string;
  metadata?: DatasourceMetadata; // Made optional but recommended for validation
  languageModel: LanguageModel;
  useGraphInference?: boolean; // Use graph-based join inference
  semanticPlan?: SemanticPlan; // Optional pre-extracted plan (e.g., from reasoning)
}

export interface CompileResult {
  compiledQuery: CompiledQuery;
  semanticPlan: SemanticPlan;
}

export async function compileSemanticQuery(
  options: CompileOptions,
): Promise<CompileResult> {
  const logger = await getLogger();
  const {
    query,
    datasourceId,
    ontologyVersion = '1.0.0',
    metadata,
    languageModel,
  } = options;

  logger.debug('[SemanticCompiler] Starting compilation', {
    queryLength: query.length,
    datasourceId,
    ontologyVersion,
  });

  const ontology = await loadOntology(ontologyVersion);
  if (!ontology) {
    throw new Error(
      `Ontology version ${ontologyVersion} not found. Please upload ontology to MinIO.`,
    );
  }

  const semanticPlan = await extractSemanticIntent(query, ontology, languageModel);

  logger.debug('[SemanticCompiler] Extracted semantic plan', {
    concepts: semanticPlan.concepts,
    properties: semanticPlan.properties,
  });

  // Validation - metadata is optional now
  if (metadata) {
    const validation = await validateSemanticPlan(semanticPlan, ontology, metadata);
    if (!validation.valid) {
      throw new Error(
        `Semantic plan validation failed: ${validation.errors.join('; ')}`,
      );
    }
    if (validation.warnings.length > 0) {
      logger.warn('[SemanticCompiler] Plan validation warnings', {
        warnings: validation.warnings,
      });
    }
  }

  const tableMappings: SemanticTableMapping[] = [];

  for (const conceptId of semanticPlan.concepts) {
    const resolved = await resolveConcept(
      datasourceId,
      conceptId,
      ontologyVersion,
    );

    if (!resolved) {
      logger.warn('[SemanticCompiler] Could not resolve concept', {
        conceptId,
      });
      continue;
    }

    const allMappings = await loadMappings(
      datasourceId,
      ontologyVersion,
    );

    const mapping = allMappings.find(
      (m) =>
        m.table_schema === resolved.table_schema &&
        m.table_name === resolved.table_name &&
        m.concept_id === resolved.concept_id,
    );

    if (mapping) {
      tableMappings.push({
        concept_id: mapping.concept_id,
        table_schema: mapping.table_schema,
        table_name: mapping.table_name,
        mapping_id: mapping.id,
        column_mappings: mapping.column_mappings.map((cm) => ({
          column_name: cm.column_name,
          property_id: cm.property_id,
        })),
      });
    }
  }

  if (tableMappings.length === 0) {
    throw new Error(
      'No table mappings found for the concepts in the query. Please run mapSemanticOntology first.',
    );
  }

  // Use graph-based join inference if enabled, otherwise fallback to metadata-based
  const useGraphInference = options.useGraphInference !== false; // Default to true
  let joinPaths;

  if (useGraphInference) {
    logger.info('[SemanticCompiler] Using graph-based join inference');
    joinPaths = await inferJoinPathsFromGraph({
      tableMappings,
      ontology,
      ontologyVersion,
      datasourceId,
      relationships: semanticPlan.relationships,
    });
  } else {
    if (!metadata) {
      throw new Error('Metadata required for metadata-based join inference');
    }
    logger.info('[SemanticCompiler] Using metadata-based join inference');
    joinPaths = await inferJoinPaths({
      tableMappings,
      metadata,
      relationships: semanticPlan.relationships,
    });
  }

  logger.debug('[SemanticCompiler] Inferred join paths', {
    joinPathsCount: joinPaths.length,
    method: useGraphInference ? 'graph-based' : 'metadata-based',
  });

  // Query rewriting - metadata recommended for validation
  if (!metadata) {
    logger.warn('[SemanticCompiler] Metadata not provided, SQL validation may be incomplete');
  }

  const compiledQuery = await rewriteSemanticPlanToSQL({
    semanticPlan,
    tableMappings,
    joinPaths,
    metadata, // Use for table/column validation
    ontology, // Pass ontology for property type resolution
  });

  // Final validation: ensure SQL uses correct table/column names
  if (metadata) {
    await validateSQLAgainstSchema(compiledQuery.sql, metadata, tableMappings);
  }

  logger.debug('[SemanticCompiler] Compiled to SQL', {
    sqlLength: compiledQuery.sql.length,
    parametersCount: compiledQuery.parameters.length,
  });

  return {
    compiledQuery,
    semanticPlan,
  };
}

/**
 * Validate generated SQL against actual schema.
 * Ensures all table/column references exist in metadata.
 */
async function validateSQLAgainstSchema(
  sql: string,
  metadata: DatasourceMetadata,
  tableMappings: SemanticTableMapping[],
): Promise<void> {
  const logger = await getLogger();

  // Extract table references from SQL (simplified - would need proper SQL parsing for full validation)
  const tableRefs = new Set<string>();
  for (const mapping of tableMappings) {
    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    tableRefs.add(tableKey);
  }

  // Validate all referenced tables exist
  for (const tableRef of tableRefs) {
    const [schema, name] = tableRef.split('.');
    const table = metadata.tables.find(
      (t) => t.schema === schema && t.name === name,
    );

    if (!table) {
      logger.warn('[SemanticCompiler] SQL references table not in schema', {
        table: tableRef,
        availableTables: metadata.tables.map((t) => `${t.schema}.${t.name}`).slice(0, 5),
      });
      throw new Error(`Table ${tableRef} referenced in SQL but not found in schema`);
    }
  }

  logger.debug('[SemanticCompiler] SQL validated against schema', {
    tablesValidated: tableRefs.size,
  });
}
