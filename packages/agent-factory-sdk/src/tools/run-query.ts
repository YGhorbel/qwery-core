import { z } from 'zod';
import { Tool } from './tool';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import { ExportFilenameSchema, RunQueryResultSchema } from './schema';
import {
  classify,
  isResultSuspect,
  storeCorrectionTrace,
  type ClassifiedError,
  type QueryResult,
  type MinimalSemanticLayer,
  type CorrectionTrace,
} from '../correction/error-classifier.js';
import {
  generateCorrectionPlan,
  type SemanticLayerShape,
} from '../correction/correction-planner.js';
import type { QueryPlan } from '../planning/intent-classifier.js';
import type { ResolvedField } from './get-semantic-context.js';
import { runMultiPath } from '../multipath/multi-path-runner.js';
import type { JoinDef } from '../multipath/sql-generator.js';
import { scoreResult } from '../confidence/result-scorer.js';
import type { ErrorFixStore } from '@qwery/vector-store';
import { validateAndFixSQL } from '../validation/sql-schema-validator.js';
import { verifyIntent } from '../verification/intent-verifier.js';
import { chatComplete } from '../llm/chat.js';
import { routeModel, extractR1Response } from '../llm/model-router.js';

const MAX_CORRECTION_ROUNDS = 2;

const DESCRIPTION = `Run a SQL query directly against a single datasource using its native driver. When calling this tool, provide an exportFilename (short descriptive name for the table export, e.g. machines-active-status).`;

export const RunQueryTool = Tool.define('runQuery', {
  description: DESCRIPTION,
  parameters: z.object({
    datasourceId: z
      .string()
      .describe('The ID of the datasource to run the query against'),
    query: z.string().describe('The SQL query to execute'),
    exportFilename: ExportFilenameSchema.describe(
      'Short filename for the table export (lowercase, hyphens; e.g. machines-active-status)',
    ),
  }),
  async execute(params, ctx) {
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    const logger = await getLogger();
    const { datasourceId, query, exportFilename } = params;

    logger.debug('[RunQueryToolV2] Tool execution:', {
      queryLength: query.length,
      queryPreview: query.substring(0, 100),
      datasourceId,
    });

    const startTime = performance.now();

    const resolvedId = attachedDatasources[0] ?? datasourceId ?? '';
    const datasource = await repositories.datasource.findById(resolvedId);
    if (!datasource) {
      throw new Error(`Datasource not found: ${resolvedId}`);
    }

    const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
      | DatasourceExtension
      | undefined;

    if (!extension?.drivers?.length) {
      throw new Error(
        `No driver found for provider: ${datasource.datasource_provider}`,
      );
    }

    const nodeDriver =
      extension.drivers.find((d) => d.runtime === 'node') ??
      extension.drivers[0];

    if (!nodeDriver) {
      throw new Error(
        `No node driver for provider: ${datasource.datasource_provider}`,
      );
    }

    // Reuse driver instance within the same conversation turn (sharedExtra persists across tool calls).
    const extra = ctx.extra as Record<string, unknown>;
    const driverCacheKey = `__driver_${resolvedId}`;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let instance: any = extra[driverCacheKey];
    if (!instance) {
      instance = await getDriverInstance(nodeDriver, { config: datasource.config });
      extra[driverCacheKey] = instance;
    }
    const semanticLayer =
      (extra.lastSemanticLayer as MinimalSemanticLayer) ?? {};
    const lastQuestion = (extra.lastQuestion as string) ?? '';
    const queryPlan = extra.lastQueryPlan as QueryPlan | undefined;
    const resolvedFields = (extra.lastResolvedFields as ResolvedField[]) ?? [];
    const resolvedJoins = (extra.lastResolvedJoins as JoinDef[]) ?? [];
    const businessRules = (extra.lastBusinessRules as string[]) ?? [];
    const errorFixStore = extra.errorFixStore as ErrorFixStore | undefined;

    // executionDriver is the driver used by the correction loop below.
    // Multi-path closes `instance` itself; on failure it re-acquires a fresh one.
    let executionDriver = instance;

    // Multi-path only for true multi-hop queries (complexity 3).
    // complexity 2 (aggregation/comparison/calculation) uses agent SQL + correction loop — faster and accurate enough.
    if (queryPlan && queryPlan.complexity >= 3 && resolvedFields.length > 0) {
      try {
        const { sql: winnerSQL, result: winnerResult, path } = await runMultiPath(
          lastQuestion,
          query,
          queryPlan,
          resolvedFields,
          resolvedJoins,
          businessRules,
          instance,
          null, // episodic memory — wired in skill 6
          resolvedId,
        );


        logger.info(
          `[RunQueryToolV2] multi-path winner: path ${path} (complexity=${queryPlan.complexity}, intent=${queryPlan.intent})`,
        );

        const totalTime = performance.now() - startTime;
        logger.debug(`[RunQueryToolV2] [PERF] runQuery TOTAL took ${totalTime.toFixed(2)}ms`);

        if (extra.lastRunQueryResult) {
          (extra.lastRunQueryResult as { current: typeof winnerResult }).current =
            winnerResult;
        }

        return RunQueryResultSchema.parse({
          result: { columns: winnerResult.columns ?? [], rows: winnerResult.rows ?? [] },
          sqlQuery: winnerSQL,
          executed: true,
          correctionApplied: false,
          emptyResult: (winnerResult.rows ?? []).length === 0,
          ...(exportFilename && { exportFilename }),
        });
      } catch (err) {
        logger.warn({ err }, '[RunQueryToolV2] Multi-path failed, falling back to correction loop');
        // Re-acquire fresh instance only if multi-path destroyed the cached one
        instance = await getDriverInstance(nodeDriver, { config: datasource.config });
        extra[driverCacheKey] = instance;
        executionDriver = instance;
      }
      // Falls through to correction loop below
    }

    let currentSQL = query;
    let correctionTrace: CorrectionTrace | null = null;
    let finalResult: { columns: string[]; rows: unknown[] } | null = null;
    let semanticCheckDone = false;

    // Pre-execution schema validation — deterministic, no LLM cost
    const storageDir = process.env.QWERY_STORAGE_DIR ?? '';
    try {
      const { fixedSQL, corrections, unresolvableColumns } = await validateAndFixSQL(
        currentSQL,
        resolvedId,
        storageDir,
      );
      if (corrections.length > 0) {
        logger.info(
          `[schema-validator] Auto-corrected ${corrections.length} column(s): ${corrections.join(', ')}`,
        );
        currentSQL = fixedSQL;
      }
      if (unresolvableColumns.length > 0) {
        logger.warn(
          `[schema-validator] Unresolvable columns: ${unresolvableColumns.join(', ')} — flagging as schema_mismatch`,
        );
        // Pre-seed the correction trace so the planner knows the error class immediately
        correctionTrace = {
          classified: {
            errorClass: 'schema_mismatch',
            confidence: 'high' as const,
            evidence: `Unknown column(s): ${unresolvableColumns.join(', ')}`,
            suggestedFix: `Replace with actual column names from schema`,
          },
          editPlan: `Fix column references: ${unresolvableColumns.join(', ')}`,
          correctedSQL: currentSQL,
          success: false,
        };
      }
    } catch (validationErr) {
      logger.warn(
        { err: validationErr },
        '[schema-validator] Validation skipped (non-fatal)',
      );
    }

    try {
      for (let round = 0; round <= MAX_CORRECTION_ROUNDS; round++) {
        let queryResult: QueryResult;

        try {
          const rawResult = await executionDriver.query(currentSQL);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const columnNames = rawResult.columns.map((col: any) =>
            typeof col === 'string' ? col : (col as { name: string }).name || String(col),
          );
          queryResult = { columns: columnNames, rows: rawResult.rows };
        } catch (err) {
          queryResult = {
            error: err instanceof Error ? err.message : String(err),
            hint: (err as { hint?: string }).hint ?? undefined,
          };
        }

        const isError = !!queryResult.error;
        const isSuspect = !isError && isResultSuspect(queryResult);

        if (!isError && !isSuspect) {
          // ── Intent verification — semantic faithfulness check ──────────────
          // Runs once (round 0) after the first clean execution. Checks that
          // the result actually answers the question (e.g. no MAX/MIN swap,
          // no missing GROUP BY, correct sort direction).
          if (round === 0 && !semanticCheckDone && queryPlan && lastQuestion) {
            semanticCheckDone = true;
            try {
              const verification = await verifyIntent({
                question: lastQuestion,
                plan: queryPlan,
                sql: currentSQL,
                result: queryResult,
              });

              if (!verification.pass) {
                logger.info(
                  `[intent-verifier] Semantic mismatch → ${verification.errorClass}: ${verification.evidence} (confidence: ${(verification.confidence * 100).toFixed(0)}%)`,
                );

                // Generate a semantic correction and re-run in the next round
                const _correctionT0 = performance.now();
                const { editPlan, correctedSQL } = await generateCorrectionPlan(
                  lastQuestion,
                  currentSQL,
                  {
                    errorClass: verification.errorClass,
                    confidence: verification.confidence >= 0.8 ? 'high' : verification.confidence >= 0.6 ? 'medium' : 'low',
                    evidence: verification.evidence,
                    suggestedFix: verification.suggestedFix,
                  },
                  semanticLayer as SemanticLayerShape,
                  queryPlan.cotPlan ?? null,
                  resolvedId,
                  errorFixStore,
                ).catch(() => ({ editPlan: '', correctedSQL: currentSQL }));
                logger.info(`[RunQueryToolV2] [PERF] semantic correction plan took ${(performance.now() - _correctionT0).toFixed(0)}ms (model=OLLAMA_REASONING_MODEL)`);

                if (correctedSQL && correctedSQL !== currentSQL) {
                  correctionTrace = {
                    classified: {
                      errorClass: verification.errorClass,
                      confidence: verification.confidence >= 0.8 ? 'high' : verification.confidence >= 0.6 ? 'medium' : 'low',
                      evidence: `[semantic] ${verification.evidence}`,
                      suggestedFix: verification.suggestedFix,
                    },
                    editPlan,
                    correctedSQL,
                    success: false,
                  };
                  currentSQL = correctedSQL;
                  logger.info(
                    `[intent-verifier] Semantic correction queued: "${editPlan.slice(0, 80)}"`,
                  );
                  continue; // re-execute with corrected SQL in next round
                }
                // Correction planner returned unchanged SQL — fall through to finalResult
                logger.warn('[intent-verifier] Semantic correction unchanged — passing result through');
              }
            } catch (verifyErr) {
              logger.warn({ err: verifyErr }, '[intent-verifier] Verification skipped (non-fatal)');
            }
          }

          finalResult = {
            columns: queryResult.columns!,
            rows: queryResult.rows!,
          };
          if (correctionTrace) {
            correctionTrace.success = true;
            storeCorrectionTrace(ctx, correctionTrace);
            // Store the successful error-fix pair for future few-shot injection
            if (errorFixStore && lastQuestion) {
              errorFixStore.store({
                id: crypto.randomUUID(),
                datasource_id: resolvedId,
                question: lastQuestion,
                failed_sql: correctionTrace.correctedSQL !== currentSQL
                  ? query
                  : correctionTrace.correctedSQL,
                error_class: correctionTrace.classified.errorClass,
                evidence: correctionTrace.classified.evidence,
                edit_plan: correctionTrace.editPlan,
                corrected_sql: currentSQL,
              }).catch((err: unknown) =>
                logger.warn({ err }, '[ErrorFixStore] store failed'),
              );
              logger.info(`[ErrorFixStore] stored pair for error class: ${correctionTrace.classified.errorClass}`);
            }
          }
          break;
        }

        if (round === MAX_CORRECTION_ROUNDS) {
          if (correctionTrace) storeCorrectionTrace(ctx, correctionTrace);
          if (isError) throw new Error(queryResult.error!);
          // suspect result — return as-is rather than failing
          finalResult = {
            columns: queryResult.columns ?? [],
            rows: queryResult.rows ?? [],
          };
          break;
        }

        // Deterministic fix: PostgreSQL hint says exactly which column to use — no LLM needed
        if (queryResult.hint) {
          const hintMatch = queryResult.hint.match(/Perhaps you meant.*?"([\w.]+)"/i);
          const failedMatch = queryResult.error?.match(/column\s+"([\w.]+)"\s+does not exist/i);
          if (hintMatch?.[1] && failedMatch?.[1]) {
            const suggested = hintMatch[1];
            const failed = failedMatch[1];
            const fixedSQL = currentSQL.replaceAll(failed, suggested);
            logger.info(
              `[RunQueryToolV2] Deterministic hint fix: "${failed}" → "${suggested}"`,
            );
            correctionTrace = {
              classified: {
                errorClass: 'schema_mismatch',
                confidence: 'high',
                evidence: `column "${failed}" does not exist`,
                suggestedFix: `Replace with "${suggested}" per PostgreSQL hint`,
              },
              editPlan: `Replace "${failed}" with "${suggested}" (PostgreSQL hint)`,
              correctedSQL: fixedSQL,
              success: false,
            };
            currentSQL = fixedSQL;
            continue;
          }
        }

        // Classify: heuristic first (no LLM cost), then LLM fallback via classify()
        let classified: ClassifiedError;
        try {
          classified = await classify({
            question: lastQuestion,
            sql: currentSQL,
            result: queryResult,
            semanticLayer,
            cotPlan: queryPlan?.cotPlan ?? null,
            fieldsUsed: resolvedFields,
          });
        } catch {
          if (isError) throw new Error(queryResult.error!);
          finalResult = {
            columns: queryResult.columns ?? [],
            rows: queryResult.rows ?? [],
          };
          break;
        }

        const _planT0 = performance.now();
        const { editPlan, correctedSQL } = await generateCorrectionPlan(
          lastQuestion,
          currentSQL,
          classified,
          semanticLayer as SemanticLayerShape,
          null,
          resolvedId,
          errorFixStore,
        ).catch(() => ({ editPlan: '', correctedSQL: currentSQL }));

        correctionTrace = { classified, editPlan, correctedSQL, success: false };
        currentSQL = correctedSQL || currentSQL;

        logger.info(
          `[RunQueryToolV2] Correction round ${round + 1}: ${classified.errorClass} — "${editPlan.slice(0, 80)}" [${(performance.now() - _planT0).toFixed(0)}ms, model=OLLAMA_REASONING_MODEL]`,
        );
      }
    } finally {
      // Driver is cached in sharedExtra for reuse — do not close it here.
    }

    if (!finalResult) throw new Error('Query execution failed after corrections');

    // ── Empty-result retry loop ─────────────────────────────────────────────
    // Correction loop handles SQL errors. This loop handles a different problem:
    // the SQL ran cleanly but returned 0 rows. The reasoning model suggests
    // progressively looser alternative strategies (relax filter → broaden scope
    // → probe for existence). Runs entirely inside the tool — no model capability
    // required from the agent driving the session.
    const MAX_EMPTY_RETRIES = 2;
    if (finalResult.rows.length === 0 && lastQuestion) {
      for (let emptyRound = 0; emptyRound < MAX_EMPTY_RETRIES; emptyRound++) {
        logger.info(
          `[RunQueryToolV2] empty-result retry ${emptyRound + 1}/${MAX_EMPTY_RETRIES}`,
        );
        try {
          const altPrompt = `A SQL query returned 0 rows. Rewrite it with a different strategy that is more likely to return data.

Question: "${lastQuestion}"

Failed SQL (returned 0 rows):
${currentSQL}

Intent: ${queryPlan?.cotPlan ?? queryPlan?.intent ?? 'N/A'}

Pick exactly ONE strategy for this retry attempt (attempt ${emptyRound + 1} of ${MAX_EMPTY_RETRIES}):
${emptyRound === 0
  ? '- Remove or relax the most restrictive WHERE condition (exact match → LIKE, specific date → broader range, named value → remove the filter entirely)'
  : '- Try a completely different approach: different table, remove a JOIN that may exclude rows, or run SELECT DISTINCT / COUNT(*) on the key column to confirm data exists'}

Output ONLY the SQL. No explanation, no markdown fences.`;

          const _retryT0 = performance.now();
          const raw = await chatComplete(altPrompt, routeModel('reasoning'));
          logger.info(`[RunQueryToolV2] [PERF] empty-result retry LLM took ${(performance.now() - _retryT0).toFixed(0)}ms (model=OLLAMA_REASONING_MODEL)`);
          const { answer } = extractR1Response(raw);
          const altSQL = answer.replace(/```sql[\s\S]*?```|```/gi, '').trim();

          if (!altSQL || !altSQL.toUpperCase().includes('SELECT') || altSQL.trim() === currentSQL.trim()) {
            logger.info('[RunQueryToolV2] empty-result retry: no usable alternative SQL — stopping');
            break;
          }

          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rawAlt = await executionDriver.query(altSQL);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const altCols = rawAlt.columns.map((col: any) =>
            typeof col === 'string' ? col : (col as { name: string }).name || String(col),
          );
          const altResult = { columns: altCols, rows: rawAlt.rows };
          logger.info(
            `[RunQueryToolV2] empty-result retry ${emptyRound + 1} → ${altResult.rows.length} rows`,
          );

          currentSQL = altSQL;
          if (altResult.rows.length > 0) {
            finalResult = altResult;
            break;
          }
          // still empty — use this SQL as base for next round
        } catch (retryErr) {
          logger.warn({ err: retryErr }, `[RunQueryToolV2] empty-result retry ${emptyRound + 1} failed`);
          break;
        }
      }
    }
    // ── end empty-result retry loop ─────────────────────────────────────────

    const totalTime = performance.now() - startTime;
    logger.info(
      `[RunQueryToolV2] [PERF] runQuery TOTAL took ${totalTime.toFixed(2)}ms (rows: ${finalResult.rows.length})`,
    );

    if (extra.lastRunQueryResult) {
      (extra.lastRunQueryResult as { current: typeof finalResult }).current =
        finalResult;
    }

    // Confidence scoring — advisory, never blocks execution
    const confidenceSignal = scoreResult(finalResult, {
      correctionApplied: correctionTrace !== null,
      correctionSucceeded: correctionTrace?.success ?? false,
      pathAgreement: true,
    });
    extra.lastConfidenceSignal = confidenceSignal;
    logger.info(
      `[RunQueryToolV2] confidence score=${confidenceSignal.score.toFixed(2)} hedge=${confidenceSignal.shouldHedge}${confidenceSignal.flags.length > 0 ? ` flags=[${confidenceSignal.flags.join(',')}]` : ''}`,
    );

    // Expose final SQL so agent-session can store it in the trace (covers the
    // common no-correction path where correctionTrace is null).
    (extra as Record<string, unknown>).lastFinalSQL = currentSQL;

    const payload = {
      result: finalResult,
      sqlQuery: currentSQL,
      executed: true,
      correctionApplied: correctionTrace !== null,
      emptyResult: finalResult.rows.length === 0,
      ...(exportFilename && { exportFilename }),
    };

    return RunQueryResultSchema.parse(payload);
  },
});
