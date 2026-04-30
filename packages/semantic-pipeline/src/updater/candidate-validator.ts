import type { ArtifactPatcher } from './artifact-patcher.js';
import {
  readCandidates,
  writeCandidates,
  type MeasureCandidate,
} from './artifact-proposals.js';

const MIN_PROMOTION_THRESHOLD = 2;

function isReadyForPromotion(c: MeasureCandidate): boolean {
  if (c.validated || c.rejected) return false;
  if ((c.seenCount ?? 0) < MIN_PROMOTION_THRESHOLD) return false;
  if (!c.label?.trim() || !c.expression) return false;
  // 5-second buffer: if the label was written very recently (same event-loop
  // batch as the promotion check), wait for the next cycle to avoid a race
  // where enrichment and promotion fire in the same tick.
  if (c.labeledAt) {
    const msSinceLabeled = Date.now() - new Date(c.labeledAt).getTime();
    if (msSinceLabeled < 5_000) return false;
  }
  return true;
}

function heuristicValidate(candidate: MeasureCandidate): boolean {
  const expr = candidate.expression ?? '';
  if (!/\b(SUM|COUNT|AVG|MAX|MIN|ROUND|COALESCE)\s*\(/i.test(expr)) return false;
  if (/;|DROP|DELETE|INSERT|UPDATE|CREATE|ALTER/i.test(expr)) return false;
  return expr.trim().length > 0;
}

export async function validateAndPromoteCandidates(
  datasourceId: string,
  patcher: ArtifactPatcher,
  storageDir: string,
): Promise<{ promoted: number; skipped: number }> {
  const candidates = await readCandidates(storageDir, datasourceId);
  const toPromote = candidates.filter(isReadyForPromotion);

  let promoted = 0;
  let skipped = 0;

  for (const candidate of toPromote) {
    if (!heuristicValidate(candidate)) {
      skipped++;
      console.info(
        `[candidate-validator] skipped "${candidate.expression}" — heuristic validation failed`,
      );
      continue;
    }

    const fieldId = `derived.${candidate.label!.toLowerCase().replace(/[^a-z0-9]+/g, '_')}`;

    try {
      await patcher.promoteMeasure(datasourceId, fieldId, {
        label: candidate.label!,
        description: candidate.description ?? `Derived: ${candidate.expression}`,
        sql: candidate.expression,
        filters: candidate.filters ?? [],
        format: candidate.format ?? 'decimal',
        table: candidate.table ?? '',
        synonyms: candidate.synonyms ?? [],
      });
      candidate.validated = true;
      promoted++;
      console.info(
        `[candidate-validator] promoted ${fieldId} for datasource ${datasourceId}`,
      );
    } catch (err) {
      skipped++;
      console.warn(
        `[candidate-validator] promotion failed for "${candidate.expression}":`,
        err,
      );
    }
  }

  if (promoted > 0) {
    await writeCandidates(storageDir, datasourceId, candidates);
  }

  return { promoted, skipped };
}
