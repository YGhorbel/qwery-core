import { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send, Loader2, Bot, User, AlertCircle } from 'lucide-react';

import { Button } from '@qwery/ui/button';
import { Textarea } from '@qwery/ui/textarea';
import { ScrollArea } from '@qwery/ui/scroll-area';

import type { Route } from './+types/agent';
import { getRepositoriesForLoader } from '~/lib/loaders/create-repositories';
import { GetDatasourceBySlugService } from '@qwery/domain/services';
import { DomainException } from '@qwery/domain/exceptions';
import { ClarificationCard } from './_components/clarification-card';

export async function clientLoader(args: Route.ClientLoaderArgs) {
  const slug = args.params.slug;
  if (!slug) throw new Response('Not Found', { status: 404 });

  const repositories = await getRepositoriesForLoader(args.request);
  const service = new GetDatasourceBySlugService(repositories.datasource);

  try {
    const datasource = await service.execute(slug);
    return { datasource };
  } catch (error) {
    if (error instanceof DomainException)
      throw new Response('Not Found', { status: 404 });
    throw error;
  }
}

type MessageRole = 'user' | 'assistant' | 'error';

interface ClarificationQuestion {
  question: string;
  assumption: string;
}

interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  matchedDatasets?: string[];
  tokensUsed?: { total: number };
  status?: 'clarification_needed' | 'clarification_answered';
  clarificationQuestions?: ClarificationQuestion[];
}

function getApiBaseUrl(): string {
  if (
    typeof window !== 'undefined' &&
    (window as { __QWERY_API_URL?: string }).__QWERY_API_URL
  ) {
    return (window as { __QWERY_API_URL?: string }).__QWERY_API_URL!;
  }
  return import.meta.env?.VITE_API_URL || '/api';
}

export default function DataAgentPage(props: Route.ComponentProps) {
  const { t } = useTranslation();
  const { datasource } = props.loaderData;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const [currentPhase, setCurrentPhase] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const conversationContextRef = useRef('');
  const clarificationRoundRef = useRef(0);
  // store pending clarification questions until message_complete arrives
  const pendingClarificationQuestionsRef = useRef<ClarificationQuestion[]>([]);

  const scrollToBottom = useCallback(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, []);

  const runQuery = useCallback(
    async (question: string, assistantMsgId: string) => {
      abortRef.current = new AbortController();

      try {
        const baseUrl = getApiBaseUrl();
        const response = await fetch(
          `${baseUrl}/datasources/${datasource.id}/query`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              question,
              conversationContext: conversationContextRef.current,
              clarificationRound: clarificationRoundRef.current,
            }),
            signal: abortRef.current.signal,
          },
        );

        if (!response.ok || !response.body) {
          throw new Error(`HTTP ${response.status}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let matchedDatasets: string[] = [];
        let tokensUsed: { total: number } | undefined;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const raw = line.slice(6).trim();
            if (!raw) continue;

            try {
              const event = JSON.parse(raw) as {
                type: string;
                content?: string;
                matchedDatasets?: Array<{ name: string }>;
                questions?: ClarificationQuestion[];
                metadata?: {
                  tokensUsed?: { total: number };
                  lineage?: { datasetsUsed?: string[] };
                };
                status?: string;
                message?: string;
                phase?: string;
                purpose?: string;
                callIndex?: number;
                durationMs?: number;
                totalTokens?: number;
                description?: string;
              };

              if (event.type === 'phase_start' && event.phase) {
                setCurrentPhase(event.phase);
              } else if (event.type === 'phase_complete') {
                setCurrentPhase(null);
              } else if (event.type === 'llm_call_start') {
                console.debug('[agent:llm_call_start]', {
                  phase: event.phase,
                  purpose: event.purpose,
                  callIndex: event.callIndex,
                });
              } else if (event.type === 'llm_call_end') {
                console.debug('[agent:llm_call_end]', {
                  phase: event.phase,
                  purpose: event.purpose,
                  callIndex: event.callIndex,
                  durationMs: event.durationMs,
                  totalTokens: event.totalTokens,
                });
              } else if (event.type === 'text' && event.content) {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? { ...m, content: m.content + event.content }
                      : m,
                  ),
                );
                scrollToBottom();
              } else if (
                event.type === 'discovery_complete' &&
                event.matchedDatasets
              ) {
                matchedDatasets = event.matchedDatasets.map((d) => d.name);
              } else if (
                event.type === 'clarification_requested' &&
                event.questions
              ) {
                pendingClarificationQuestionsRef.current = event.questions;
              } else if (event.type === 'message_complete') {
                if (event.metadata?.tokensUsed)
                  tokensUsed = event.metadata.tokensUsed;
                const datasetsUsed =
                  event.metadata?.lineage?.datasetsUsed ?? matchedDatasets;

                if (event.status === 'clarification_needed') {
                  // Mark message as needing clarification
                  const questions = pendingClarificationQuestionsRef.current;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? {
                            ...m,
                            status: 'clarification_needed',
                            clarificationQuestions: questions,
                            matchedDatasets: datasetsUsed,
                            tokensUsed,
                          }
                        : m,
                    ),
                  );
                  // Update context with this exchange
                  conversationContextRef.current += `\n[Clarification requested — round ${clarificationRoundRef.current}]`;
                } else {
                  // Final answer — reset clarification state
                  clarificationRoundRef.current = 0;
                  conversationContextRef.current += `\n[Answer provided]`;
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === assistantMsgId
                        ? { ...m, matchedDatasets: datasetsUsed, tokensUsed }
                        : m,
                    ),
                  );
                }
              } else if (event.type === 'message_error') {
                setMessages((prev) =>
                  prev.map((m) =>
                    m.id === assistantMsgId
                      ? {
                          ...m,
                          role: 'error',
                          content: event.message ?? 'An error occurred',
                        }
                      : m,
                  ),
                );
              }
            } catch {
              // skip malformed event lines
            }
          }
        }
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        const msg = err instanceof Error ? err.message : 'Request failed';
        setMessages((prev) =>
          prev.map((m) =>
            m.id === assistantMsgId ? { ...m, role: 'error', content: msg } : m,
          ),
        );
      } finally {
        setIsStreaming(false);
        setCurrentPhase(null);
        abortRef.current = null;
        pendingClarificationQuestionsRef.current = [];
      }
    },
    [datasource.id, scrollToBottom],
  );

  const handleSubmit = useCallback(
    async (questionOverride?: string) => {
      const question = (questionOverride ?? input).trim();
      if (!question || isStreaming) return;

      if (!questionOverride) setInput('');
      setIsStreaming(true);

      const userMsg: ChatMessage = {
        id: crypto.randomUUID(),
        role: 'user',
        content: question,
      };
      const assistantMsgId = crypto.randomUUID();
      const assistantMsg: ChatMessage = {
        id: assistantMsgId,
        role: 'assistant',
        content: '',
      };

      setMessages((prev) => [...prev, userMsg, assistantMsg]);
      scrollToBottom();

      // Seed conversation context with the question
      conversationContextRef.current += `\nQ: ${question}`;

      await runQuery(question, assistantMsgId);
    },
    [input, isStreaming, runQuery, scrollToBottom],
  );

  const handleClarificationAnswer = useCallback(
    (msg: ChatMessage, answerText: string) => {
      clarificationRoundRef.current += 1;
      conversationContextRef.current += `\n[Clarification round ${clarificationRoundRef.current}] Answer: ${answerText}`;

      // Mark message as answered
      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, status: 'clarification_answered' } : m,
        ),
      );

      // Re-submit with the same question (last user message in the array)
      const originalQuestion =
        messages.findLast((m) => m.role === 'user')?.content ?? '';
      void handleSubmit(originalQuestion);
    },
    [messages, handleSubmit],
  );

  const handleProceedWithAssumptions = useCallback(
    (msg: ChatMessage) => {
      clarificationRoundRef.current += 1;
      conversationContextRef.current += `\n[Clarification round ${clarificationRoundRef.current}] Proceeding with assumptions.`;

      setMessages((prev) =>
        prev.map((m) =>
          m.id === msg.id ? { ...m, status: 'clarification_answered' } : m,
        ),
      );

      const originalQuestion =
        messages.findLast((m) => m.role === 'user')?.content ?? '';
      void handleSubmit(originalQuestion);
    },
    [messages, handleSubmit],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSubmit();
      }
    },
    [handleSubmit],
  );

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <div className="border-b px-6 py-4">
        <h1 className="text-xl font-semibold">
          {t('routes.datasourceAgent', { defaultValue: 'Data Agent' })}
        </h1>
        <p className="text-muted-foreground mt-0.5 text-sm">
          {t('datasource.agent.subtitle', {
            defaultValue: 'Ask questions about your data in plain English',
            name: datasource.name,
          })}
        </p>
      </div>

      {/* Messages */}
      <ScrollArea className="min-h-0 flex-1 px-6 py-4">
        {messages.length === 0 && (
          <div className="text-muted-foreground flex flex-col items-center justify-center py-20 text-center">
            <Bot className="mb-4 h-10 w-10 opacity-40" />
            <p className="text-sm">
              {t('datasource.agent.emptyState', {
                defaultValue: 'Ask a question about your data to get started',
              })}
            </p>
          </div>
        )}

        <div className="space-y-4">
          {messages.map((msg) => (
            <div
              key={msg.id}
              className={`flex gap-3 ${msg.role === 'user' ? 'flex-row-reverse' : 'flex-row'}`}
            >
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full ${
                  msg.role === 'user'
                    ? 'bg-primary text-primary-foreground'
                    : msg.role === 'error'
                      ? 'bg-destructive text-destructive-foreground'
                      : 'bg-muted'
                }`}
              >
                {msg.role === 'user' ? (
                  <User className="h-4 w-4" />
                ) : msg.role === 'error' ? (
                  <AlertCircle className="h-4 w-4" />
                ) : (
                  <Bot className="h-4 w-4" />
                )}
              </div>

              <div
                className={`flex max-w-[80%] flex-col gap-1 ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
              >
                <div
                  className={`rounded-2xl px-4 py-2.5 text-sm whitespace-pre-wrap ${
                    msg.role === 'user'
                      ? 'bg-primary text-primary-foreground'
                      : msg.role === 'error'
                        ? 'border-destructive/30 bg-destructive/10 text-destructive border'
                        : 'bg-muted'
                  }`}
                  data-test="agent-message"
                >
                  {msg.content ||
                    (msg.status === 'clarification_needed' ? null : (
                      <span className="text-muted-foreground flex items-center gap-1">
                        {isStreaming && (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        )}
                        {isStreaming
                          ? currentPhase
                            ? `${currentPhase.replace('_', ' ')}…`
                            : 'Thinking…'
                          : null}
                      </span>
                    ))}
                </div>

                {msg.role === 'assistant' &&
                  msg.status === 'clarification_needed' &&
                  msg.clarificationQuestions &&
                  msg.clarificationQuestions.length > 0 && (
                    <ClarificationCard
                      questions={msg.clarificationQuestions}
                      disabled={isStreaming}
                      onAnswer={(text) => handleClarificationAnswer(msg, text)}
                      onProceedWithAssumptions={() =>
                        handleProceedWithAssumptions(msg)
                      }
                    />
                  )}

                {msg.role === 'assistant' &&
                  (msg.matchedDatasets || msg.tokensUsed) && (
                    <div className="text-muted-foreground flex flex-wrap gap-2 px-1 text-xs">
                      {msg.matchedDatasets &&
                        msg.matchedDatasets.length > 0 && (
                          <span>
                            Datasets: {msg.matchedDatasets.join(', ')}
                          </span>
                        )}
                      {msg.tokensUsed && msg.tokensUsed.total > 0 && (
                        <span>
                          {msg.tokensUsed.total.toLocaleString()} tokens
                        </span>
                      )}
                    </div>
                  )}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>
      </ScrollArea>

      {/* Input */}
      <div className="border-t px-6 py-4">
        <div className="flex gap-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t('datasource.agent.inputPlaceholder', {
              defaultValue: 'Ask a question about your data… (Enter to send)',
            })}
            className="max-h-[200px] min-h-[44px] resize-none"
            rows={1}
            disabled={isStreaming}
            data-test="agent-input"
          />
          <Button
            onClick={() => void handleSubmit()}
            disabled={!input.trim() || isStreaming}
            size="icon"
            className="shrink-0"
            data-test="agent-send"
          >
            {isStreaming ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          {t('datasource.agent.hint', {
            defaultValue:
              'Shift+Enter for a new line. Requires Stage 1–3 to be completed.',
          })}
        </p>
      </div>
    </div>
  );
}
