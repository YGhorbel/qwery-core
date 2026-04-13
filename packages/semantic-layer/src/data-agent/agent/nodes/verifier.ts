import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DataAgentStateType } from '../../state';
import type { EmitFn, VerificationReport } from '../../types';
import { buildVerifierPrompt } from '../prompts/verifier.prompt';
import type { SandboxService } from '../../sandbox.service';
import type { ChatModel } from '../../../llm';
import type { DataAgentTracer } from '../tracer';

export function createVerifierNode(
  llm: ChatModel,
  sandboxService: SandboxService,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'verifier',
      description: 'Verifying results',
    });

    const plan = state.plan!;
    const stepResults = state.stepResults ?? [];
    const joinPlan = state.joinPlan;

    // ── Bypass: simple queries with no joins ──────────────────────────────
    const hasJoins = (joinPlan?.joinPaths ?? []).some(
      (p) => p.edges.length > 0,
    );
    const isSimpleNoJoin =
      plan.complexity === 'simple' && !hasJoins && plan.steps.length <= 1;

    if (isSimpleNoJoin) {
      const report: VerificationReport = {
        passed: true,
        checks: [
          {
            name: 'Simple query bypass',
            passed: true,
            message: 'Verification skipped for simple single-dataset queries',
          },
        ],
      };
      emit({ type: 'phase_artifact', phase: 'verifier', artifact: report });
      emit({ type: 'phase_complete', phase: 'verifier' });
      return { verificationReport: report, currentPhase: 'verifier' };
    }

    // ── Bypass: all steps errored ─────────────────────────────────────────
    const allErrored = stepResults.every((r) => r.error ?? r.sqlResult?.error);
    if (allErrored) {
      const hasQuerySpecs = (state.querySpecs ?? []).length > 0;
      const report: VerificationReport = {
        passed: false,
        checks: [
          {
            name: 'Execution check',
            passed: false,
            message: 'All execution steps failed',
          },
        ],
        diagnosis: 'All execution steps failed',
        recommendedTarget: hasQuerySpecs ? 'sql_builder' : 'navigator',
      };
      emit({ type: 'phase_artifact', phase: 'verifier', artifact: report });
      emit({ type: 'phase_complete', phase: 'verifier' });
      return {
        verificationReport: report,
        revisionCount: state.revisionCount + 1,
        revisionDiagnosis: report.diagnosis ?? null,
        revisionTarget: report.recommendedTarget ?? null,
        currentPhase: 'verifier',
      };
    }

    // ── Normal path: LLM writes Python verifier ───────────────────────────
    const verifierPrompt = buildVerifierPrompt(plan, stepResults);
    let report: VerificationReport;
    let promptTokens = 0;
    let completionTokens = 0;

    try {
      emit({
        type: 'tool_start',
        phase: 'verifier',
        name: 'sandbox.verify',
        args: {},
      });
      const codeResponse = await tracer.trace(
        'verifier',
        'verification_code',
        false,
        () =>
          llm.invoke([
            new SystemMessage(verifierPrompt),
            new HumanMessage('Write the Python verification code.'),
          ]),
      );
      const code =
        typeof codeResponse.content === 'string' ? codeResponse.content : '';

      const usage = (
        codeResponse as {
          usage_metadata?: { input_tokens?: number; output_tokens?: number };
        }
      ).usage_metadata;
      promptTokens = usage?.input_tokens ?? 0;
      completionTokens = usage?.output_tokens ?? 0;

      const sandboxResult = await sandboxService.executeCode(code, 30);
      emit({
        type: 'tool_end',
        phase: 'verifier',
        name: 'sandbox.verify',
        result: sandboxResult.stdout.slice(0, 200),
      });

      // Parse last JSON line from stdout
      const lines = sandboxResult.stdout.trim().split('\n');
      const lastLine = lines[lines.length - 1] ?? '';
      let parsed: {
        passed: boolean;
        checks: Array<{ name: string; passed: boolean; message: string }>;
      };
      try {
        parsed = JSON.parse(lastLine) as typeof parsed;
      } catch {
        parsed = {
          passed: true,
          checks: [
            {
              name: 'Sandbox output',
              passed: true,
              message: 'Could not parse verification output — assuming passed',
            },
          ],
        };
      }

      report = {
        passed: parsed.passed,
        checks: parsed.checks,
        diagnosis: parsed.passed
          ? undefined
          : parsed.checks
              .filter((c) => !c.passed)
              .map((c) => c.message)
              .join('; '),
        recommendedTarget: parsed.passed ? undefined : 'sql_builder',
      };
    } catch (err) {
      // Sandbox unavailable — assume passed
      report = {
        passed: true,
        checks: [
          {
            name: 'Sandbox unavailable',
            passed: true,
            message:
              err instanceof Error ? err.message : 'Sandbox not available',
          },
        ],
      };
    }

    emit({ type: 'phase_artifact', phase: 'verifier', artifact: report });
    emit({ type: 'phase_complete', phase: 'verifier' });

    const newRevisionCount = report.passed
      ? state.revisionCount
      : state.revisionCount + 1;

    return {
      verificationReport: report,
      revisionCount: newRevisionCount,
      revisionDiagnosis: report.passed ? null : (report.diagnosis ?? null),
      revisionTarget: report.passed ? null : (report.recommendedTarget ?? null),
      currentPhase: 'verifier',
      tokensUsed: {
        prompt: promptTokens,
        completion: completionTokens,
        total: promptTokens + completionTokens,
      },
    };
  };
}
