import { generateText } from 'ai';
import type { LanguageModel } from 'ai';
import type { Ontology } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { SemanticPlan } from './types';
import { SemanticPlanSchema } from './types';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ExtractIntentOptions {
  metadata?: DatasourceMetadata; // Optional metadata for schema-aware extraction
}

export async function extractSemanticIntent(
  query: string,
  ontology: Ontology,
  languageModel: LanguageModel,
  options: ExtractIntentOptions = {},
): Promise<SemanticPlan> {
  const logger = await getLogger();
  const { metadata } = options;

  logger.debug('[IntentExtractor] Extracting semantic intent', {
    queryLength: query.length,
    conceptsCount: ontology.ontology.concepts.length,
    hasMetadata: !!metadata,
  });

  const conceptsList = ontology.ontology.concepts
    .map((c) => `- ${c.id}: ${c.label}${c.description ? ` - ${c.description}` : ''}`)
    .join('\n');

  const relationshipsList = ontology.ontology.concepts
    .flatMap((c) =>
      c.relationships.map(
        (r) => `- ${c.id} --[${r.type}]--> ${r.target} (${r.label})`,
      ),
    )
    .join('\n');

  // Add schema information if available for better matching
  let schemaContext = '';
  if (metadata) {
    const tableNames = metadata.tables.map((t) => `${t.schema}.${t.name}`).slice(0, 20);
    const commonColumns = metadata.columns
      .filter((c) => ['id', 'name', 'created_at', 'updated_at'].includes(c.name))
      .map((c) => `${c.schema}.${c.table}.${c.name}`)
      .slice(0, 10);
    
    schemaContext = `\n\nAvailable Tables (for reference):\n${tableNames.join(', ')}\n\nCommon Columns: ${commonColumns.join(', ')}`;
  }

  const prompt = `You are a semantic query analyzer. Your task is to extract semantic intent from a natural language query and map it to ontology concepts.

Available Concepts:
${conceptsList}

Available Relationships:
${relationshipsList}${schemaContext}

User Query: "${query}"

Analyze the query and extract:
1. Which concepts are mentioned or implied (e.g., "Customer", "Order")
2. Which properties are referenced (e.g., "Customer.name", "Order.total")
3. What relationships are involved (e.g., Customer has_many Orders)
4. Any filters/conditions (property, operator, value)
5. Any aggregations (sum, avg, count, etc.)
6. Grouping requirements
7. Ordering requirements
8. Limit if specified

Return a JSON object with this structure:
{
  "concepts": ["Customer", "Order"],
  "properties": ["Customer.name", "Order.total"],
  "relationships": [{"from": "Customer", "to": "Order", "type": "has_many"}],
  "filters": [],
  "aggregations": [{"property": "Order.total", "function": "sum", "alias": "revenue"}],
  "groupBy": ["Customer"],
  "ordering": [{"property": "revenue", "direction": "DESC"}],
  "limit": 10
}

Only include concepts, properties, and relationships that are actually mentioned or clearly implied in the query. Be precise and avoid over-interpretation.

${metadata ? 'When mapping to concepts, prefer exact matches with table names from the schema when available.' : ''}`;

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.1,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in LLM response');
    }

    const parsed = JSON.parse(jsonMatch[0]);
    
    // Normalize null values to undefined for optional fields
    if (parsed && typeof parsed === 'object') {
      if ('limit' in parsed && parsed.limit === null) {
        parsed.limit = undefined;
      }
    }
    
    const semanticPlan = SemanticPlanSchema.parse(parsed);

    logger.debug('[IntentExtractor] Extracted semantic plan', {
      concepts: semanticPlan.concepts,
      properties: semanticPlan.properties,
      relationshipsCount: semanticPlan.relationships.length,
    });

    return semanticPlan;
  } catch (error) {
    logger.error('[IntentExtractor] Failed to extract intent', { error });
    throw new Error(
      `Failed to extract semantic intent: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
