import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DataAgentStateType } from '../../state';
import type { EmitFn, QuerySpec } from '../../types';
import { QuerySpecListSchema } from '../../types';
import { buildSqlBuilderPrompt } from '../prompts/sql-builder.prompt';
import { getDialectFromDriverId } from '../../utils';
import type { ChatModel } from '../../../llm';
import type { DataAgentTracer } from '../tracer';

export function createSqlBuilderNode(
  structuredLlm: ChatModel,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'sql_builder',
      description: 'Generating SQL queries',
    });

    const plan = state.plan!;
    const joinPlan = state.joinPlan ?? {
      relevantDatasets: [],
      joinPaths: [],
      notes: '',
    };
    const dialect = getDialectFromDriverId(state.driverId);

    const systemPrompt = buildSqlBuilderPrompt(
      plan,
      joinPlan,
      dialect,
      state.revisionDiagnosis,
    );

    const llmWithOutput = structuredLlm.withStructuredOutput(
      QuerySpecListSchema,
      {
        name: 'generate_queries',
        includeRaw: true,
      },
    );

    let querySpecs: QuerySpec[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    // Attempt 1: structured output
    try {
      const raw = await tracer.trace(
        'sql_builder',
        'query_generation',
        true,
        () =>
          llmWithOutput.invoke([
            new SystemMessage(systemPrompt),
            new HumanMessage(state.userQuestion),
          ]),
      );

      const parsed = raw as {
        parsed: { queries: QuerySpec[] };
        raw: {
          usage_metadata?: { input_tokens?: number; output_tokens?: number };
        };
      };
      querySpecs = parsed.parsed.queries ?? [];

      const usage = parsed.raw?.usage_metadata;
      promptTokens = usage?.input_tokens ?? 0;
      completionTokens = usage?.output_tokens ?? 0;
    } catch {
      // Attempt 2: plain text with explicit JSON instruction, parse manually
      try {
        const plainPrompt = `${systemPrompt}\n\nReturn ONLY a valid JSON object. No markdown fences, no explanation. Format:\n{"queries":[{"stepId":1,"description":"...","pilotSql":"...","fullSql":"...","expectedColumns":[],"notes":""}]}`;
        const response = await tracer.trace(
          'sql_builder',
          'query_generation',
          false,
          () =>
            structuredLlm.invoke([
              new SystemMessage(plainPrompt),
              new HumanMessage(state.userQuestion),
            ]),
        );
        const text =
          typeof response.content === 'string' ? response.content.trim() : '';
        const usage = (
          response as {
            usage_metadata?: { input_tokens?: number; output_tokens?: number };
          }
        ).usage_metadata;
        promptTokens = usage?.input_tokens ?? 0;
        completionTokens = usage?.output_tokens ?? 0;

        // Strip markdown fences if present
        const jsonText = text
          .replace(/^```(?:json)?\s*/i, '')
          .replace(/\s*```$/, '')
          .trim();
        const jsonStart = jsonText.indexOf('{');
        const jsonEnd = jsonText.lastIndexOf('}');
        if (jsonStart !== -1 && jsonEnd !== -1) {
          const result = QuerySpecListSchema.safeParse(
            JSON.parse(jsonText.slice(jsonStart, jsonEnd + 1)),
          );
          if (result.success) querySpecs = result.data.queries;
        }
      } catch {
        // intentionally empty — fall through to heuristic fallback
      }
    }

    // Attempt 3: heuristic fallback using navigator notes
    if (querySpecs.length === 0) {
      const firstDataset = joinPlan.relevantDatasets[0];
      if (firstDataset) {
        querySpecs = plan.steps.map((step) => ({
          stepId: step.id,
          description: step.description,
          pilotSql: `SELECT * FROM ${firstDataset.source} LIMIT 10`,
          fullSql: `SELECT * FROM ${firstDataset.source} LIMIT 100`,
          expectedColumns: [],
          notes: 'Heuristic fallback — structured SQL generation failed',
        }));
      }
    }

    emit({
      type: 'phase_artifact',
      phase: 'sql_builder',
      artifact: querySpecs,
    });
    emit({ type: 'phase_complete', phase: 'sql_builder' });

    return {
      querySpecs,
      currentPhase: 'sql_builder',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
    };
  };
}
