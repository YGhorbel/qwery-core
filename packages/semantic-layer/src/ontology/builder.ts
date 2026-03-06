import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology, Concept, Property, Relationship } from '../models/ontology.schema';
import type { DatasourceMetadata, Table, Column } from '@qwery/domain/entities';
import type { LanguageModel } from 'ai';
import { generateConceptFromTable } from './concept-generator';
import { generatePropertyFromColumn } from './property-generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface BuildOntologyOptions {
  useLLM?: boolean;
  languageModel?: LanguageModel;
  incremental?: boolean;
  existingOntology?: Ontology;
}

/**
 * Builds ontology directly from datasource metadata.
 * Uses hybrid approach: rule-based structure + LLM semantic enhancement.
 */
export async function buildOntologyFromDatasource(
  metadata: DatasourceMetadata,
  options: BuildOntologyOptions = {},
): Promise<Ontology> {
  const logger = await getLogger();
  const { useLLM = true, languageModel } = options;

  logger.info('[OntologyBuilder] Building ontology from datasource', {
    tablesCount: metadata.tables.length,
    columnsCount: metadata.columns.length,
    useLLM,
  });

  const concepts: Concept[] = [];
  const tableToConceptMap = new Map<string, string>(); // "schema.table" -> conceptId

  // Step 1: Build concepts from tables (rule-based structure)
  for (const table of metadata.tables) {
    const tableKey = `${table.schema}.${table.name}`;
    
    // Rule-based: Generate concept ID from table name
    const conceptId = toPascalCase(table.name);
    tableToConceptMap.set(tableKey, conceptId);

    // Get columns for this table
    const tableColumns = metadata.columns.filter(
      (c) => c.schema === table.schema && c.table === table.name,
    );

    // Build properties from columns
    const properties: Property[] = [];
    
    for (const column of tableColumns) {
      let property: Property;
      
      if (useLLM && languageModel) {
        try {
          const generated = await generatePropertyFromColumn(
            column,
            tableKey,
            languageModel,
          );
          property = {
            id: generated.propertyId,
            label: generated.label,
            type: generated.type,
            description: generated.description,
          };
        } catch (error) {
          logger.warn('[OntologyBuilder] LLM property generation failed, using fallback', {
            column: `${tableKey}.${column.name}`,
            error: error instanceof Error ? error.message : String(error),
          });
          property = buildPropertyFromColumn(column, tableKey);
        }
      } else {
        property = buildPropertyFromColumn(column, tableKey);
      }
      
      properties.push(property);
    }

    // Build concept
    let concept: Concept;
    
    if (useLLM && languageModel) {
      try {
        const generated = await generateConceptFromTable(table, languageModel);
        concept = {
          id: generated.conceptId,
          label: generated.label,
          description: generated.description,
          properties,
          relationships: [], // Will be populated in next step
        };
      } catch (error) {
        logger.warn('[OntologyBuilder] LLM concept generation failed, using fallback', {
          table: tableKey,
          error: error instanceof Error ? error.message : String(error),
        });
        concept = buildConceptFromTable(table, properties);
      }
    } else {
      concept = buildConceptFromTable(table, properties);
    }

    concepts.push(concept);
  }

  // Step 2: Build relationships from foreign keys
  for (const table of metadata.tables) {
    const tableKey = `${table.schema}.${table.name}`;
    const sourceConceptId = tableToConceptMap.get(tableKey);
    
    if (!sourceConceptId) {
      continue;
    }

    const sourceConcept = concepts.find((c) => c.id === sourceConceptId);
    if (!sourceConcept) {
      continue;
    }

    // Process relationships (foreign keys)
    for (const fk of table.relationships || []) {
      const targetTableKey = `${fk.target_table_schema}.${fk.target_table_name}`;
      const targetConceptId = tableToConceptMap.get(targetTableKey);
      
      if (!targetConceptId || sourceConceptId === targetConceptId) {
        continue;
      }

      // Check if relationship already exists
      const existingRel = sourceConcept.relationships?.find(
        (r) => r.target === targetConceptId,
      );
      
      if (existingRel) {
        continue;
      }

      // Infer relationship type
      const relationshipType = inferRelationshipType(table, fk, metadata);
      
      const relationship: Relationship = {
        target: targetConceptId,
        type: relationshipType,
        label: `${sourceConcept.label} → ${concepts.find((c) => c.id === targetConceptId)?.label || targetConceptId}`,
        description: `Relationship from ${tableKey} to ${targetTableKey} via ${fk.source_column_name}`,
      };

      if (!sourceConcept.relationships) {
        sourceConcept.relationships = [];
      }
      sourceConcept.relationships.push(relationship);
    }
  }

  logger.info('[OntologyBuilder] Ontology built successfully', {
    conceptsCount: concepts.length,
    totalProperties: concepts.reduce((sum, c) => sum + c.properties.length, 0),
    totalRelationships: concepts.reduce((sum, c) => sum + (c.relationships?.length || 0), 0),
  });

  return {
    ontology: {
      concepts,
      inheritance: [],
    },
  };
}

function buildConceptFromTable(table: Table, properties: Property[]): Concept {
  const conceptId = toPascalCase(table.name);
  const label = `${conceptId} Entity`;
  const description = `A ${conceptId.toLowerCase()} entity from table ${table.schema}.${table.name}`;

  return {
    id: conceptId,
    label,
    description,
    properties,
    relationships: [],
  };
}

function buildPropertyFromColumn(column: Column, tableKey: string): Property {
  const propertyId = toCamelCase(column.name);
  const label = toTitleCase(column.name);
  const semanticType = inferSemanticType(column.data_type);
  const description = `${label} from ${tableKey}`;

  return {
    id: propertyId,
    label,
    type: semanticType,
    description,
  };
}

function toPascalCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}

function toCamelCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((word, index) => {
      if (index === 0) {
        return word.toLowerCase();
      }
      return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
    })
    .join('');
}

function toTitleCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

function inferSemanticType(dataType: string): string {
  const lower = dataType.toLowerCase();
  
  if (lower.includes('int') || lower.includes('numeric') || lower.includes('decimal') || lower.includes('float') || lower.includes('double')) {
    return 'number';
  }
  if (lower.includes('date') && !lower.includes('time')) {
    return 'date';
  }
  if (lower.includes('timestamp') || lower.includes('datetime')) {
    return 'timestamp';
  }
  if (lower.includes('bool')) {
    return 'boolean';
  }
  if (lower.includes('json') || lower.includes('jsonb')) {
    return 'json';
  }
  
  return 'string';
}

function inferRelationshipType(
  sourceTable: Table,
  fk: { source_column_name: string; target_table_name: string; target_table_schema: string },
  metadata: DatasourceMetadata,
): 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' {
  const targetTable = metadata.tables.find(
    (t) => t.schema === fk.target_table_schema && t.name === fk.target_table_name,
  );

  if (!targetTable) {
    return 'belongs_to';
  }

  // Count relationships in both directions
  const sourceToTargetCount = sourceTable.relationships?.filter(
    (r) => r.target_table_name === fk.target_table_name && r.target_table_schema === fk.target_table_schema,
  ).length || 0;

  const targetToSourceCount = targetTable.relationships?.filter(
    (r) => r.target_table_name === sourceTable.name && r.target_table_schema === sourceTable.schema,
  ).length || 0;

  // Many-to-many: multiple relationships in both directions
  if (sourceToTargetCount > 1 && targetToSourceCount > 1) {
    return 'many_to_many';
  }

  // Has many: multiple relationships from source to target
  if (sourceToTargetCount > 1) {
    return 'has_many';
  }

  // Belongs to: multiple relationships from target to source
  if (targetToSourceCount > 1) {
    return 'belongs_to';
  }

  // Default: has_one
  return 'has_one';
}
