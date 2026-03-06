import { generateText, type LanguageModel } from 'ai';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Property } from '../models/ontology.schema';
import type { Column } from '@qwery/domain/entities';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface PropertyGenerationResult {
  propertyId: string;
  label: string;
  type: string;
  description: string;
}

const PROPERTY_GENERATION_PROMPT = `You are a semantic ontology expert. Analyze a database column and generate a semantic property definition.

Given:
- Column name: {column_name}
- Data type: {data_type}
- Format: {format}
- Nullable: {is_nullable}
- Table context: {table_name}

Generate a property definition with:
1. Property ID: camelCase identifier (e.g., "emailAddress", "orderTotal")
2. Label: Human-readable name (e.g., "Email Address", "Order Total")
3. Type: Semantic type (string, number, date, timestamp, boolean, etc.)
4. Description: Business context description (1 sentence)

Return ONLY valid JSON in this format:
{
  "propertyId": "emailAddress",
  "label": "Email Address",
  "type": "string",
  "description": "Customer email address for communication"
}

Be semantic and business-focused. Infer business meaning from column name and type.`;

export async function generatePropertyFromColumn(
  column: Column,
  tableName: string,
  languageModel: LanguageModel,
): Promise<PropertyGenerationResult> {
  const logger = await getLogger();

  logger.debug('[PropertyGenerator] Generating property from column', {
    column: `${tableName}.${column.name}`,
    dataType: column.data_type,
  });

  const prompt = PROPERTY_GENERATION_PROMPT.replace('{column_name}', column.name)
    .replace('{data_type}', column.data_type)
    .replace('{format}', column.format || column.data_type)
    .replace('{is_nullable}', String(column.is_nullable))
    .replace('{table_name}', tableName);

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.2,
    });

    const text = result.text.trim();
    let jsonText = text;

    // Remove markdown code blocks if present
    if (text.startsWith('```json')) {
      jsonText = text.replace(/^```json\n?/, '').replace(/\n?```$/, '');
    } else if (text.startsWith('```')) {
      jsonText = text.replace(/^```\n?/, '').replace(/\n?```$/, '');
    }

    const parsed = JSON.parse(jsonText) as PropertyGenerationResult;

    logger.debug('[PropertyGenerator] Property generated', {
      column: `${tableName}.${column.name}`,
      propertyId: parsed.propertyId,
      type: parsed.type,
    });

    return parsed;
  } catch (error) {
    logger.error('[PropertyGenerator] Error generating property', {
      column: `${tableName}.${column.name}`,
      error: error instanceof Error ? error.message : String(error),
    });

    // Fallback to rule-based generation
    return generatePropertyFallback(column, tableName);
  }
}

function generatePropertyFallback(column: Column, tableName: string): PropertyGenerationResult {
  const columnName = column.name;
  const propertyId = toCamelCase(columnName);
  const label = toTitleCase(columnName);
  
  // Infer semantic type from data type
  const semanticType = inferSemanticType(column.data_type);
  
  const description = `${label} from ${tableName}`;

  return {
    propertyId,
    label,
    type: semanticType,
    description,
  };
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
