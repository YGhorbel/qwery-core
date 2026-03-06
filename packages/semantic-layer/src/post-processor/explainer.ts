import type { LanguageModel } from 'ai';
import type { SemanticPlan } from '../compiler/types';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { generateText } from 'ai';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
}

export interface Explanation {
  summary: string;
  insights: string[];
  relatedQueries: string[];
  validation: {
    matchesIntent: boolean;
    issues: string[];
  };
}

export async function explainQueryResult(
  query: string,
  semanticPlan: SemanticPlan,
  result: QueryResult,
  languageModel: LanguageModel,
): Promise<Explanation> {
  const logger = await getLogger();

  logger.debug('[PostProcessor] Generating explanation', {
    rowCount: result.rows.length,
    columnCount: result.columns.length,
  });

  const sampleRows = result.rows.slice(0, 5);
  const sampleData = sampleRows.map((row) => {
    const obj: Record<string, unknown> = {};
    result.columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });

  const prompt = `You are a data analysis assistant. Analyze the following semantic query result and provide insights.

Original Query: "${query}"

Semantic Plan:
- Concepts: ${semanticPlan.concepts.join(', ')}
- Properties: ${semanticPlan.properties.join(', ')}
- Aggregations: ${semanticPlan.aggregations.map((a) => `${a.function}(${a.property})`).join(', ')}
- Filters: ${semanticPlan.filters.length > 0 ? semanticPlan.filters.map((f) => `${f.property} ${f.operator} ${f.value}`).join(', ') : 'None'}
- Ordering: ${semanticPlan.ordering.map((o) => `${o.property} ${o.direction}`).join(', ')}
- Limit: ${semanticPlan.limit ?? 'None'}

Query Results:
- Columns: ${result.columns.join(', ')}
- Row Count: ${result.rows.length}
- Sample Data:
${JSON.stringify(sampleData, null, 2)}

Please provide:
1. A brief summary of what the results show (1-2 sentences)
2. Key insights from the data (2-3 bullet points)
3. 2-3 related queries the user might want to explore next
4. Validation: Does the result match the semantic intent? Are there any issues?

Respond in JSON format:
{
  "summary": "Brief summary of results",
  "insights": ["insight 1", "insight 2", "insight 3"],
  "relatedQueries": ["query 1", "query 2", "query 3"],
  "validation": {
    "matchesIntent": true/false,
    "issues": ["issue 1", "issue 2"] or []
  }
}`;

  try {
    const { text } = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.3,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.warn('[PostProcessor] Could not parse explanation JSON, using fallback');
      return createFallbackExplanation(result);
    }

    const parsed = JSON.parse(jsonMatch[0]) as Explanation;

    logger.debug('[PostProcessor] Explanation generated', {
      summaryLength: parsed.summary.length,
      insightsCount: parsed.insights.length,
    });

    return parsed;
  } catch (error) {
    logger.error('[PostProcessor] Error generating explanation', { error });
    return createFallbackExplanation(result);
  }
}

function createFallbackExplanation(result: QueryResult): Explanation {
  return {
    summary: `Query returned ${result.rows.length} rows with ${result.columns.length} columns: ${result.columns.join(', ')}.`,
    insights: [
      `Data contains ${result.rows.length} records`,
      `Columns available: ${result.columns.join(', ')}`,
    ],
    relatedQueries: [
      'Filter the results by specific criteria',
      'Aggregate the data by different dimensions',
    ],
    validation: {
      matchesIntent: true,
      issues: [],
    },
  };
}

export async function validateResultAgainstIntent(
  query: string,
  semanticPlan: SemanticPlan,
  result: QueryResult,
  languageModel: LanguageModel,
): Promise<{ matches: boolean; issues: string[] }> {
  const logger = await getLogger();

  if (result.rows.length === 0) {
    return {
      matches: false,
      issues: ['Query returned no results'],
    };
  }

  const prompt = `Validate if the query result matches the semantic intent.

Original Query: "${query}"

Semantic Plan:
- Concepts: ${semanticPlan.concepts.join(', ')}
- Properties: ${semanticPlan.properties.join(', ')}
- Expected columns: ${semanticPlan.properties.join(', ')}

Actual Result:
- Columns: ${result.columns.join(', ')}
- Row Count: ${result.rows.length}

Does the result match the intent? Are there any issues?

Respond in JSON:
{
  "matches": true/false,
  "issues": ["issue 1"] or []
}`;

  try {
    const { text } = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.1,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { matches: true, issues: [] };
    }

    const parsed = JSON.parse(jsonMatch[0]) as {
      matches: boolean;
      issues: string[];
    };

    logger.debug('[PostProcessor] Validation completed', {
      matches: parsed.matches,
      issuesCount: parsed.issues.length,
    });

    return parsed;
  } catch (error) {
    logger.error('[PostProcessor] Error validating result', { error });
    return { matches: true, issues: [] };
  }
}
