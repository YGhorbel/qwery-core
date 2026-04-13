import type { PlanArtifact, StepResult } from '../../types';

export function buildVerifierPrompt(
  plan: PlanArtifact,
  stepResults: StepResult[],
): string {
  const checks =
    plan.acceptanceChecks.length > 0
      ? plan.acceptanceChecks
      : [
          'Results are non-empty',
          'Column names match expected output',
          'No obvious join explosion (row count is reasonable)',
        ];

  const resultsSummary = stepResults
    .map((r) => {
      const lines: string[] = [`Step ${r.stepId}: ${r.description}`];
      if (r.sqlResult) {
        lines.push(`SQL rows: ${r.sqlResult.rowCount}`);
        lines.push(`Columns: ${r.sqlResult.columns.join(', ')}`);
        const previewLines = r.sqlResult.data
          .split('\n')
          .slice(0, 12)
          .join('\n');
        lines.push(`Sample:\n${previewLines}`);
      }
      if (r.pythonResult) {
        lines.push(`Python stdout: ${r.pythonResult.stdout.slice(0, 500)}`);
      }
      if (r.error) lines.push(`ERROR: ${r.error}`);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  return `You are the Verifier node of a data analytics agent. Write Python code to verify query results.

## Acceptance checks to verify
${checks.map((c, i) => `${i + 1}. ${c}`).join('\n')}

## Query results
${resultsSummary}

## Instructions

Write Python code that:
1. Checks each acceptance criterion
2. Prints a single JSON line to stdout:
   {"passed": true/false, "checks": [{"name": "...", "passed": true/false, "message": "..."}]}

## Focus on detecting
- Join explosion: row count much higher than expected
- Empty results when data should exist
- NULL values in key columns
- Unreasonable aggregation values (e.g. negative counts, impossibly large sums)
- Missing expected columns
- Completeness issues (e.g. time series with gaps)

Return only the Python code.`;
}
