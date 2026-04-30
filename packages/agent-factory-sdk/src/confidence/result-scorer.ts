export type ConfidenceSignal = {
  score: number;
  flags: string[];
  shouldHedge: boolean;
};

type ScoringOpts = {
  correctionApplied: boolean;
  correctionSucceeded: boolean;
  pathAgreement: boolean;
};

export function scoreResult(
  result: { columns: string[]; rows: unknown[] },
  opts: ScoringOpts,
): ConfidenceSignal {
  let score = 1.0;
  const flags: string[] = [];

  const rows = result.rows ?? [];
  const columns = result.columns ?? [];

  if (rows.length === 0) {
    flags.push('empty_result');
    score -= 0.4;
  }

  if (rows.length === 1 && columns.some((c) => /sum|count|total|avg|average/i.test(c))) {
    flags.push('single_row_aggregation');
    score -= 0.1;
  }

  if (rows.length > 5000) {
    flags.push('massive_result');
    score -= 0.15;
  }

  if (rows.length > 0) {
    for (const col of columns) {
      const allNull = (rows as Record<string, unknown>[]).every((r) => r[col] == null);
      if (allNull) {
        flags.push('all_null_column');
        score -= 0.2;
        break;
      }
    }

    // Suspiciously large single numeric value (e.g. a COUNT that returned billions)
    if (rows.length === 1 && columns.length === 1) {
      const val = (rows[0] as Record<string, unknown>)[columns[0]!];
      if (typeof val === 'number' && val > 1e12) {
        flags.push('suspiciously_large_sum');
        score -= 0.2;
      }
    }
  }

  if (opts.correctionApplied && !opts.correctionSucceeded) {
    flags.push('correction_failed');
    score -= 0.25;
  }

  if (!opts.pathAgreement) {
    flags.push('path_disagreement');
    score -= 0.1;
  }

  score = Math.max(0, Math.min(1, score));

  return {
    score,
    flags,
    shouldHedge: score < 0.5,
  };
}
