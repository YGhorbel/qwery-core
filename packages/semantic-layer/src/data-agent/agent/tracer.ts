import type { EmitFn, DataAgentPhase } from '../types';

type ResponseWithUsage = {
  usage_metadata?: { input_tokens?: number; output_tokens?: number };
};

type RawWithUsage = {
  raw?: { usage_metadata?: { input_tokens?: number; output_tokens?: number } };
};

function extractTokens(result: unknown): {
  prompt: number;
  completion: number;
  total: number;
} {
  // Structured output (includeRaw: true) — result.raw.usage_metadata
  const withRaw = result as RawWithUsage;
  if (withRaw?.raw?.usage_metadata) {
    const u = withRaw.raw.usage_metadata;
    const prompt = u.input_tokens ?? 0;
    const completion = u.output_tokens ?? 0;
    return { prompt, completion, total: prompt + completion };
  }
  // Plain response — result.usage_metadata
  const withUsage = result as ResponseWithUsage;
  if (withUsage?.usage_metadata) {
    const u = withUsage.usage_metadata;
    const prompt = u.input_tokens ?? 0;
    const completion = u.output_tokens ?? 0;
    return { prompt, completion, total: prompt + completion };
  }
  return { prompt: 0, completion: 0, total: 0 };
}

function extractPreview(result: unknown): string {
  try {
    const r = result as { content?: unknown; parsed?: unknown };
    const content = r?.content ?? r?.parsed;
    if (typeof content === 'string') return content.slice(0, 200);
    return JSON.stringify(content).slice(0, 200);
  } catch {
    return '';
  }
}

function extractToolCallCount(result: unknown): number {
  try {
    const r = result as { tool_calls?: unknown[] };
    return r?.tool_calls?.length ?? 0;
  } catch {
    return 0;
  }
}

export class DataAgentTracer {
  private callCounter = 0;

  constructor(
    private readonly emit: EmitFn,
    private readonly provider: string,
    private readonly model: string,
  ) {}

  async trace<T>(
    phase: DataAgentPhase,
    purpose: string,
    structuredOutput: boolean,
    fn: () => Promise<T>,
    stepId?: number,
  ): Promise<T> {
    const callIndex = this.callCounter++;
    const startedAt = Date.now();

    this.emit({
      type: 'llm_call_start',
      phase,
      callIndex,
      stepId,
      purpose,
      provider: this.provider,
      model: this.model,
      structuredOutput,
    });

    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      const tokens = extractTokens(result);

      this.emit({
        type: 'llm_call_end',
        phase,
        callIndex,
        stepId,
        purpose,
        durationMs,
        promptTokens: tokens.prompt,
        completionTokens: tokens.completion,
        totalTokens: tokens.total,
        responsePreview: extractPreview(result),
        toolCallCount: extractToolCallCount(result),
      });

      return result;
    } catch (err) {
      const durationMs = Date.now() - startedAt;
      this.emit({
        type: 'llm_call_end',
        phase,
        callIndex,
        stepId,
        purpose,
        durationMs,
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        responsePreview: err instanceof Error ? err.message : String(err),
        toolCallCount: 0,
      });
      throw err;
    }
  }
}
