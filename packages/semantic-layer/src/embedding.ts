// Lazy-loaded pipeline to avoid startup cost

let embedder:
  | ((
      text: string,
      opts: { pooling: 'mean'; normalize: boolean },
    ) => Promise<{ data: Float32Array }>)
  | null = null;

async function getEmbedder() {
  if (!embedder) {
    // Dynamic import so the heavy model only loads when first needed
    const { pipeline } = await import('@xenova/transformers');
    const pipe = await pipeline(
      'feature-extraction',
      'Xenova/all-MiniLM-L6-v2',
    );
    embedder = pipe as unknown as NonNullable<typeof embedder>;
  }
  return embedder!;
}

export const EMBEDDING_DIMENSIONS = 384;

export async function generateEmbedding(text: string): Promise<number[]> {
  const pipe = await getEmbedder();
  const output = await pipe(text, { pooling: 'mean', normalize: true });
  return Array.from(output.data);
}

export async function generateEmbeddings(texts: string[]): Promise<number[][]> {
  return Promise.all(texts.map((t) => generateEmbedding(t)));
}

export function datasetEmbeddingText(
  dataset: {
    name: string;
    label?: string;
    description?: string;
    ai_context?: unknown;
  },
  opts?: { conceptName?: string; extractedRelations?: string[] },
): string {
  const synonyms =
    dataset.ai_context &&
    typeof dataset.ai_context === 'object' &&
    'synonyms' in dataset.ai_context &&
    Array.isArray((dataset.ai_context as { synonyms: unknown }).synonyms)
      ? (dataset.ai_context as { synonyms: string[] }).synonyms.join(' ')
      : '';

  const relations = Array.isArray(opts?.extractedRelations)
    ? opts?.extractedRelations.join(' ')
    : '';
  const concept = opts?.conceptName ? `Category: ${opts.conceptName}` : '';

  return [
    dataset.name,
    dataset.label ?? '',
    dataset.description ?? '',
    synonyms,
    relations,
    concept,
  ]
    .filter(Boolean)
    .join(' ');
}
