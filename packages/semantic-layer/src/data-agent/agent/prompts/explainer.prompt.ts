import type { PlanArtifact, StepResult, VerificationReport } from '../../types';

export function buildExplainerPrompt(
  userQuestion: string,
  plan: PlanArtifact,
  stepResults: StepResult[],
  verificationReport: VerificationReport | null,
  conversationContext: string,
): string {
  const resultsSummary = stepResults
    .map((r) => {
      const lines: string[] = [`### Step ${r.stepId}: ${r.description}`];
      if (r.sqlResult) {
        lines.push(`Rows: ${r.sqlResult.rowCount}`);
        lines.push(`\`\`\`\n${r.sqlResult.data}\n\`\`\``);
      }
      if (r.pythonResult?.stdout)
        lines.push(`Output:\n${r.pythonResult.stdout}`);
      if (r.error) lines.push(`⚠️ Error: ${r.error}`);
      return lines.join('\n');
    })
    .join('\n\n');

  const verificationNote = verificationReport
    ? verificationReport.passed
      ? '✅ Results passed verification.'
      : `⚠️ Verification failed: ${verificationReport.diagnosis ?? 'unknown issue'}. Results may be approximate.`
    : '';

  const ambiguities =
    plan.ambiguities.length > 0
      ? '\n\n**Assumptions made:**\n' +
        plan.ambiguities
          .map((a) => `- ${a.question}: ${a.assumption}`)
          .join('\n')
      : '';

  return `You are the Explainer node of a data analytics agent. Write a clear, direct answer to the user's question.

## User question
${userQuestion}

## Conversation context
${conversationContext || '(no prior context)'}

## Query results
${resultsSummary || '(no results)'}

${verificationNote}

## Instructions
1. Answer the user's question directly and concisely in the first sentence.
2. Use a markdown table if the data has multiple rows/columns.
3. For numbers, use appropriate formatting (commas, %, currency if evident from context).
4. Reference chart numbers if charts were produced (e.g. "as shown in Chart 1").
5. Keep the explanation brief — the data speaks for itself.
6. Add caveats only if verification failed or data quality issues were detected.${ambiguities}`;
}

export function buildConversationalPrompt(
  userQuestion: string,
  plan: PlanArtifact,
  conversationContext: string,
  datasetDetails?: Array<{ name: string; description: string; source: string }>,
): string {
  const datasetsSection =
    datasetDetails && datasetDetails.length > 0
      ? '\n## Available datasets\n' +
        datasetDetails
          .map((d) => `- **${d.name}** (${d.source}): ${d.description}`)
          .join('\n')
      : '';

  return `You are a helpful data analytics assistant. Answer the user's question conversationally — no SQL or data queries are needed.

## User question
${userQuestion}

## Intent
${plan.intent}

## Conversation context
${conversationContext || '(no prior context)'}${datasetsSection}

Respond clearly and helpfully. If the user is asking what data is available, list the datasets above.`;
}
