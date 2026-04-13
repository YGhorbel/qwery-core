import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DataAgentStateType } from '../../state';
import type { EmitFn, ExplainerOutput, DataLineage } from '../../types';
import {
  buildExplainerPrompt,
  buildConversationalPrompt,
} from '../prompts/explainer.prompt';
import type { ChatModel } from '../../../llm';
import type { DataAgentTracer } from '../tracer';

export function createExplainerNode(
  llm: ChatModel,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'explainer',
      description: 'Generating answer',
    });

    const plan = state.plan!;
    const joinPlan = state.joinPlan;

    // ── Cannot answer path ────────────────────────────────────────────────
    if (state.cannotAnswer) {
      const narrative = [
        `I'm unable to answer your question: ${state.cannotAnswer.reason}`,
        state.cannotAnswer.suggestions.length > 0
          ? `\n\nSuggestions:\n${state.cannotAnswer.suggestions.map((s) => `- ${s}`).join('\n')}`
          : '',
      ].join('');

      const output: ExplainerOutput = {
        narrative,
        charts: [],
        lineage: { datasetsUsed: [], joins: [] },
        caveats: [],
      };
      emit({ type: 'phase_artifact', phase: 'explainer', artifact: output });
      emit({ type: 'text', content: narrative });
      emit({ type: 'phase_complete', phase: 'explainer' });
      return { explainerOutput: output, currentPhase: 'explainer' };
    }

    // ── Conversational path ───────────────────────────────────────────────
    if (plan.complexity === 'conversational') {
      const conversationalPrompt = buildConversationalPrompt(
        state.userQuestion,
        plan,
        state.conversationContext,
        joinPlan?.relevantDatasets,
      );
      const response = await tracer.trace(
        'explainer',
        'conversational_answer',
        false,
        () =>
          llm.invoke([
            new SystemMessage(conversationalPrompt),
            new HumanMessage(state.userQuestion),
          ]),
      );
      const narrative =
        typeof response.content === 'string' ? response.content : '';
      const output: ExplainerOutput = {
        narrative,
        charts: [],
        lineage: { datasetsUsed: [], joins: [] },
        caveats: [],
      };
      emit({ type: 'phase_artifact', phase: 'explainer', artifact: output });
      emit({ type: 'text', content: narrative });
      emit({ type: 'phase_complete', phase: 'explainer' });
      return { explainerOutput: output, currentPhase: 'explainer' };
    }

    // ── Normal path ───────────────────────────────────────────────────────
    const stepResults = state.stepResults ?? [];
    const explainerPrompt = buildExplainerPrompt(
      state.userQuestion,
      plan,
      stepResults,
      state.verificationReport,
      state.conversationContext,
    );

    let narrative = '';
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      const response = await tracer.trace(
        'explainer',
        'narrative_generation',
        false,
        () =>
          llm.invoke([
            new SystemMessage(explainerPrompt),
            new HumanMessage(state.userQuestion),
          ]),
      );
      narrative = typeof response.content === 'string' ? response.content : '';
      const usage = (
        response as {
          usage_metadata?: { input_tokens?: number; output_tokens?: number };
        }
      ).usage_metadata;
      promptTokens = usage?.input_tokens ?? 0;
      completionTokens = usage?.output_tokens ?? 0;
    } catch {
      narrative = stepResults
        .map((r) => {
          if (r.sqlResult)
            return `Results for step ${r.stepId}:\n${r.sqlResult.data}`;
          if (r.pythonResult)
            return `Step ${r.stepId} output:\n${r.pythonResult.stdout}`;
          return `Step ${r.stepId}: no results`;
        })
        .join('\n\n');
    }

    // Collect charts
    const charts = stepResults.flatMap((r) => [
      ...(r.pythonResult?.charts ?? []),
      ...(r.chartSpec ? [`chart:${r.stepId}`] : []),
    ]);

    // Build lineage
    const datasetsUsed = [...new Set(plan.steps.flatMap((s) => s.datasets))];
    const joins: DataLineage['joins'] = (joinPlan?.joinPaths ?? []).flatMap(
      (p) =>
        p.edges.map((e) => ({
          from: e.fromDataset,
          to: e.toDataset,
          on: `${e.fromColumns.join(',')} = ${e.toColumns.join(',')}`,
        })),
    );

    // Caveats
    const caveats: string[] = [];
    if (state.verificationReport && !state.verificationReport.passed) {
      caveats.push(
        `Verification: ${state.verificationReport.diagnosis ?? 'results may be approximate'}`,
      );
    }
    for (const amb of plan.ambiguities) {
      caveats.push(`Assumption: ${amb.question} → ${amb.assumption}`);
    }

    const output: ExplainerOutput = {
      narrative,
      charts,
      lineage: { datasetsUsed, joins },
      caveats,
    };

    emit({ type: 'phase_artifact', phase: 'explainer', artifact: output });
    emit({ type: 'text', content: narrative });
    emit({ type: 'phase_complete', phase: 'explainer' });

    return {
      explainerOutput: output,
      currentPhase: 'explainer',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
    };
  };
}
