import { generateText, type LanguageModel } from 'ai';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface TableMapping {
  table_schema: string;
  table_name: string;
  concept_id: string;
  confidence: number;
  synonyms: string[];
}

export interface ColumnMapping {
  column_name: string;
  property_id: string;
  confidence: number;
}

export interface MappingResult {
  table_mappings: Array<TableMapping & { column_mappings: ColumnMapping[] }>;
}

const MAPPING_PROMPT = `You are a semantic mapping expert. Your task is to map database tables and columns to ontology concepts and properties.

Given:
1. A database schema (tables, columns, relationships)
2. An ontology with concepts, properties, and relationships

Generate mappings with:
- Table → Concept mappings (e.g., "customers" table → "Customer" concept)
- Column → Property mappings (e.g., "customers.name" → "Customer.name")
- Confidence scores (0.00 to 1.00) for each mapping
- Synonyms for concepts (e.g., "client", "buyer" → "Customer")

Return a JSON object with this structure:
{
  "table_mappings": [
    {
      "table_schema": "public",
      "table_name": "customers",
      "concept_id": "Customer",
      "confidence": 0.95,
      "synonyms": ["client", "buyer"],
      "column_mappings": [
        {
          "column_name": "name",
          "property_id": "Customer.name",
          "confidence": 0.98
        },
        {
          "column_name": "email",
          "property_id": "Customer.email",
          "confidence": 0.97
        }
      ]
    }
  ]
}

Be thorough and accurate. Consider:
- Table/column names and their semantic meaning
- Data types and their alignment with property types
- Relationships between tables (foreign keys)
- Business domain context`;

export async function generateMappings(
  schema: DatasourceMetadata,
  ontology: Ontology,
  languageModel: LanguageModel,
): Promise<MappingResult> {
  const logger = await getLogger();

  logger.info('[MappingGenerator] Starting mapping generation', {
    tablesCount: schema.tables.length,
    conceptsCount: ontology.ontology.concepts.length,
  });

  logger.debug('[MappingGenerator] Schema summary', {
    tables: schema.tables.map((t) => ({
      name: t.name,
      columnsCount: t.columns?.length || 0,
      relationshipsCount: t.relationships?.length || 0,
    })),
  });

  const schemaSummary = {
    tables: schema.tables.map((t) => ({
      schema: t.schema,
      name: t.name,
      columns: t.columns?.map((c) => ({
        name: c.name,
        data_type: c.data_type,
        format: c.format,
      })),
      relationships: t.relationships?.map((r) => ({
        source_table: `${r.source_schema}.${r.source_table_name}`,
        target_table: `${r.target_table_schema}.${r.target_table_name}`,
        source_column: r.source_column_name,
        target_column: r.target_column_name,
      })),
    })),
  };

  const ontologySummary = {
    concepts: ontology.ontology.concepts.map((c) => ({
      id: c.id,
      label: c.label,
      description: c.description,
      properties: c.properties.map((p) => ({
        id: p.id,
        label: p.label,
        type: p.type,
      })),
      relationships: c.relationships.map((r) => ({
        target: r.target,
        type: r.type,
        label: r.label,
      })),
    })),
  };

  const prompt = `${MAPPING_PROMPT}

Database Schema:
${JSON.stringify(schemaSummary, null, 2)}

Ontology:
${JSON.stringify(ontologySummary, null, 2)}

Generate the mappings now. Return ONLY valid JSON, no markdown or code blocks.`;

  try {
    const llmStart = performance.now();
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.3,
    });
    const llmTime = performance.now() - llmStart;

    logger.info('[MappingGenerator] LLM mapping generation complete', {
      durationMs: llmTime.toFixed(2),
      responseLength: result.text.length,
    });

    const text = result.text.trim();

    let jsonText = text;
    if (text.startsWith('```json')) {
      jsonText = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (text.startsWith('```')) {
      jsonText = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonText) as MappingResult;

    const totalColumnMappings = parsed.table_mappings.reduce(
      (sum, tm) => sum + tm.column_mappings.length,
      0,
    );
    const avgConfidence =
      parsed.table_mappings.length > 0
        ? parsed.table_mappings.reduce((sum, tm) => sum + tm.confidence, 0) /
          parsed.table_mappings.length
        : 0;

    logger.info('[MappingGenerator] Mappings generated', {
      tableMappingsCount: parsed.table_mappings.length,
      totalColumnMappings,
      avgConfidence: avgConfidence.toFixed(2),
    });

    for (const tm of parsed.table_mappings) {
      logger.debug('[MappingGenerator] Table mapping', {
        table: `${tm.table_schema}.${tm.table_name}`,
        concept: tm.concept_id,
        confidence: tm.confidence,
        synonyms: tm.synonyms,
        columnsMapped: tm.column_mappings.length,
      });
    }

    return parsed;
  } catch (error) {
    logger.error('[MappingGenerator] Error generating mappings', { error });
    throw new Error(
      `Failed to generate mappings: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
