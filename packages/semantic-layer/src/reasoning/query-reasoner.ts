import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import type { ReasoningChain } from './cot-reasoner';
import { reasonOverOntology } from './cot-reasoner';
import { compileSemanticQuery } from '../compiler/semantic-compiler';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface QueryReasoningResult {
  reasoning: ReasoningChain;
  validatedSQL: string;
  concepts: string[];
  tables: Array<{ schema: string; name: string }>;
  columns: Array<{ schema: string; table: string; name: string }>;
  confidence: number;
  semanticPlan: {
    concepts: string[];
    properties: string[];
    relationships: Array<{ from: string; to: string; type: string }>;
  };
}

/**
 * Reason over query and validate against schema.
 * Acts as reasoning layer that validates and translates queries.
 */
export async function reasonAndValidateQuery(
  query: string,
  datasourceId: string,
  metadata: DatasourceMetadata,
  ontology: Ontology,
  mappings: MappingResult,
  languageModel: LanguageModel,
  ontologyVersion: string = '1.0.0',
): Promise<QueryReasoningResult> {
  const logger = await getLogger();

  logger.info('[QueryReasoner] Starting query reasoning and validation', {
    queryLength: query.length,
    datasourceId,
    conceptsCount: ontology.ontology.concepts.length,
    tablesCount: metadata.tables.length,
  });

  // Step 1: Reason over ontology
  const reasoning = await reasonOverOntology(
    query,
    ontology,
    ontologyVersion,
    datasourceId,
    languageModel,
  );

  logger.info('[QueryReasoner] Reasoning complete', {
    stepsCount: reasoning.steps.length,
    finalPlanConcepts: reasoning.finalPlan.concepts,
  });

  // Step 2: Compile to SQL with validation using reasoning plan
  const compileResult = await compileSemanticQuery({
    query,
    datasourceId,
    ontologyVersion,
    metadata, // Required for validation
    languageModel,
    useGraphInference: true,
    semanticPlan: reasoning.finalPlan, // Use reasoning plan
  });

  const semanticPlan = compileResult.semanticPlan;

  const validatedSQL = compileResult.compiledQuery.sql;

  // Step 3: Extract tables and columns from validated SQL
  const tables = new Set<string>();
  const columns = new Set<string>();

  // Extract table references from mappings
  for (const mapping of compileResult.compiledQuery.table_mappings) {
    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    tables.add(tableKey);

    // Validate table exists
    const table = metadata.tables.find(
      (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
    );
    if (!table) {
      logger.warn('[QueryReasoner] Table from mapping not found in schema', {
        table: tableKey,
      });
      continue;
    }

    // Extract columns
    for (const colMapping of mapping.column_mappings) {
      const column = metadata.columns.find(
        (c) =>
          c.schema === mapping.table_schema &&
          c.table === mapping.table_name &&
          c.name === colMapping.column_name,
      );
      if (column) {
        columns.add(`${mapping.table_schema}.${mapping.table_name}.${colMapping.column_name}`);
      }
    }
  }

  // Step 4: Calculate confidence based on validation
  let confidence = 1.0;
  const totalMappings = compileResult.compiledQuery.table_mappings.length;
  let validatedMappings = 0;

  for (const mapping of compileResult.compiledQuery.table_mappings) {
    const table = metadata.tables.find(
      (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
    );
    if (table) {
      validatedMappings++;
    }
  }

  if (totalMappings > 0) {
    confidence = validatedMappings / totalMappings;
  }

  logger.info('[QueryReasoner] Query reasoning and validation complete', {
    validatedSQL: validatedSQL.substring(0, 200),
    conceptsCount: reasoning.finalPlan.concepts.length,
    tablesCount: Array.from(tables).length,
    columnsCount: Array.from(columns).length,
    confidence: confidence.toFixed(2),
  });

  return {
    reasoning,
    validatedSQL,
    concepts: reasoning.finalPlan.concepts,
    tables: Array.from(tables).map((t) => {
      const [schema, name] = t.split('.');
      return { schema: schema || 'public', name: name || t };
    }),
    columns: Array.from(columns).map((c) => {
      const parts = c.split('.');
      return {
        schema: parts[0] || 'public',
        table: parts[1] || '',
        name: parts[2] || c,
      };
    }),
    confidence,
    semanticPlan: {
      concepts: reasoning.finalPlan.concepts,
      properties: reasoning.finalPlan.properties,
      relationships: reasoning.finalPlan.relationships,
    },
  };
}
