import { fireEvent, render, screen } from '@testing-library/react';
import React, { useCallback } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type SendMessageFn = (
  message: { text: string },
  options?: { body?: Record<string, unknown> },
) => Promise<void>;

type Defaults = {
  model: string;
  webSearch: boolean;
  searchEngine: string;
  datasources: string[];
};

function SuggestionButton({
  text,
  rawSendMessage,
  defaults,
  overrideBody,
}: {
  text: string;
  rawSendMessage: SendMessageFn;
  defaults: Defaults;
  overrideBody?: Record<string, unknown>;
}) {
  const sendMessageWithDefaults = useCallback(
    (
      message: { text: string },
      options?: { body?: Record<string, unknown> },
    ) => {
      const body = options?.body ?? {};
      return rawSendMessage(message, {
        ...options,
        body: {
          ...body,
          model: body.model ?? defaults.model,
          webSearch: body.webSearch ?? defaults.webSearch,
          searchEngine: body.searchEngine ?? defaults.searchEngine,
          datasources: body.datasources ?? defaults.datasources,
        },
      });
    },
    [rawSendMessage, defaults],
  );

  return (
    <button
      data-testid="suggestion-btn"
      data-suggestion-btn="true"
      onClick={() =>
        sendMessageWithDefaults({ text }, { body: overrideBody ?? {} })
      }
    >
      {text}
    </button>
  );
}

function mergeBodyWithDefaults(
  body: Record<string, unknown>,
  defaults: Defaults,
) {
  return {
    ...body,
    model: body.model ?? defaults.model,
    webSearch: body.webSearch ?? defaults.webSearch,
    searchEngine: body.searchEngine ?? defaults.searchEngine,
    datasources: body.datasources ?? defaults.datasources,
  };
}

describe('mergeBodyWithDefaults (sendMessageWithDefaults logic)', () => {
  const defaults: Defaults = {
    model: 'openai/gpt-4o',
    webSearch: true,
    searchEngine: 'google',
    datasources: ['ds-abc'],
  };

  it('injects all defaults when body is empty', () => {
    const result = mergeBodyWithDefaults({}, defaults);
    expect(result.model).toBe('openai/gpt-4o');
    expect(result.webSearch).toBe(true);
    expect(result.searchEngine).toBe('google');
    expect(result.datasources).toEqual(['ds-abc']);
  });

  it('preserves explicit body fields over defaults', () => {
    const result = mergeBodyWithDefaults(
      { model: 'anthropic/claude-3-5-sonnet', webSearch: false },
      defaults,
    );
    expect(result.model).toBe('anthropic/claude-3-5-sonnet');
    expect(result.webSearch).toBe(false);
    expect(result.searchEngine).toBe('google');
    expect(result.datasources).toEqual(['ds-abc']);
  });

  it('spreads additional body fields through', () => {
    const result = mergeBodyWithDefaults({ customField: 'value' }, defaults);
    expect(result.customField).toBe('value');
    expect(result.model).toBe('openai/gpt-4o');
  });
});

describe('suggestion click → body propagation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('injects model, webSearch, searchEngine, datasources into body on click', () => {
    const rawSendMessage = vi.fn().mockResolvedValue(undefined);
    const defaults: Defaults = {
      model: 'openai/gpt-4o',
      webSearch: true,
      searchEngine: 'google',
      datasources: ['ds-abc'],
    };

    render(
      <SuggestionButton
        text="Run a query"
        rawSendMessage={rawSendMessage}
        defaults={defaults}
      />,
    );

    fireEvent.click(screen.getByTestId('suggestion-btn'));

    expect(rawSendMessage).toHaveBeenCalledTimes(1);

    const [message, options] = rawSendMessage.mock.calls[0] as [
      { text: string },
      { body: Record<string, unknown> },
    ];

    expect(message.text).toBe('Run a query');
    expect(options.body.model).toBe('openai/gpt-4o');
    expect(options.body.webSearch).toBe(true);
    expect(options.body.searchEngine).toBe('google');
    expect(options.body.datasources).toEqual(['ds-abc']);
  });

  it('respects explicit body.model override over default', () => {
    const rawSendMessage = vi.fn().mockResolvedValue(undefined);
    const defaults: Defaults = {
      model: 'openai/gpt-4o',
      webSearch: false,
      searchEngine: 'google',
      datasources: [],
    };

    render(
      <SuggestionButton
        text="test"
        rawSendMessage={rawSendMessage}
        defaults={defaults}
        overrideBody={{ model: 'anthropic/claude-3-5-sonnet' }}
      />,
    );

    fireEvent.click(screen.getByTestId('suggestion-btn'));

    const [, options] = rawSendMessage.mock.calls[0] as [
      { text: string },
      { body: Record<string, unknown> },
    ];
    expect(options.body.model).toBe('anthropic/claude-3-5-sonnet');
    expect(options.body.webSearch).toBe(false);
  });
});
