import { generateText, type LanguageModel } from 'ai';
import { Provider } from './provider.js';
import { v4 as uuidv4 } from 'uuid';
import type { TokenStore } from '@qwery/vector-store';

// Lazy singleton scoped to this process — same pattern as agent-session.ts
let _tokenStore: TokenStore | null = null;
let _storeInitialized = false;
async function getPipelineTokenStore(): Promise<TokenStore | null> {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (_storeInitialized) return _tokenStore;
  _storeInitialized = true;
  try {
    const { TokenStore: TKS } = await import('@qwery/vector-store');
    _tokenStore = new TKS(url);
    await _tokenStore.ensureSchema();
  } catch (err) {
    console.warn('[chatComplete] token store init failed:', err);
    _tokenStore = null;
  }
  return _tokenStore;
}

// Warm up on first import (fire-and-forget)
void getPipelineTokenStore().catch(() => null);

export async function chatComplete(
  prompt: string,
  model?: string | LanguageModel,
): Promise<string> {
  let language: LanguageModel;
  let modelId = 'unknown';
  let providerId = 'ollama-pipeline';

  if (model !== undefined && typeof model !== 'string') {
    language = model;
    // LanguageModel has modelId and provider on the spec object
    modelId = (language as unknown as { modelId?: string }).modelId ?? 'unknown';
    const rawProvider = (language as unknown as { provider?: string }).provider ?? '';
    // "ollama.chat" → "ollama"
    providerId = rawProvider.split('.')[0] || 'ollama-pipeline';
  } else {
    const m = model ? Provider.getModelFromString(model) : Provider.getDefaultModel();
    language = await Provider.getLanguage(m);
    modelId = m.id;
    providerId = m.providerID;
  }

  const t0 = performance.now();
  const { text, usage } = await generateText({
    model: language,
    prompt,
    maxOutputTokens: 2048,
  });
  const ms = (performance.now() - t0).toFixed(0);
  console.info(
    `[chatComplete] model=${modelId} provider=${providerId} took=${ms}ms` +
    ` in=${usage.inputTokens} out=${usage.outputTokens}`,
  );

  // Store pipeline token usage — fire-and-forget
  if ((usage.inputTokens ?? 0) > 0 || (usage.outputTokens ?? 0) > 0) {
    getPipelineTokenStore()
      .then((ts) => {
        if (!ts) return;
        return ts.store({
          id: uuidv4(),
          conversationId: 'pipeline',
          datasourceId: null,
          modelId,
          providerId,
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          reasoningTokens: (usage as { reasoningTokens?: number }).reasoningTokens ?? 0,
          cachedTokens: (usage as { cachedInputTokens?: number }).cachedInputTokens ?? 0,
        });
      })
      .catch((err: unknown) => console.warn('[chatComplete] token store failed:', err));
  }

  return text;
}
