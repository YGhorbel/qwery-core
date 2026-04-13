import { type UIMessage, convertToModelMessages, validateUIMessages } from 'ai';
import { v4 as uuidv4 } from 'uuid';
import type { Repositories } from '@qwery/domain/repositories';
import { insertReminders } from './insert-reminders';
import { Registry } from '../tools/registry';
import type { AskRequest, ToolContext, ToolMetadataInput } from '../tools/tool';
import { LLM, type StreamInput } from '../llm/llm';
import type { Message, MessageContentPart } from '../llm/message';
import {
  messageRoleToUIRole,
  uiRoleToMessageRole,
} from '@qwery/shared/message-role-utils';
import { getDefaultModel } from '../services/model-resolver';
import {
  resolveModel,
  resolveAgent,
  loadAndFormatDatasources,
  persistUsageResult,
  persistMessageResult,
} from './agent-orchestration';
import { MessageRole } from '@qwery/domain/entities';

export type RunAgentToCompletionInput = {
  conversationId: string;
  conversationSlug: string;
  messages: UIMessage[];
  agentId: string;
  model?: string;
  repositories: Repositories;
  abortSignal: AbortSignal;
  maxSteps?: number;
  datasources?: string[];
  mcpServerUrl?: string;
  onAsk?: (req: AskRequest) => Promise<void>;
  onToolMetadata?: (input: ToolMetadataInput) => void | Promise<void>;
};

export type RunAgentToCompletionResult = {
  text: string;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
  };
  messages: UIMessage[];
};

export async function runAgentToCompletion(
  input: RunAgentToCompletionInput,
): Promise<RunAgentToCompletionResult> {
  const {
    conversationId,
    conversationSlug,
    messages,
    agentId,
    model: modelInput,
    repositories,
    abortSignal,
    maxSteps = 5,
    datasources,
    mcpServerUrl,
    onAsk,
    onToolMetadata,
  } = input;

  const agentInfo = resolveAgent(agentId);
  const { providerModel, modelForRegistry } = resolveModel(modelInput);
  const { reminderContext } = await loadAndFormatDatasources(
    datasources ?? [],
    repositories.datasource,
  );

  const assistantMessageId = uuidv4();
  const getContext = (options: {
    toolCallId?: string;
    abortSignal?: AbortSignal;
  }): ToolContext => ({
    conversationId,
    agentId,
    messageId: assistantMessageId,
    callId: options.toolCallId,
    abort: options.abortSignal ?? abortSignal,
    extra: {
      repositories,
      conversationId,
      metadataDatasources: datasources,
    },
    messages: [],
    ask: async (req: AskRequest) => {
      await onAsk?.(req);
    },
    metadata: async (meta: ToolMetadataInput) => {
      await onToolMetadata?.(meta);
    },
  });

  const { tools, close: closeMcp } = await Registry.tools.forAgent(
    agentId,
    modelForRegistry,
    getContext,
    { mcpServerUrl },
  );

  const now = new Date();
  const msgsAsMessages: Message[] = messages.map((m) => ({
    id: m.id,
    conversationId,
    content: { parts: m.parts },
    role: uiRoleToMessageRole(m.role),
    metadata: (m.metadata as Record<string, unknown>) ?? {},
    createdAt: now,
    updatedAt: now,
    createdBy: 'system',
    updatedBy: 'system',
  }));

  // Prefetch join relationships so the agent can plan JOINs before writing SQL.
  // This is especially useful now that the ontology has richer relationships,
  // but we still keep RELATES_TO as the join source of truth.
  if (
    (agentId === 'query' || agentId === 'ask') &&
    (datasources?.length ?? 0) > 0
  ) {
    try {
      const { ontologyService } = await import(
        '@qwery/semantic-layer/ontology'
      );
      const lastUser = msgsAsMessages.findLast(
        (m) => m.role === MessageRole.USER,
      );
      if (lastUser) {
        const parts = lastUser.content?.parts ?? [];
        const blocks: string[] = [];

        for (const datasourceId of datasources ?? []) {
          const rels = await ontologyService
            .getRelationships(datasourceId)
            .catch(() => []);
          if (rels.length === 0) continue;
          const shown = rels.slice(0, 50);
          const lines = shown.map(
            (r) =>
              `- ${r.fromDataset}.${r.fromColumns.join(', ')} → ${r.toDataset}.${r.toColumns.join(', ')} (${r.name})`,
          );
          blocks.push(
            `## Prefetched joins (${datasourceId})\n${lines.join('\n')}${rels.length > shown.length ? `\n… +${rels.length - shown.length} more` : ''}`,
          );
        }

        if (blocks.length > 0) {
          const reminderPart: MessageContentPart & {
            synthetic?: boolean;
          } = {
            type: 'text',
            text:
              `<system-reminder>\n` +
              `Join map (from ontology). Use this to plan JOINs before calling runQuery:\n\n` +
              `${blocks.join('\n\n')}\n` +
              `</system-reminder>`,
            synthetic: true,
          };
          parts.push(reminderPart);
          lastUser.content = { ...(lastUser.content ?? {}), parts };
        }
      }
    } catch {
      // ignore prefetch failures
    }
  }
  const msgsWithReminders = insertReminders({
    messages: msgsAsMessages,
    agent: agentInfo,
    context: reminderContext,
  });

  const validated = await validateUIMessages({
    messages: msgsWithReminders.map((m) => ({
      id: m.id,
      role: messageRoleToUIRole(m.role),
      parts: m.content?.parts ?? [],
    })),
  });

  const messagesForLlm =
    msgsWithReminders.length > 0
      ? (msgsWithReminders as StreamInput['messages'])
      : ((await convertToModelMessages(validated, {
          tools,
        })) as StreamInput['messages']);

  const result = await LLM.stream({
    model: providerModel,
    messages: messagesForLlm,
    tools,
    maxSteps,
    abortSignal,
    systemPrompt: agentInfo.systemPrompt,
    onFinish: closeMcp
      ? async () => {
          await closeMcp();
        }
      : undefined,
  });

  let finishedMessages: UIMessage[] = [];
  const response = result.toUIMessageStreamResponse({
    generateMessageId: () => uuidv4(),
    onFinish: ({ messages: completed }) => {
      finishedMessages = completed;
    },
  });

  if (response.body) {
    await response.body.pipeTo(new WritableStream({ write: () => {} }));
  }

  const text = await result.text;

  const usagePromise = result.usage;
  let usage: RunAgentToCompletionResult['usage'] = undefined;
  let rawUsage: import('ai').LanguageModelUsage | undefined = undefined;
  if (usagePromise) {
    try {
      const raw = (await usagePromise) as
        | {
            inputTokens?: number;
            outputTokens?: number;
            promptTokens?: number;
            completionTokens?: number;
          }
        | null
        | undefined;
      if (raw) {
        rawUsage = raw as import('ai').LanguageModelUsage;
        const inputTokens =
          'inputTokens' in raw
            ? (raw.inputTokens ?? 0)
            : 'promptTokens' in raw
              ? (raw.promptTokens ?? 0)
              : 0;
        const outputTokens =
          'outputTokens' in raw
            ? (raw.outputTokens ?? 0)
            : 'completionTokens' in raw
              ? (raw.completionTokens ?? 0)
              : 0;
        usage = {
          promptTokens: inputTokens,
          completionTokens: outputTokens,
          totalTokens: inputTokens + outputTokens,
        };
      }
    } catch {
      // ignore
    }
  }

  const modelString = modelInput ?? getDefaultModel();
  let userId = 'system';
  try {
    const conversation =
      (await repositories.conversation.findBySlug(conversationSlug)) ??
      (await repositories.conversation.findById(conversationId));
    if (conversation?.createdBy?.trim()) {
      userId = conversation.createdBy;
    }
  } catch {
    // keep default 'system'
  }

  await persistUsageResult({
    usage: rawUsage,
    model: modelString,
    userId,
    repositories,
    conversationSlug,
    label: 'RunAgentToCompletion',
  });

  await persistMessageResult({
    messages: finishedMessages,
    agentId,
    model: { modelID: providerModel.id, providerID: providerModel.providerID },
    repositories,
    conversationSlug,
    label: 'RunAgentToCompletion',
  });

  return {
    text,
    usage,
    messages: finishedMessages,
  };
}
