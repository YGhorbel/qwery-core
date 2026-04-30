import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  prompt,
  getDefaultModel,
  validateUIMessages,
  PROMPT_SOURCE,
  type PromptSource,
  type NotebookCellType,
  type UIMessage,
} from '@qwery/agent-factory-sdk';
import { normalizeUIRole } from '@qwery/shared/message-role-utils';
import { MessageRole } from '@qwery/domain/entities';
import type { Repositories } from '@qwery/domain/repositories';
import { createRepositories } from '../lib/repositories';
import { getTelemetry } from '../lib/telemetry';
import { resolveChatDatasources } from '../helpers/chat-helper';
import { handleDomainException } from '../lib/http-utils';

const chatBodySchema = z.object({
  messages: z.array(z.unknown()),
  model: z.string().optional(),
  datasources: z.array(z.string()).optional(),
  webSearch: z.boolean().optional(),
  trigger: z.enum(['submit-message', 'regenerate-message']).optional(),
});

const chatParamSchema = z.object({
  slug: z.string().min(1),
});

let repositoriesPromise: Promise<Repositories> | undefined;

async function getRepositories(): Promise<Repositories> {
  if (!repositoriesPromise) {
    repositoriesPromise = createRepositories();
  }
  return repositoriesPromise;
}

const SYSTEM_REMINDER_PATTERN = /<system-reminder>[\s\S]*?<\/system-reminder>/gi;
const INJECTION_TAG_PATTERN = /<(instruction|prompt|directive|system)[^>]*>[\s\S]*?<\/\1>/gi;
const ZERO_WIDTH_PATTERN = /[​-‍﻿]/g;
const SUGGESTION_DDL_PATTERN = /\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER|CREATE|EXEC|EXECUTE)\b/gi;

function sanitizeUserMessage(content: string): string {
  return content
    .replace(SYSTEM_REMINDER_PATTERN, '')
    .replace(INJECTION_TAG_PATTERN, '')
    .replace(ZERO_WIDTH_PATTERN, '')
    .trim();
}

function sanitizeSuggestion(text: string): string {
  SUGGESTION_DDL_PATTERN.lastIndex = 0;
  if (SUGGESTION_DDL_PATTERN.test(text)) return '';
  return text.slice(0, 120);
}

export function createChatRoutes() {
  const app = new Hono();

  app.post(
    '/:slug',
    zValidator('param', chatParamSchema),
    zValidator('json', chatBodySchema),
    async (c) => {
      try {
        const { slug } = c.req.valid('param');
        const body = c.req.valid('json');
        const messages = body.messages as UIMessage[];
        // If the server has an explicit DEFAULT_MODEL configured, always use it.
        // This prevents a client-stored model (e.g. azure/gpt-5.2-chat from a previous
        // session) from overriding the server operator's provider choice.
        const serverDefault = getDefaultModel();
        const model = process.env.DEFAULT_MODEL ? serverDefault : (body.model ?? serverDefault);

        const repositories = await getRepositories();
        if (body.trigger === 'regenerate-message') {
          const conversation = await repositories.conversation.findBySlug(slug);
          if (conversation) {
            const convMessages =
              await repositories.message.findByConversationId(conversation.id);
            const lastMessage = convMessages.at(-1);
            if (lastMessage && lastMessage.role === MessageRole.ASSISTANT) {
              await repositories.message.delete(lastMessage.id);
            }
          }
        }
        const datasources = await resolveChatDatasources({
          bodyDatasources: body.datasources,
          messages,
          conversationSlug: slug,
          conversationRepository: repositories.conversation,
        });
        const telemetry = await getTelemetry();

        const needSQL = false;

        const processedMessages = messages.map(
          (message: UIMessage, index: number) => {
            // Strip injected system tags from all user messages before they reach the LLM
            if (normalizeUIRole(message.role) === 'user' && Array.isArray(message.parts)) {
              message = {
                ...message,
                parts: message.parts.map((part) => {
                  if (part.type === 'text' && 'text' in part) {
                    return { ...part, text: sanitizeUserMessage((part as { type: 'text'; text: string }).text) };
                  }
                  return part;
                }),
              };
            }

            const isLastUserMessage =
              normalizeUIRole(message.role) === 'user' &&
              index === messages.length - 1;

            if (isLastUserMessage) {
              const messageMetadata = (message.metadata ?? {}) as Record<
                string,
                unknown
              >;
              const isNotebookSource =
                messageMetadata.promptSource === PROMPT_SOURCE.INLINE ||
                messageMetadata.notebookCellType !== undefined;
              const promptSource: PromptSource = isNotebookSource
                ? PROMPT_SOURCE.INLINE
                : PROMPT_SOURCE.CHAT;
              const notebookCellType = messageMetadata.notebookCellType as
                | NotebookCellType
                | undefined;

              const cleanMetadata = { ...messageMetadata };
              delete (cleanMetadata as Record<string, unknown>).source;

              return {
                ...message,
                metadata: {
                  ...cleanMetadata,
                  promptSource,
                  needSQL,
                  ...(notebookCellType ? { notebookCellType } : {}),
                  ...(datasources && datasources.length > 0
                    ? { datasources }
                    : {}),
                },
              };
            }

            if (normalizeUIRole(message.role) === 'user') {
              const textPart = message.parts?.find(
                (p): p is { type: 'text'; text: string } =>
                  p.type === 'text' && 'text' in p,
              );
              if (textPart) {
                const text = textPart.text;
                const guidanceMarker = '__QWERY_SUGGESTION_GUIDANCE__';
                const guidanceEndMarker = '__QWERY_SUGGESTION_GUIDANCE_END__';

                if (text.includes(guidanceMarker)) {
                  const endIndex = text.indexOf(guidanceEndMarker);
                  if (endIndex !== -1) {
                    const rawText = text
                      .substring(endIndex + guidanceEndMarker.length)
                      .trim();
                    const cleanText = sanitizeSuggestion(rawText) || rawText.replace(/\b(DROP|DELETE|TRUNCATE|INSERT|UPDATE|ALTER|CREATE|EXEC|EXECUTE)\b/gi, '[removed]');

                    const suggestionGuidance = `[SUGGESTION WORKFLOW GUIDANCE]
- This is a suggested next step from a previous response - execute it directly and efficiently
- Use the provided context (previous question/answer) to understand the full conversation flow
- Be action-oriented: proceed immediately with the requested operation without asking for confirmation
- Keep your response concise and focused on delivering the requested result
- If the suggestion involves a query or analysis, execute it and present the findings clearly

User request: ${cleanText}`;

                    return {
                      ...message,
                      parts: message.parts?.map((part) => {
                        if (part.type === 'text' && 'text' in part) {
                          return { ...part, text: suggestionGuidance };
                        }
                        return part;
                      }),
                    };
                  }
                }
              }
            }

            return message;
          },
        );

        const validatedMessages = await validateUIMessages({
          messages: processedMessages,
        });

        const mcpServerUrl =
          process.env.QWERY_MCP_SERVER_URL ??
          `${new URL(c.req.url).origin}/mcp`;

        const benchmarkMode = c.req.header('X-Benchmark-Mode') === 'true';

        const response = await prompt({
          conversationSlug: slug,
          messages: validatedMessages,
          model,
          datasources,
          webSearch: body.webSearch,
          repositories,
          telemetry,
          generateTitle: true,
          mcpServerUrl,
          benchmarkMode,
        });

        return response;
      } catch (error) {
        return handleDomainException(error);
      }
    },
  );

  return app;
}
