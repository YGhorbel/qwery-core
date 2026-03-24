import { DefaultChatTransport } from 'ai';
import { normalizeUIRole } from '@qwery/shared/message-role-utils';

type DefaultTransportOptions = {
  model?: string;
};

export const defaultTransport = (
  api: string,
  options?: DefaultTransportOptions,
) =>
  new DefaultChatTransport({
    api,
    prepareSendMessagesRequest: (request) => {
      const { messages, body = {}, trigger } = request;
      const lastUserMessageIndex = messages.findLastIndex(
        (m) => normalizeUIRole(m.role) === 'user',
      );
      const lastUserMessage =
        lastUserMessageIndex >= 0 ? messages[lastUserMessageIndex] : undefined;
      return {
        body: {
          ...body,
          ...(options?.model ? { model: body.model ?? options.model } : {}),
          messages: lastUserMessage ? [lastUserMessage] : [],
          ...(trigger ? { trigger } : {}),
        },
      };
    },
  });
