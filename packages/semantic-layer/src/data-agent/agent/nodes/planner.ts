import type { DataAgentStateType } from '../../state';
import type { EmitFn, PlanArtifact } from '../../types';
import { PlanArtifactSchema } from '../../types';
import { buildPlannerPrompt } from '../prompts/planner.prompt';
import type { ChatModel } from '../../../llm';
import { extractJsonFromText } from '../../../llm';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DataAgentTracer } from '../tracer';

export function createPlannerNode(
  structuredLlm: ChatModel,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'planner',
      description: 'Analyzing question and creating execution plan',
    });

    const systemPrompt = buildPlannerPrompt(
      state.conversationContext,
      state.relevantDatasets,
      state.relevantDatasetDetails,
      state.clarificationRound,
    );

    const llmWithOutput = structuredLlm.withStructuredOutput(
      PlanArtifactSchema,
      {
        name: 'create_plan',
        includeRaw: true,
      },
    );

    let plan: PlanArtifact | undefined;
    let promptTokens = 0;
    let completionTokens = 0;

    // Attempt 1: structured output
    try {
      const raw = await tracer.trace('planner', 'plan_generation', true, () =>
        llmWithOutput.invoke([
          new SystemMessage(systemPrompt),
          new HumanMessage(state.userQuestion),
        ]),
      );

      const parsed = raw as {
        parsed: PlanArtifact;
        raw: {
          usage_metadata?: { input_tokens?: number; output_tokens?: number };
        };
      };
      plan = parsed.parsed;

      const usage = parsed.raw?.usage_metadata;
      promptTokens = usage?.input_tokens ?? 0;
      completionTokens = usage?.output_tokens ?? 0;
    } catch {
      // intentionally empty — fall through to attempt 2
    }

    // Attempt 2: plain text with manual JSON parse
    if (!plan) {
      try {
        const plainPrompt = `${systemPrompt}\n\nReturn ONLY a valid JSON object matching the plan schema. No markdown fences, no explanation.`;
        const response = await tracer.trace(
          'planner',
          'plan_generation',
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

        const jsonData = extractJsonFromText(text);
        const result = PlanArtifactSchema.safeParse(jsonData);
        if (result.success) plan = result.data;
      } catch {
        // intentionally empty — fall through to hardcoded fallback
      }
    }

    // Attempt 3: hardcoded fallback
    if (!plan) {
      plan = {
        complexity: 'simple',
        intent: state.userQuestion,
        metrics: [],
        dimensions: [],
        timeWindow: null,
        filters: [],
        grain: 'aggregate',
        ambiguities: [],
        acceptanceChecks: ['Results are non-empty'],
        shouldClarify: false,
        clarificationQuestions: [],
        confidenceLevel: 'low',
        steps:
          state.relevantDatasets.length > 0
            ? [
                {
                  id: 1,
                  description: state.userQuestion,
                  strategy: 'sql',
                  dependsOn: [],
                  datasets: state.relevantDatasets.slice(0, 2),
                  expectedOutput: 'query results',
                  chartType: null,
                },
              ]
            : [],
      };
    }

    // Backstop: if clarificationRound >= 3, force no clarification
    if (plan.shouldClarify && state.clarificationRound >= 3) {
      plan = {
        ...plan,
        shouldClarify: false,
        ambiguities: [
          ...plan.ambiguities,
          ...plan.clarificationQuestions.map((q) => ({
            question: q.question,
            assumption: q.assumption,
          })),
        ],
        clarificationQuestions: [],
      };
    }

    emit({ type: 'phase_artifact', phase: 'planner', artifact: plan });
    emit({ type: 'phase_complete', phase: 'planner' });

    return {
      plan,
      currentPhase: 'planner',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
    };
  };
}
