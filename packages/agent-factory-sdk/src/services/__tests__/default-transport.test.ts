import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DefaultChatTransport } from 'ai';
import { defaultTransport } from '../default-transport';

vi.mock('ai', () => ({
  DefaultChatTransport: vi.fn(),
}));

vi.mock('@qwery/shared/message-role-utils', () => ({
  normalizeUIRole: (role: string) => role,
}));

const MockedTransport = vi.mocked(DefaultChatTransport);

type PrepareRequest = (request: {
  messages: { role: string; id?: string }[];
  body?: Record<string, unknown>;
  trigger?: string;
}) => { body: Record<string, unknown> };

function getPrepareFn(): PrepareRequest {
  const call = MockedTransport.mock.calls.at(-1);
  if (!call) throw new Error('DefaultChatTransport not called');
  const config = call[0] as { prepareSendMessagesRequest: PrepareRequest };
  return config.prepareSendMessagesRequest;
}

const userMessage = { role: 'user', id: 'msg-1' };

describe('defaultTransport — prepareSendMessagesRequest', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects model from options when body.model is absent', () => {
    defaultTransport('/api/chat/test', { model: 'openai/gpt-4o' });
    const prepare = getPrepareFn();

    const result = prepare({ messages: [userMessage], body: {} });

    expect(result.body.model).toBe('openai/gpt-4o');
  });

  it('preserves body.model over options.model', () => {
    defaultTransport('/api/chat/test', { model: 'openai/gpt-4o' });
    const prepare = getPrepareFn();

    const result = prepare({
      messages: [userMessage],
      body: { model: 'anthropic/claude-3-5-sonnet' },
    });

    expect(result.body.model).toBe('anthropic/claude-3-5-sonnet');
  });

  it('does not inject model when options.model is not provided', () => {
    defaultTransport('/api/chat/test');
    const prepare = getPrepareFn();

    const result = prepare({ messages: [userMessage], body: {} });

    expect(result.body.model).toBeUndefined();
  });

  it('sends only the last user message', () => {
    defaultTransport('/api/chat/test');
    const prepare = getPrepareFn();

    const messages = [
      { role: 'user', id: 'msg-1' },
      { role: 'assistant', id: 'msg-2' },
      { role: 'user', id: 'msg-3' },
    ];

    const result = prepare({ messages, body: {} });

    expect(result.body.messages).toEqual([{ role: 'user', id: 'msg-3' }]);
  });

  it('includes trigger in body when present', () => {
    defaultTransport('/api/chat/test');
    const prepare = getPrepareFn();

    const result = prepare({
      messages: [userMessage],
      body: {},
      trigger: 'regenerate',
    });

    expect(result.body.trigger).toBe('regenerate');
  });

  it('preserves other body fields', () => {
    defaultTransport('/api/chat/test', { model: 'openai/gpt-4o' });
    const prepare = getPrepareFn();

    const result = prepare({
      messages: [userMessage],
      body: { webSearch: true, datasources: ['ds-1'] },
    });

    expect(result.body.webSearch).toBe(true);
    expect(result.body.datasources).toEqual(['ds-1']);
  });
});
