import { chatComplete } from '../llm-client.js';
import type { TraceStore, VectorStore, Embedder, ErrorFixStore, TribalStore } from '@qwery/vector-store';
import { WorkloadHintIndexer } from './workload-hint-indexer.js';

const DISTILLATION_THRESHOLD = 20;
const TRIBAL_THRESHOLD = 3;

const ERROR_CLASSES = [
  'schema_mismatch',
  'filter_error',
  'join_inconsistency',
  'aggregation_misuse',
  'value_mismatch',
  'intent_drift',
  'execution_error',
] as const;

export async function scheduleDistillation(
  datasourceId: string,
  traceStore: TraceStore,
  vectorStore: VectorStore,
  opts?: {
    errorFixStore?: ErrorFixStore;
    tribalStore?: TribalStore;
    embedder?: Embedder;
  },
): Promise<void> {
  const count = await traceStore.countRecent(datasourceId);

  if (count >= DISTILLATION_THRESHOLD) {
    // Synonym distillation — merges query keywords into term_index embeddings
    await traceStore.distill(datasourceId, vectorStore);

    // Workload hint indexing — frequent join/filter patterns from traces
    if (opts?.embedder) {
      try {
        const recentSQL = await traceStore.getRecentSQL(datasourceId, 100);
        const hintIndexer = new WorkloadHintIndexer(vectorStore, opts.embedder);
        await hintIndexer.indexHints(datasourceId, recentSQL);
      } catch (err) {
        console.warn('[workload-hints] indexing failed:', err);
      }
    }
  }

  // Tribal knowledge distillation — generalize error-fix clusters into reusable rules
  if (opts?.errorFixStore && opts?.tribalStore) {
    for (const errorClass of ERROR_CLASSES) {
      try {
        const pairCount = await opts.errorFixStore.countByErrorClass(datasourceId, errorClass);
        if (pairCount >= TRIBAL_THRESHOLD) {
          await distillTribalRule(datasourceId, errorClass, opts.errorFixStore, opts.tribalStore);
        }
      } catch (err) {
        console.warn(`[tribal-knowledge] distillation failed for ${errorClass}:`, err);
      }
    }
  }
}

async function distillTribalRule(
  datasourceId: string,
  errorClass: string,
  errorFixStore: ErrorFixStore,
  tribalStore: TribalStore,
): Promise<void> {
  const pairs = await errorFixStore.getRecentByErrorClass(datasourceId, errorClass, 10);
  if (pairs.length < TRIBAL_THRESHOLD) return;

  const examples = pairs
    .map((p, i) => `Example ${i + 1}:\nEvidence: ${p.evidence}\nFix: ${p.edit_plan}`)
    .join('\n\n');

  const prompt = `You are distilling a pattern from SQL correction examples into a single reusable rule.

Error class: ${errorClass}
Datasource: ${datasourceId}

Correction examples:
${examples}

Write a single concise rule sentence (max 120 characters) that would prevent this type of error in future queries. The rule should be specific and actionable.

Good rule examples:
- "Use driverstandings.points for cumulative season points, not results.points which is per-race only."
- "Always filter status != 'cancelled' when querying orders — this is a mandatory business rule."

Respond with just the rule sentence, nothing else.`;

  try {
    const rule = await chatComplete(
      [{ role: 'user', content: prompt }],
      { maxTokens: 150 },
    );
    const trimmed = rule.trim().replace(/^["']|["']$/g, '');
    if (trimmed.length < 10) return;

    // Extract table names mentioned in the rule
    const tableMatches = trimmed.match(/\b([a-z][a-z0-9_]{2,})\b/g) ?? [];
    const appliesToTables = [...new Set(tableMatches)].slice(0, 5);

    await tribalStore.upsertRule(datasourceId, errorClass, trimmed, appliesToTables, pairs.length);
    console.info(`[tribal-knowledge] distilled rule for ${errorClass}: "${trimmed.slice(0, 60)}..."`);
  } catch (err) {
    console.warn('[tribal-knowledge] LLM distillation call failed:', err);
  }
}
