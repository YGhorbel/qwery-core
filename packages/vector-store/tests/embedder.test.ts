import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Embedder } from '../src/embedder.js';

const FAKE_VECTOR = Array.from({ length: 768 }, (_, i) => i / 768);

function mockFetch(response: object, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: () => Promise.resolve(response),
  });
}

describe('Embedder (Ollama)', () => {
  let originalFetch: typeof globalThis.fetch;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    originalEnv = { ...process.env };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('applies search_document: prefix when calling embedDocument', async () => {
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedDocument('Total Revenue');

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.prompt).toBe('search_document: Total Revenue');
  });

  it('applies search_query: prefix when calling embedQuery', async () => {
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedQuery('revenue');

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.prompt).toBe('search_query: revenue');
  });

  it('constructs the URL from OLLAMA_BASE_URL', async () => {
    process.env.OLLAMA_BASE_URL = 'http://my-ollama-host:11434';
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedDocument('test');

    expect(spy.mock.calls[0]![0]).toBe('http://my-ollama-host:11434/api/embeddings');
  });

  it('uses the model name from OLLAMA_EMBEDDING_MODEL', async () => {
    process.env.OLLAMA_EMBEDDING_MODEL = 'custom-embed-model';
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedDocument('test');

    const body = JSON.parse((spy.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.model).toBe('custom-embed-model');
  });

  it('embedBatch with document mode applies search_document: to all texts', async () => {
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedBatch(['Revenue', 'Country'], 'document');

    const prompts = spy.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).prompt,
    );
    expect(prompts).toEqual([
      'search_document: Revenue',
      'search_document: Country',
    ]);
  });

  it('embedBatch with query mode applies search_query: to all texts', async () => {
    const spy = mockFetch({ embedding: FAKE_VECTOR });
    globalThis.fetch = spy;

    const embedder = new Embedder();
    await embedder.embedBatch(['revenue', 'country'], 'query');

    const prompts = spy.mock.calls.map(
      (call) => JSON.parse((call[1] as RequestInit).body as string).prompt,
    );
    expect(prompts).toEqual([
      'search_query: revenue',
      'search_query: country',
    ]);
  });

  it('throws a clear error when Ollama is not reachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

    const embedder = new Embedder();
    await expect(embedder.embedQuery('test')).rejects.toThrow(
      'Ollama is not running at http://localhost:11434 — start it with: ollama serve',
    );
  });

  it('throws a clear error on non-200 HTTP response', async () => {
    globalThis.fetch = mockFetch({ error: 'model not found' }, false, 404);

    const embedder = new Embedder();
    await expect(embedder.embedDocument('test')).rejects.toThrow(
      'Ollama is not running at http://localhost:11434 — start it with: ollama serve (HTTP 404)',
    );
  });
});
