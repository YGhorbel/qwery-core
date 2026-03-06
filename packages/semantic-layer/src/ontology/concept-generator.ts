import { generateText, type LanguageModel } from 'ai';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Concept } from '../models/ontology.schema';
import type { Table } from '@qwery/domain/entities';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ConceptGenerationResult {
  conceptId: string;
  label: string;
  description: string;
  synonyms: string[];
}

const CONCEPT_GENERATION_PROMPT = `You are a semantic ontology expert. Analyze a database table schema and generate a semantic concept definition.

Given:
- Table name: {table_name}
- Columns: {columns}
- Foreign key relationships: {relationships}

Generate a concept definition with:
1. Concept ID: PascalCase identifier (e.g., "Customer", "OrderItem")
2. Label: Human-readable name (e.g., "Customer Entity", "Order Item")
3. Description: Business context description (1-2 sentences)
4. Synonyms: Array of alternative names (e.g., ["client", "buyer"] for Customer)

Return ONLY valid JSON in this format:
{
  "conceptId": "Customer",
  "label": "Customer Entity",
  "description": "A customer entity representing a business customer who places orders",
  "synonyms": ["client", "buyer", "account"]
}

Be semantic and business-focused, not technical. Consider the table name, column names, and relationships to infer business meaning.`;

export async function generateConceptFromTable(
  table: Table,
  languageModel: LanguageModel,
): Promise<ConceptGenerationResult> {
  const logger = await getLogger();

  logger.debug('[ConceptGenerator] Generating concept from table', {
    table: `${table.schema}.${table.name}`,
    columnsCount: table.columns?.length || 0,
    relationshipsCount: table.relationships?.length || 0,
  });

  const columns = (table.columns || []).map((c) => ({
    name: c.name,
    type: c.data_type,
    nullable: c.is_nullable,
  }));

  const relationships = (table.relationships || []).map((r) => ({
    target_table: `${r.target_table_schema}.${r.target_table_name}`,
    source_column: r.source_column_name,
    target_column: r.target_column_name,
  }));

  const prompt = CONCEPT_GENERATION_PROMPT.replace('{table_name}', `${table.schema}.${table.name}`)
    .replace('{columns}', JSON.stringify(columns, null, 2))
    .replace('{relationships}', JSON.stringify(relationships, null, 2));

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.3,
    });

    const text = result.text.trim();
    let jsonText = text;

    // Remove markdown code blocks if present
    if (text.startsWith('```json')) {
      jsonText = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (text.startsWith('```')) {
      jsonText = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonText) as ConceptGenerationResult;

    logger.info('[ConceptGenerator] Concept generated', {
      table: `${table.schema}.${table.name}`,
      conceptId: parsed.conceptId,
      label: parsed.label,
      synonymsCount: parsed.synonyms.length,
    });

    return parsed;
  } catch (error) {
    logger.error('[ConceptGenerator] Error generating concept', {
      table: `${table.schema}.${table.name}`,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to rule-based generation
    return generateConceptFallback(table);
  }
}

function generateConceptFallback(table: Table): ConceptGenerationResult {
  const tableName = table.name;
  const conceptId = toPascalCase(tableName);
  const label = `${conceptId} Entity`;
  const description = `A ${conceptId.toLowerCase()} entity from table ${table.schema}.${table.name}`;
  const synonyms: string[] = [];

  // Add common synonyms based on table name patterns
  if (tableName.toLowerCase().includes('customer')) {
    synonyms.push('client', 'buyer');
  } else if (tableName.toLowerCase().includes('order')) {
    synonyms.push('purchase', 'transaction');
  } else if (tableName.toLowerCase().includes('product')) {
    synonyms.push('item', 'sku');
  }

  return {
    conceptId,
    label,
    description,
    synonyms,
  };
}

function toPascalCase(str: string): string {
  return str
    .split(/[_\s-]+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join('');
}
