import { type UIMessage, convertToModelMessages, validateUIMessages } from 'ai';
import { getDefaultModel } from '../services/model-resolver';
import { generateConversationTitle } from '../services/generate-conversation-title.service';
import { MessagePersistenceService } from '../services/message-persistence.service';
import { UsagePersistenceService } from '../services/usage-persistence.service';
import type { Repositories } from '@qwery/domain/repositories';
import type { TelemetryManager } from '@qwery/telemetry/otel';
import { MessageRole } from '@qwery/domain/entities';
import { createMessages, filterCompacted } from '../llm/message';
import type { Message, MessageContentPart } from '../llm/message';
import { SessionCompaction } from './session-compaction';
import { getLogger } from '@qwery/shared/logger';
import { Registry } from '../tools/registry';
import type { AskRequest, ToolContext, ToolMetadataInput } from '../tools/tool';
import { insertReminders } from './insert-reminders';
import { LLM } from '../llm/llm';
import { Provider } from '../llm/provider';
import { SystemPrompt } from '../llm/system';
import { v4 as uuidv4 } from 'uuid';
import { loadDatasources } from '../tools/datasource-loader';
import type { Datasource } from '@qwery/domain/entities';
import { buildDatasourceSystemContext } from '../context/datasource-prompt-builder.js';
import type { TraceStore, ErrorFixStore, TribalStore, TokenStore } from '@qwery/vector-store';

// Lazy singleton — created once per process when QWERY_INTERNAL_DATABASE_URL is set
let _traceStore: TraceStore | null = null;
async function getTraceStore(): Promise<TraceStore | null> {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (_traceStore) return _traceStore;
  const { TraceStore: TS } = await import('@qwery/vector-store');
  _traceStore = new TS(url);
  await _traceStore.ensureSchema().catch(() => null);
  return _traceStore;
}

let _errorFixStore: ErrorFixStore | null = null;
async function getErrorFixStore(): Promise<ErrorFixStore | null> {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (_errorFixStore) return _errorFixStore;
  const { ErrorFixStore: EFS } = await import('@qwery/vector-store');
  _errorFixStore = new EFS(url);
  await _errorFixStore.ensureSchema().then(
    () => console.info('[ErrorFixStore] ready — error_fix_pairs table ensured'),
    (err: unknown) => console.warn('[ErrorFixStore] schema init failed:', err),
  );
  return _errorFixStore;
}

let _tribalStore: TribalStore | null = null;
async function getTribalStore(): Promise<TribalStore | null> {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (_tribalStore) return _tribalStore;
  const { TribalStore: TS } = await import('@qwery/vector-store');
  _tribalStore = new TS(url);
  await _tribalStore.ensureSchema().then(
    () => console.info('[TribalStore] ready — tribal_rules table ensured'),
    (err: unknown) => console.warn('[TribalStore] schema init failed:', err),
  );
  return _tribalStore;
}

let _tokenStore: TokenStore | null = null;
async function getTokenStore(): Promise<TokenStore | null> {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (_tokenStore) return _tokenStore;
  const { TokenStore: TKS } = await import('@qwery/vector-store');
  _tokenStore = new TKS(url);
  await _tokenStore.ensureSchema().then(
    () => console.info('[TokenStore] ready — token_usage table ensured'),
    (err: unknown) => console.warn('[TokenStore] schema init failed:', err),
  );
  return _tokenStore;
}

// Post-query hook — set from server layer to avoid circular dep with semantic-pipeline
type PostQueryHook = (
  datasourceId: string,
  correctionTrace: Record<string, unknown>,
  fieldsUsed: Array<{ field_id: string; label: string; sql: string }>,
) => void;
let _postQueryHook: PostQueryHook | null = null;
export function setPostQueryHook(hook: PostQueryHook): void {
  _postQueryHook = hook;
}

// Enrichment agent interface — injected from server layer to avoid circular dep
type EnrichmentAgentLike = {
  analyse(input: {
    datasourceId: string;
    question: string;
    sqlFinal: string;
    fieldsUsed: Array<{ field_id: string; label: string; sql: string }>;
    queryPlan: { intent: string; cotPlan?: string; complexity: number };
    correctionTrace?: Record<string, unknown> | null;
  }): Promise<void>;
};
let _enrichmentAgent: EnrichmentAgentLike | null = null;
export function setEnrichmentAgent(agent: EnrichmentAgentLike): void {
  _enrichmentAgent = agent;
}
export function getEnrichmentAgent(): EnrichmentAgentLike | null {
  return _enrichmentAgent;
}

export type AgentSessionPromptInput = {
  conversationSlug: string;
  messages: UIMessage[];
  model?: string;
  datasources?: string[];
  webSearch?: boolean;
  repositories: Repositories;
  telemetry: TelemetryManager;
  generateTitle?: boolean;
  /** Agent to run (e.g. 'ask' or 'query'). Defaults to 'query'. */
  agentId?: string;
  /** Optional: called when a tool requests permission (e.g. webfetch). If not provided, ask is a no-op. */
  onAsk?: (req: AskRequest) => Promise<void>;
  onToolMetadata?: (input: {
    callId?: string;
    messageId?: string;
    title?: string;
    metadata?: Record<string, unknown>;
  }) => void | Promise<void>;
  maxSteps?: number;
  mcpServerUrl?: string;
  /**
   * When true: close the SSE stream immediately after the first runQuery /
   * runQueries tool result, aborting the narration LLM step.
   * Set by the chat route when the request carries X-Benchmark-Mode: true.
   */
  benchmarkMode?: boolean;
};

const DEFAULT_AGENT_ID = 'query';

const WEB_SEARCH_OFF_INSTRUCTION = `# Web search is disabled
Web search is turned off for this conversation. Do not offer to search the web, look up information online, or fetch URLs. Answer only using your knowledge and any attached datasources. If the user asks for real-time or external information you cannot provide without web search, state clearly that web search is disabled and they can turn it on in settings if needed.`;

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'x-vercel-ai-ui-message-stream': 'v1',
} as const;

function ensureTitle(_opts: {
  conversationSlug: string;
  conversationId: string;
  model: string;
  msgs: Message[];
  repositories: Repositories;
}): void {}

function deriveState(msgs: Message[]) {
  const lastUser = msgs.findLast((m) => m.role === MessageRole.USER);
  const compactionUser = msgs.findLast(
    (m) =>
      m.role === MessageRole.USER &&
      (m.content?.parts ?? []).some((p) => p.type === 'compaction'),
  );
  const lastAssistant = msgs.findLast((m) => m.role === MessageRole.ASSISTANT);
  const lastFinished = msgs.findLast(
    (m) =>
      m.role === MessageRole.ASSISTANT &&
      !!(m.metadata as { finish?: string })?.finish,
  );
  const tasks = msgs
    .flatMap((m) => m.content?.parts ?? [])
    .filter(
      (p): p is MessageContentPart =>
        p.type === 'compaction' || p.type === 'subtask',
    );
  return { lastUser, compactionUser, lastAssistant, lastFinished, tasks };
}

type ToolExecutionStat = {
  toolName: string;
  executionTimeMs: number;
  isError: boolean;
};

function withToolExecutionStats(
  messages: UIMessage[],
  toolExecutionByCallId: ReadonlyMap<string, ToolExecutionStat>,
): UIMessage[] {
  return messages.map((message) => {
    if (!Array.isArray(message.parts) || message.parts.length === 0) {
      return message;
    }

    let hasUpdatedPart = false;
    const updatedParts = message.parts.map((part) => {
      if (
        typeof part !== 'object' ||
        part === null ||
        !('type' in part) ||
        typeof part.type !== 'string'
      ) {
        return part;
      }

      const isToolPart =
        part.type.startsWith('tool-') || part.type === 'dynamic-tool';
      if (!isToolPart) {
        return part;
      }

      const toolCallId =
        'toolCallId' in part && typeof part.toolCallId === 'string'
          ? part.toolCallId
          : '';

      if (!toolCallId) {
        return part;
      }

      const stat = toolExecutionByCallId.get(toolCallId);
      if (!stat) {
        return part;
      }

      hasUpdatedPart = true;
      return {
        ...part,
        executionTimeMs: stat.executionTimeMs,
      };
    });

    if (!hasUpdatedPart) {
      return message;
    }

    return {
      ...message,
      parts: updatedParts,
    };
  });
}

/**
 * Benchmark early-exit stream wrapper.
 *
 * Passes all bytes through unchanged. As soon as an `a:` tool-result line
 * for runQuery or runQueries is detected (i.e. the SQL has been executed),
 * it:
 *   1. Aborts the LLM stream so the narration step never starts.
 *   2. Appends `data: [DONE]` and closes the response body.
 *
 * Normal (non-benchmark) requests are never wrapped here.
 */
function wrapBenchmarkEarlyExit(
  source: ReadableStream<Uint8Array>,
  abort: AbortController,
): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = source.getReader();
      const enc = new TextEncoder();
      const dec = new TextDecoder();
      let buf = '';
      let exited = false;
      try {
        while (!exited) {
          const { done, value } = await reader.read();
          if (done) break;
          controller.enqueue(value);
          buf += dec.decode(value, { stream: true });
          let from = 0;
          let nl: number;
          while ((nl = buf.indexOf('\n', from)) !== -1) {
            const line = buf.slice(from, nl).trim();
            from = nl + 1;
            if (line.startsWith('a:')) {
              try {
                const parsed = JSON.parse(line.slice(2)) as { result?: unknown };
                const r = parsed.result as Record<string, unknown> | undefined;
                if (
                  r &&
                  ((typeof r.sqlQuery === 'string' && r.sqlQuery) ||
                    (Array.isArray(r.results) && r.results.length > 0))
                ) {
                  abort.abort();
                  controller.enqueue(enc.encode('\ndata: [DONE]\n\n'));
                  exited = true;
                  break;
                }
              } catch {
                /* not a valid runQuery result line */
              }
            }
          }
          if (!exited) buf = buf.slice(from);
        }
      } catch {
        /* abort-triggered read errors are expected in benchmark mode */
      } finally {
        try {
          reader.releaseLock();
        } catch {}
      }
      try {
        controller.close();
      } catch {}
    },
  });
}

/** One turn: loop with Messages.stream, steps, then return SSE Response. */
export async function loop(input: AgentSessionPromptInput): Promise<Response> {
  const logger = await getLogger();
  const {
    conversationSlug,
    messages,
    model = getDefaultModel(),
    repositories,
    telemetry: _telemetry,
    generateTitle = false,
    agentId: inputAgentId,
    onAsk,
    onToolMetadata,
    maxSteps: inputMaxSteps,
    mcpServerUrl,
    benchmarkMode = false,
  } = input;
  const agentId = inputAgentId ?? DEFAULT_AGENT_ID;

  logger.info(
    `[AgentSession] Starting agent session for conversation: ${conversationSlug}, agent: ${agentId}, datasources: ${input.datasources?.join(', ')}`,
  );

  const conversation =
    await repositories.conversation.findBySlug(conversationSlug);
  if (!conversation) {
    throw new Error(`Conversation with slug '${conversationSlug}' not found`);
  }

  const conversationId = conversation.id;
  const messagesApi = createMessages({
    messageRepository: repositories.message,
  });

  let step = 0;
  let responseToReturn: Response | null = null;
  const abortController = new AbortController();
  // Cache datasource context per datasource_id — built once per session turn
  const datasourceContextCache = new Map<string, string>();

  while (true) {
    const msgs = await filterCompacted(messagesApi.stream(conversationId));
    const { lastUser, compactionUser, lastFinished, tasks } = deriveState(msgs);

    const hasPendingCompactionTask = tasks.some((t) => t.type === 'compaction');

    step += 1;
    if (step === 1) {
      ensureTitle({
        conversationSlug,
        conversationId,
        model,
        msgs,
        repositories,
      });
    }

    const task = tasks.pop();

    if (task?.type === 'subtask') {
      continue;
    }

    if (task?.type === 'compaction') {
      await SessionCompaction.process({
        parentID: compactionUser?.id ?? lastUser?.id ?? '',
        messages: msgs,
        conversationSlug,
        abort: abortController.signal,
        auto: (task as { auto: boolean }).auto,
        repositories,
      });
      continue;
    }

    const lastFinishedMeta = lastFinished?.metadata as
      | {
          summary?: boolean;
          tokens?: {
            input: number;
            output: number;
            reasoning: number;
            cache: { read: number; write: number };
          };
        }
      | undefined;
    const lastFinishedSummary = lastFinishedMeta?.summary;
    const lastFinishedTokens = lastFinishedMeta?.tokens;

    if (
      lastFinished &&
      !lastFinishedSummary &&
      lastFinishedTokens &&
      (await SessionCompaction.isOverflow({
        tokens: lastFinishedTokens,
        model,
      }))
    ) {
      logger.info('[AgentSession] Last finished message is overflow', {
        lastFinished,
        userMeta: lastUser?.metadata,
      });

      if (hasPendingCompactionTask) {
        continue;
      }

      const userMeta = lastUser?.metadata as
        | {
            agent?: string;
            model?: { providerID: string; modelID: string };
          }
        | undefined;
      await SessionCompaction.create({
        conversationSlug,
        agent: userMeta?.agent ?? agentId,
        model: userMeta?.model ?? model,
        auto: true,
        afterMessageId: lastUser?.id,
        repositories,
      });
      continue;
    }

    const shouldGenerateTitle =
      conversation.title === 'New Conversation' && generateTitle;

    const agentInfo = Registry.agents.get(agentId);
    if (!agentInfo) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const datasources = await loadDatasources(
      conversation.datasources ?? [],
      repositories.datasource,
    );

    const providerModel =
      typeof model === 'string'
        ? Provider.getModelFromString(model)
        : Provider.getDefaultModel();
    const modelForRegistry = {
      providerId: providerModel.providerID,
      modelId: providerModel.id,
    };

    const assistantMessageId = uuidv4();
    const pendingRealtimeChunks: Uint8Array[] = [];
    const toolExecutionByCallId = new Map<string, ToolExecutionStat>();
    const encoder = new TextEncoder();
    const enqueueToolStartChunk = (
      toolName: string,
      args: unknown,
      toolCallId: string,
    ) => {
      const line = `data: ${JSON.stringify({ type: 'tool-input-available', toolCallId, toolName, input: args })}\n\n`;
      pendingRealtimeChunks.push(encoder.encode(line));
    };
    const captureToolExecution = (
      toolName: string,
      toolCallId: string,
      stats: {
        executionTimeMs: number;
        isError: boolean;
      },
    ) => {
      if (!toolCallId) {
        return;
      }

      toolExecutionByCallId.set(toolCallId, {
        toolName,
        executionTimeMs: stats.executionTimeMs,
        isError: stats.isError,
      });

      const realtimeStatLine = `data: ${JSON.stringify({
        type: 'data-tool-execution',
        data: {
          toolCallId,
          toolName,
          executionTimeMs: stats.executionTimeMs,
          isError: stats.isError,
        },
      })}\n\n`;
      pendingRealtimeChunks.push(encoder.encode(realtimeStatLine));
    };
    // Lazy-initialize intelligence stores (fire-and-forget, safe to fail)
    const [errorFixStore, tribalStore] = await Promise.all([
      getErrorFixStore().catch(() => null),
      getTribalStore().catch(() => null),
    ]);
    // TokenStore is initialized lazily on first session (fire-and-forget)
    void getTokenStore().catch(() => null);

    // Shared mutable extra — persists mutations across all tool calls this turn
    // (e.g. getSemanticContext stores queryPlan, runQuery reads it)
    const sharedExtra: Record<string, unknown> = {
      repositories,
      conversationId,
      attachedDatasources: input.datasources,
      lastRunQueryResult: { current: null },
      errorFixStore,
      tribalStore,
    };

    const getContext = (options: {
      toolCallId?: string;
      abortSignal?: AbortSignal;
    }): ToolContext => ({
      conversationId,
      agentId,
      messageId: assistantMessageId,
      callId: options.toolCallId,
      abort: options.abortSignal ?? abortController.signal,
      extra: sharedExtra,
      messages: msgs,
      ask: async (req: AskRequest) => {
        await onAsk?.(req);
      },
      metadata: async (input: ToolMetadataInput) => {
        await onToolMetadata?.({
          callId: options.toolCallId,
          messageId: assistantMessageId,
          ...input,
        });
      },
      onToolStart: enqueueToolStartChunk,
      onToolComplete: captureToolExecution,
    });

    const { tools, close: closeMcp } = await Registry.tools.forAgent(
      agentId,
      modelForRegistry,
      getContext,
      { mcpServerUrl, webSearch: input.webSearch },
    );

    const reminderContext = {
      attachedDatasourceNames: datasources.map((d: Datasource) => d.name),
    };
    insertReminders({
      messages: msgs,
      agent: agentInfo,
      context: reminderContext,
    });

    const validated = await validateUIMessages({ messages });

    const messagesForLlm =
      msgs.length > 0
        ? msgs
        : await convertToModelMessages(validated, { tools });

    let systemPromptForLlm =
      agentInfo.systemPrompt !== undefined && agentInfo.systemPrompt !== ''
        ? [
            SystemPrompt.provider(providerModel),
            ...(await SystemPrompt.environment(providerModel)),
            agentInfo.systemPrompt,
          ]
            .filter(Boolean)
            .join('\n\n')
        : agentInfo.systemPrompt;

    if (input.webSearch === false) {
      systemPromptForLlm = `${systemPromptForLlm}\n\n${WEB_SEARCH_OFF_INSTRUCTION}`;
    }

    const metaToolIds = new Set([
      'todowrite',
      'todoread',
      'task',
      'webfetch',
      'get_skill',
    ]);
    const capabilityIds = Object.keys(tools).filter(
      (id) => !metaToolIds.has(id),
    );
    const systemPromptWithSuggestions =
      capabilityIds.length > 0
        ? `${systemPromptForLlm}\n\nSUGGESTIONS - Capabilities: When using {{suggestion: ...}}, only suggest actions you can perform with your tools: ${capabilityIds.join(', ')}. Do not suggest CSV/PDF export, file download, or other actions you cannot perform.`
        : systemPromptForLlm;

    // Build datasource-aware system context once per session (cached by datasource_id)
    let datasourceSystemContext = '';
    const firstDatasourceId = input.datasources?.[0];
    if (firstDatasourceId) {
      const cached = datasourceContextCache.get(firstDatasourceId);
      if (cached !== undefined) {
        datasourceSystemContext = cached;
      } else {
        const firstDatasource = datasources.find((d: Datasource) => d.id === firstDatasourceId);
        const dsName = firstDatasource?.name ?? firstDatasourceId.slice(0, 8);
        const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
        datasourceSystemContext = await buildDatasourceSystemContext(
          firstDatasourceId,
          dsName,
          storageDir,
        ).catch(() => '');
        datasourceContextCache.set(firstDatasourceId, datasourceSystemContext);
        logger.info(
          `[session] datasource context length: ${datasourceSystemContext.length} chars for ${dsName}`,
        );
      }
    }

    const finalSystemPrompt = datasourceSystemContext
      ? `${systemPromptWithSuggestions}\n\n${datasourceSystemContext}`
      : systemPromptWithSuggestions;

    const result = await LLM.stream({
      model,
      messages: messagesForLlm,
      tools,
      maxSteps: inputMaxSteps ?? agentInfo.steps ?? 5,
      abortSignal: abortController.signal,
      systemPrompt: finalSystemPrompt,
      onFinish: closeMcp
        ? async () => {
            await closeMcp();
          }
        : undefined,
    });

    const streamResponse = result.toUIMessageStreamResponse({
      generateMessageId: () => uuidv4(),
      messageMetadata: ({
        part,
      }: {
        part: {
          type: string;
          totalUsage?: {
            inputTokens?: number;
            outputTokens?: number;
            reasoningTokens?: number;
            cachedInputTokens?: number;
          };
        };
      }) => {
        if (part.type === 'finish' && part.totalUsage) {
          const raw = part.totalUsage;
          return {
            tokens: {
              input: raw.inputTokens ?? 0,
              output: raw.outputTokens ?? 0,
              reasoning: raw.reasoningTokens ?? 0,
              cache: {
                read: raw.cachedInputTokens ?? 0,
                write: 0,
              },
            },
            finish: 'stop',
          };
        }
      },
      onFinish: async ({ messages: finishedMessages }) => {
        const messagesWithToolExecution = withToolExecutionStats(
          finishedMessages,
          toolExecutionByCallId,
        );
        const totalUsage = await result.totalUsage;
        const usagePersistenceService = new UsagePersistenceService(
          repositories.usage,
          repositories.conversation,
          repositories.project,
          conversationSlug,
        );
        try {
          await usagePersistenceService.persistUsage(
            totalUsage,
            model,
            conversation.createdBy,
          );
        } catch (error) {
          const log = await getLogger();
          log.error('[AgentSession] Failed to persist usage:', error);
        }

        // Store token usage in internal DB (fire-and-forget)
        {
          const raw = (totalUsage ?? {}) as {
            inputTokens?: number;
            outputTokens?: number;
            reasoningTokens?: number;
            cachedInputTokens?: number;
          };
          const inputTokens = raw.inputTokens ?? 0;
          const outputTokens = raw.outputTokens ?? 0;
          if (inputTokens > 0 || outputTokens > 0) {
            const datasourceIdForTokens =
              (sharedExtra.attachedDatasources as string[] | undefined)?.[0] ?? null;
            console.info(
              `[AgentSession] storing tokens model=${providerModel.id} in=${inputTokens} out=${outputTokens}`,
            );
            getTokenStore()
              .then((ts) => {
                if (!ts) return;
                return ts.store({
                  id: uuidv4(),
                  conversationId,
                  datasourceId: datasourceIdForTokens,
                  modelId: providerModel.id,
                  providerId: providerModel.providerID,
                  inputTokens,
                  outputTokens,
                  reasoningTokens: raw.reasoningTokens ?? 0,
                  cachedTokens: raw.cachedInputTokens ?? 0,
                });
              })
              .catch((err: unknown) =>
                console.warn('[TokenStore] store failed:', err),
              );
          } else {
            console.warn(
              `[AgentSession] totalUsage has 0 tokens for model=${providerModel.id} — provider may not report usage`,
            );
          }
        }

        const lastAssistant = [...messagesWithToolExecution]
          .reverse()
          .find((m) => m.role === 'assistant');
        if (lastAssistant && totalUsage) {
          const raw = totalUsage as {
            inputTokens?: number;
            outputTokens?: number;
            reasoningTokens?: number;
            cachedInputTokens?: number;
          };
          const meta =
            lastAssistant.metadata && typeof lastAssistant.metadata === 'object'
              ? (lastAssistant.metadata as Record<string, unknown>)
              : {};
          lastAssistant.metadata = {
            ...meta,
            tokens: {
              input: raw.inputTokens ?? 0,
              output: raw.outputTokens ?? 0,
              reasoning: raw.reasoningTokens ?? 0,
              cache: {
                read: raw.cachedInputTokens ?? 0,
                write: 0,
              },
            },
            finish: 'stop',
          };
        }

        const persistence = new MessagePersistenceService(
          repositories.message,
          repositories.conversation,
          conversationSlug,
        );
        try {
          const persistResult = await persistence.persistMessages(
            messagesWithToolExecution,
            undefined,
            {
              defaultMetadata: {
                agent: agentId,
                model: {
                  modelID: providerModel.id,
                  providerID: providerModel.providerID,
                },
              },
            },
          );
          if (persistResult.errors.length > 0) {
            const log = await getLogger();
            log.warn(
              `[AgentSession] Assistant message persistence failed for ${conversationSlug}:`,
              persistResult.errors.map((e) => e.message).join(', '),
            );
          }
        } catch (error) {
          const log = await getLogger();
          log.warn(
            `[AgentSession] Assistant message persistence threw for ${conversationSlug}:`,
            error instanceof Error ? error.message : String(error),
          );
        }

        // Store query trace (fire-and-forget — does not block response)
        const queryPlan = sharedExtra.lastQueryPlan as
          | { intent: string; complexity: number }
          | undefined;
        const resolvedFields = sharedExtra.lastResolvedFields as
          | Array<{ field_id: string; label: string; sql: string }>
          | undefined;
        const lastQuestion = sharedExtra.lastQuestion as string | undefined;
        const lastRunQueryResult = sharedExtra.lastRunQueryResult as
          | { current: { columns: string[]; rows: unknown[] } | null }
          | undefined;
        const correctionTrace = sharedExtra.lastCorrectionTrace as
          | { correctedSQL?: string }
          | undefined;

        if (queryPlan && resolvedFields && lastQuestion && lastRunQueryResult?.current) {
          const result = lastRunQueryResult.current;
          getTraceStore()
            .then((ts) => {
              if (!ts) return;
              const datasourceId =
                (sharedExtra.attachedDatasources as string[])[0] ?? '';
              return ts.store({
                id: uuidv4(),
                datasourceId,
                question: lastQuestion,
                keywords: (sharedExtra.lastKeywords as string[] | undefined) ?? [],
                fieldsUsed: resolvedFields.map((f) => ({
                  field_id: f.field_id,
                  label: f.label,
                  sql: f.sql,
                })),
                sqlFinal:
                  correctionTrace?.correctedSQL ??
                  (sharedExtra.lastFinalSQL as string | undefined) ??
                  '',
                resultShape: {
                  columns: result.columns ?? [],
                  row_count: result.rows?.length ?? 0,
                },
                intent: queryPlan.intent,
                complexity: queryPlan.complexity,
                pathUsed: 2,
                correctionApplied: correctionTrace ?? null,
                success: true,
              });
            })
            .catch((err: unknown) =>
              console.error('[AgentSession] trace store failed:', err),
            );
        }

        // Patch semantic layer from successful corrections (fire-and-forget via hook)
        if (_postQueryHook && correctionTrace && resolvedFields) {
          const datasourceId =
            (sharedExtra.attachedDatasources as string[])[0] ?? '';
          try {
            _postQueryHook(
              datasourceId,
              correctionTrace as Record<string, unknown>,
              resolvedFields,
            );
          } catch (err) {
            console.error('[AgentSession] post-query hook failed:', err);
          }
        }

        // Enrich semantic layer from every successful query (fire-and-forget)
        if (
          _enrichmentAgent &&
          lastRunQueryResult?.current &&
          queryPlan &&
          lastQuestion
        ) {
          const datasourceId =
            (sharedExtra.attachedDatasources as string[])[0] ?? '';
          const sqlFinal =
            (correctionTrace?.correctedSQL as string | undefined) ??
            (sharedExtra.lastFinalSQL as string | undefined) ??
            '';
          if (sqlFinal) {
            _enrichmentAgent
              .analyse({
                datasourceId,
                question: lastQuestion,
                sqlFinal,
                fieldsUsed: (resolvedFields ?? []).map((f) => ({
                  field_id: f.field_id,
                  label: f.label,
                  sql: f.sql ?? '',
                })),
                queryPlan: queryPlan as {
                  intent: string;
                  cotPlan?: string;
                  complexity: number;
                },
                correctionTrace: correctionTrace as Record<string, unknown> | null,
              })
              .catch((err: unknown) =>
                console.error('[AgentSession] enrichment agent failed:', err),
              );
          }
        }
      },
    });

    if (!streamResponse.body) {
      responseToReturn = new Response(null, { status: 204 });
      break;
    }

    const wrapStreamWithRealtimeFlush = (source: ReadableStream<Uint8Array>) =>
      new ReadableStream<Uint8Array>({
        async start(controller) {
          const buffer: Uint8Array[] = [];
          let streamDone = false;
          const wake = { f: null as (() => void) | null };
          const waitForChunk = (): Promise<void> =>
            new Promise((r) => {
              wake.f = r;
            });

          const reader = source.getReader();
          void (async () => {
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                buffer.push(value);
                const f = wake.f;
                wake.f = null;
                f?.();
              }
            } finally {
              streamDone = true;
              wake.f?.();
              reader.releaseLock();
            }
          })();

          try {
            while (true) {
              while (pendingRealtimeChunks.length > 0) {
                const chunk = pendingRealtimeChunks.shift();
                if (chunk) controller.enqueue(chunk);
              }
              if (buffer.length > 0) {
                const chunk = buffer.shift()!;
                controller.enqueue(chunk);
              } else if (streamDone) {
                break;
              } else {
                await waitForChunk();
              }
            }
            controller.close();
          } catch (e) {
            controller.error(e);
          }
        },
      });

    const firstUser = messages.find((m) => m.role === 'user');
    const userMessageText = firstUser
      ? (firstUser.parts
          ?.filter((p) => p.type === 'text')
          .map((p) => (p as { text: string }).text)
          .join(' ')
          .trim() ?? '')
      : '';

    if (!shouldGenerateTitle || !userMessageText) {
      const base = wrapStreamWithRealtimeFlush(streamResponse.body);
      responseToReturn = new Response(
        benchmarkMode ? wrapBenchmarkEarlyExit(base, abortController) : base,
        { headers: SSE_HEADERS },
      );
      break;
    }

    const conv = conversation;
    const baseStream = wrapStreamWithRealtimeFlush(streamResponse.body);
    const serveStream = benchmarkMode
      ? wrapBenchmarkEarlyExit(baseStream, abortController)
      : baseStream;
    const stream = new ReadableStream({
      async start(controller) {
        const reader = serveStream.getReader();
        const decoder = new TextDecoder();

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              setTimeout(async () => {
                try {
                  const existing =
                    await repositories.message.findByConversationId(conv.id);
                  const userMessages = existing.filter(
                    (msg) => msg.role === MessageRole.USER,
                  );
                  const assistantMessages = existing.filter(
                    (msg) => msg.role === MessageRole.ASSISTANT,
                  );

                  if (
                    userMessages.length !== 1 ||
                    assistantMessages.length !== 1 ||
                    conv.title !== 'New Conversation'
                  ) {
                    return;
                  }

                  const assistantMessage = assistantMessages[0];
                  if (!assistantMessage) return;

                  let assistantText = '';
                  if (
                    typeof assistantMessage.content === 'object' &&
                    assistantMessage.content !== null &&
                    'parts' in assistantMessage.content &&
                    Array.isArray(assistantMessage.content.parts)
                  ) {
                    assistantText = assistantMessage.content.parts
                      .filter(
                        (part): part is { type: 'text'; text: string } =>
                          part.type === 'text',
                      )
                      .map((part) => part.text ?? '')
                      .join(' ')
                      .trim();
                  }

                  if (assistantText) {
                    const title = await generateConversationTitle(
                      userMessageText,
                      assistantText,
                    );
                    if (title && title !== 'New Conversation') {
                      await repositories.conversation.update({
                        ...conv,
                        title,
                        updatedBy: conv.createdBy ?? 'system',
                        updatedAt: new Date(),
                      });
                    }
                  }
                } catch (e) {
                  logger.error('Failed to generate conversation title:', e);
                }
              }, 1000);
              break;
            }

            controller.enqueue(
              new TextEncoder().encode(decoder.decode(value, { stream: true })),
            );
          }
        } catch (e) {
          controller.error(e);
        } finally {
          reader.releaseLock();
        }
      },
    });

    responseToReturn = new Response(stream, { headers: SSE_HEADERS });
    break;
  }

  await SessionCompaction.prune({ conversationSlug, repositories });

  if (responseToReturn !== null) return responseToReturn;
  return new Response(null, { status: 204 });
}

/** Datasource update + invalidation, then loop. Returns a Response with body = ReadableStream (SSE). */
export async function prompt(
  input: AgentSessionPromptInput,
): Promise<Response> {
  const { conversationSlug, datasources, messages, repositories } = input;

  //TODO use usecase to respect clean code principles
  const conversation =
    await repositories.conversation.findBySlug(conversationSlug);

  if (datasources && datasources.length > 0 && conversation) {
    const current = conversation.datasources ?? [];
    const currentSorted = [...current].sort();
    const newSorted = [...datasources].sort();
    const changed =
      currentSorted.length !== newSorted.length ||
      !currentSorted.every((id, i) => id === newSorted[i]);

    if (changed) {
      // TODO use usecase to respect clean code principles
      await repositories.conversation.update({
        ...conversation,
        datasources,
        updatedBy: conversation.createdBy ?? 'system',
        updatedAt: new Date(),
      });
    }
  }

  // Persist the latest user message before loop() so the first messagesApi.stream()
  // includes it; otherwise the agent would reply to the previous turn.
  const lastUserMessage = [...messages]
    .reverse()
    .find((m) => m.role === 'user');
  if (lastUserMessage) {
    const logger = await getLogger();
    const persistence = new MessagePersistenceService(
      repositories.message,
      repositories.conversation,
      conversationSlug,
    );
    try {
      const persistResult = await persistence.persistMessages(
        [lastUserMessage],
        undefined,
        {
          defaultMetadata: {
            agent: input.agentId ?? DEFAULT_AGENT_ID,
          },
        },
      );
      if (persistResult.errors.length > 0) {
        logger.warn(
          `[AgentSession] User message persistence failed for ${conversationSlug}:`,
          persistResult.errors.map((e) => e.message).join(', '),
        );
      }
    } catch (error) {
      logger.warn(
        `[AgentSession] User message persistence threw for ${conversationSlug}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return loop(input);
}
