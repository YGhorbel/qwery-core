import type { ArtifactPatcher } from './artifact-patcher.js';

type QueryTrace = {
  datasourceId: string;
  fieldsUsed: Array<{ field_id: string }>;
};

// Matches the actual CorrectionTrace shape from error-classifier.ts
type CorrectionResult = {
  classified: {
    errorClass: string;
    suggestedFix: string;
  };
  editPlan?: string;
  correctedSQL?: string;
};

function extractFilterFromPlan(plan: string): string | null {
  const match = plan.match(/(?:add\s+)?where\s+([^.;\n]+)/i);
  return match ? match[1]!.trim() : null;
}

function extractSQLFromPlan(plan: string): string | null {
  const match = plan.match(/([a-z_][a-z0-9_.()'"*\s]+AS\s+\w+)/i);
  return match ? match[1]!.trim() : null;
}

export async function processSuccessfulQuery(
  trace: QueryTrace,
  correction: CorrectionResult | null,
  patcher: ArtifactPatcher,
): Promise<void> {
  if (!correction) return;

  const { datasourceId } = trace;
  const firstFieldId = trace.fieldsUsed[0]?.field_id;
  if (!firstFieldId) return;

  const errorClass = correction.classified.errorClass;
  // editPlan has numbered steps; suggestedFix from classification is the raw hint
  const planText = correction.editPlan ?? correction.classified.suggestedFix ?? '';

  console.info(`[artifact-self-update] processing ${errorClass} for field ${firstFieldId}`);

  switch (errorClass) {
    case 'filter_error': {
      const filter = extractFilterFromPlan(planText);
      if (filter) {
        await patcher.patchMissingFilter(datasourceId, firstFieldId, filter);
        console.info(`[artifact-self-update] patched filter "${filter}" onto ${firstFieldId}`);
      }
      break;
    }

    case 'schema_mismatch': {
      const correctedSQL =
        correction.correctedSQL ?? extractSQLFromPlan(planText);
      if (correctedSQL) {
        await patcher.patchWrongExpression(datasourceId, firstFieldId, correctedSQL);
        console.info(`[artifact-self-update] patched SQL expression for ${firstFieldId}`);
      }
      break;
    }

    case 'intent_drift': {
      await patcher.downgradeConfidence(datasourceId, firstFieldId);
      console.info(`[artifact-self-update] downgraded confidence for ${firstFieldId}`);
      break;
    }
  }
}

export async function processNewDerivedExpression(
  datasourceId: string,
  expression: string,
  question: string,
  rows: unknown[],
  patcher: ArtifactPatcher,
): Promise<void> {
  await patcher.proposeDerivedMeasure(datasourceId, expression, question, rows);
}
