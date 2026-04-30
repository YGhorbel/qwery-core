const DEFAULT_BASE_URL = 'http://localhost:11434/v1';
const DEFAULT_MODEL = 'qwen3-embedding:8b';

type OpenAIEmbeddingResponse = {
  data: Array<{ embedding: number[] }>;
};

export class Embedder {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey: string;

  constructor() {
    this.baseUrl = (process.env.OLLAMA_EMBEDDING_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.model = process.env.OLLAMA_EMBEDDING_MODEL ?? DEFAULT_MODEL;
    this.apiKey = process.env.OLLAMA_API_KEY ?? '';
  }

  private async callEmbeddings(text: string): Promise<number[]> {
    const url = `${this.baseUrl}/embeddings`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({ model: this.model, input: text }),
      });
    } catch {
      throw new Error(`Embedding endpoint unreachable at ${this.baseUrl}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Embedding request failed (HTTP ${res.status}): ${body}`);
    }
    const data = (await res.json()) as OpenAIEmbeddingResponse;
    const embedding = data.data?.[0]?.embedding;
    if (!embedding) throw new Error('Empty embedding response');
    return embedding;
  }

  /** Embed a field definition for indexing. */
  async embedDocument(text: string): Promise<number[]> {
    return this.callEmbeddings(`Represent this database field definition for semantic retrieval: ${text}`);
  }

  /** Embed a user search query. */
  async embedQuery(text: string): Promise<number[]> {
    return this.callEmbeddings(`Retrieve database fields relevant to this business question: ${text}`);
  }

  /** Batch embed texts sequentially to avoid overwhelming the local Ollama server. */
  async embedBatch(texts: string[], mode: 'document' | 'query'): Promise<number[][]> {
    const results: number[][] = [];
    for (const t of texts) {
      results.push(await (mode === 'document' ? this.embedDocument(t) : this.embedQuery(t)));
    }
    return results;
  }
}
