import type { BaseMessage } from '@langchain/core/messages';
import {
  HumanMessage,
  AIMessage,
  ToolMessage,
  SystemMessage,
} from '@langchain/core/messages';
import type { DataAgentStateType } from '../../state';
import type {
  EmitFn,
  JoinPlanArtifact,
  JoinEdge,
  DatasetDetail,
  CannotAnswerArtifact,
} from '../../types';
import { buildNavigatorPrompt } from '../prompts/navigator.prompt';
import { createListDatasetsTool } from '../tools/list-datasets';
import { createGetDatasetDetailsTool } from '../tools/get-dataset-details';
import { createGetRelationshipsTool } from '../tools/get-relationships';
import type { NeoOntologyService } from '../../../ontology/neo-ontology.service';
import { fieldsToYaml } from '../../utils';
import type { ChatModel } from '../../../llm';
import type { DataAgentTracer } from '../tracer';

const MAX_ITERATIONS = 8;

export function createNavigatorNode(
  llm: ChatModel,
  neoOntologyService: NeoOntologyService,
  datasourceId: string,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'navigator',
      description: 'Exploring ontology to build join map',
    });

    const plan = state.plan!;
    const tools = [
      createListDatasetsTool(neoOntologyService, datasourceId),
      createGetDatasetDetailsTool(neoOntologyService, datasourceId),
      createGetRelationshipsTool(neoOntologyService, datasourceId),
    ];
    const toolMap = Object.fromEntries(tools.map((t) => [t.name, t]));
    const boundLlm = llm.bindTools(tools);

    const systemPrompt = buildNavigatorPrompt(plan);
    const messages: BaseMessage[] = [
      new SystemMessage(systemPrompt),
      new HumanMessage(state.userQuestion),
    ];

    let promptTokens = 0;
    let completionTokens = 0;

    // ReAct loop
    for (let i = 0; i < MAX_ITERATIONS; i++) {
      const response = await tracer.trace(
        'navigator',
        `react_step_${i}`,
        false,
        () => boundLlm.invoke(messages),
      );

      const usage = (
        response as {
          usage_metadata?: { input_tokens?: number; output_tokens?: number };
        }
      ).usage_metadata;
      promptTokens += usage?.input_tokens ?? 0;
      completionTokens += usage?.output_tokens ?? 0;

      messages.push(response as AIMessage);

      const toolCalls = (response as AIMessage).tool_calls ?? [];
      if (toolCalls.length === 0) break;

      for (const tc of toolCalls) {
        emit({
          type: 'tool_start',
          phase: 'navigator',
          name: tc.name,
          args: tc.args as Record<string, unknown>,
        });
        try {
          const tool = toolMap[tc.name];
          const result = tool
            ? await (tool.invoke as (x: unknown) => Promise<unknown>)(tc.args)
            : `Unknown tool: ${tc.name}`;
          emit({
            type: 'tool_end',
            phase: 'navigator',
            name: tc.name,
            result: String(result).slice(0, 500),
          });
          messages.push(new ToolMessage(String(result), tc.id ?? ''));
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          emit({
            type: 'tool_error',
            phase: 'navigator',
            name: tc.name,
            error: errMsg,
          });
          messages.push(new ToolMessage(`Error: ${errMsg}`, tc.id ?? ''));
        }
      }
    }

    // Post-loop: fetch all datasets + relationships referenced in plan
    const planDatasets = new Set(plan.steps.flatMap((s) => s.datasets));
    const [rawDetails, allRelationships] = await Promise.all([
      planDatasets.size > 0
        ? neoOntologyService.getDatasetDetails(datasourceId, [...planDatasets])
        : Promise.resolve([]),
      neoOntologyService.getRelationships(datasourceId),
    ]);

    const relevantDatasets: DatasetDetail[] = rawDetails.map((d) => ({
      name: d.name,
      description: d.description,
      source: d.source,
      yaml: fieldsToYaml(d.name, d.source, d.fields),
    }));

    // Detect missing datasets
    const foundNames = new Set(rawDetails.map((d) => d.name));
    const missingDatasets = [...planDatasets].filter((n) => !foundNames.has(n));

    if (
      missingDatasets.length > 0 &&
      planDatasets.size > 0 &&
      relevantDatasets.length === 0
    ) {
      const cannotAnswer: CannotAnswerArtifact = {
        reason: `Required datasets not found in ontology: ${missingDatasets.join(', ')}`,
        suggestions: [
          'Run Stage 3 (ontology build) first',
          'Verify the datasource has been indexed',
        ],
      };
      emit({
        type: 'phase_artifact',
        phase: 'navigator',
        artifact: { cannotAnswer },
      });
      emit({ type: 'phase_complete', phase: 'navigator' });
      return {
        cannotAnswer,
        currentPhase: 'navigator',
        tokensUsed: {
          prompt: promptTokens,
          completion: completionTokens,
          total: promptTokens + completionTokens,
        },
        messages,
      };
    }

    // Build join paths for multi-dataset steps
    const joinPaths: JoinPlanArtifact['joinPaths'] = [];
    for (const step of plan.steps) {
      if (step.datasets.length < 2) continue;
      const edges: JoinEdge[] = allRelationships
        .filter(
          (r) =>
            step.datasets.includes(r.fromDataset) &&
            step.datasets.includes(r.toDataset),
        )
        .map((r) => ({
          fromDataset: r.fromDataset,
          toDataset: r.toDataset,
          fromColumns: r.fromColumns,
          toColumns: r.toColumns,
          relationshipName: r.name,
        }));
      joinPaths.push({ datasets: step.datasets, edges });
    }

    // Extract navigator's textual notes from last AI message
    const lastAI = [...messages].reverse().find((m) => m._getType() === 'ai');
    const notes = [
      typeof lastAI?.content === 'string' ? lastAI.content : '',
      missingDatasets.length > 0
        ? `\nWARNING: datasets not found: ${missingDatasets.join(', ')}`
        : '',
    ]
      .filter(Boolean)
      .join('');

    const joinPlan: JoinPlanArtifact = { relevantDatasets, joinPaths, notes };

    emit({ type: 'phase_artifact', phase: 'navigator', artifact: joinPlan });
    emit({ type: 'phase_complete', phase: 'navigator' });

    return {
      joinPlan,
      currentPhase: 'navigator',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
      messages,
    };
  };
}
