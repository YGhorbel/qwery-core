import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { DataAgentStateType } from '../../state';
import type { EmitFn, StepResult, SqlResult, PythonResult } from '../../types';
import { ChartSpecSchema } from '../../types';
import {
  buildExecutorRepairPrompt,
  buildPythonGenerationPrompt,
  buildChartSpecPrompt,
} from '../prompts/executor.prompt';
import { rowsToTable, getDialectFromDriverId } from '../../utils';
import type { DiscoveryService } from '../../../discovery.service';
import type { SandboxService } from '../../sandbox.service';
import type { ChatModel } from '../../../llm';
import type { DataAgentTracer } from '../tracer';

export function createExecutorNode(
  llm: ChatModel,
  structuredLlm: ChatModel,
  discoveryService: DiscoveryService,
  sandboxService: SandboxService,
  emit: EmitFn,
  tracer: DataAgentTracer,
) {
  return async (
    state: DataAgentStateType,
  ): Promise<Partial<DataAgentStateType>> => {
    emit({
      type: 'phase_start',
      phase: 'executor',
      description: 'Executing queries',
    });

    const plan = state.plan!;
    const querySpecs = state.querySpecs ?? [];
    const joinPlan = state.joinPlan;
    const dialect = getDialectFromDriverId(state.driverId);

    const datasetSchemas =
      joinPlan?.relevantDatasets
        .map((d) => `### ${d.name}\n${d.yaml}`)
        .join('\n\n') ?? '';

    const stepResults: StepResult[] = [];

    for (const step of plan.steps) {
      emit({
        type: 'step_start',
        stepId: step.id,
        description: step.description,
        strategy: step.strategy,
      });

      const spec = querySpecs.find((q) => q.stepId === step.id);
      const result: StepResult = {
        stepId: step.id,
        description: step.description,
        strategy: step.strategy,
      };

      // Prior step context for dependent steps
      const priorContext = step.dependsOn
        .map((depId) => {
          const dep = stepResults.find((r) => r.stepId === depId);
          if (!dep) return '';
          const lines: string[] = [`Step ${depId} result:`];
          if (dep.sqlResult)
            lines.push(dep.sqlResult.data.split('\n').slice(0, 20).join('\n'));
          if (dep.pythonResult?.stdout)
            lines.push(dep.pythonResult.stdout.slice(0, 500));
          return lines.join('\n');
        })
        .filter(Boolean)
        .join('\n\n');

      // ── SQL execution ─────────────────────────────────────────────────────
      if (
        (step.strategy === 'sql' || step.strategy === 'sql_then_python') &&
        spec
      ) {
        emit({
          type: 'tool_start',
          phase: 'executor',
          stepId: step.id,
          name: 'executeQuery',
          args: { sql: spec.pilotSql },
        });

        let sqlResult: SqlResult | undefined;
        try {
          // Pilot run
          const pilotResult = await discoveryService.executeQuery(
            state.driverId,
            state.driverConfig,
            spec.pilotSql,
            10,
          );

          // Full run
          const fullResult = await discoveryService.executeQuery(
            state.driverId,
            state.driverConfig,
            spec.fullSql,
            500,
          );

          const data = rowsToTable(fullResult.columns, fullResult.rows);
          sqlResult = {
            stepId: step.id,
            pilotRows: pilotResult.rows,
            data,
            columns: fullResult.columns,
            rowCount: fullResult.rows.length,
          };
          emit({
            type: 'tool_end',
            phase: 'executor',
            stepId: step.id,
            name: 'executeQuery',
            result: `${fullResult.rows.length} rows`,
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          emit({
            type: 'tool_error',
            phase: 'executor',
            stepId: step.id,
            name: 'executeQuery',
            error: errMsg,
          });

          // Attempt SQL repair
          try {
            const repairPrompt = buildExecutorRepairPrompt(
              step.description,
              spec.pilotSql,
              errMsg,
              dialect,
            );
            const repairResponse = await tracer.trace(
              'executor',
              'sql_repair',
              false,
              () =>
                llm.invoke([
                  new SystemMessage(repairPrompt),
                  new HumanMessage(errMsg),
                ]),
            );
            const repairedSql =
              typeof repairResponse.content === 'string'
                ? repairResponse.content.trim()
                : spec.fullSql;

            const repairedResult = await discoveryService.executeQuery(
              state.driverId,
              state.driverConfig,
              repairedSql,
              500,
            );
            const data = rowsToTable(
              repairedResult.columns,
              repairedResult.rows,
            );
            sqlResult = {
              stepId: step.id,
              pilotRows: repairedResult.rows.slice(0, 10),
              data,
              columns: repairedResult.columns,
              rowCount: repairedResult.rows.length,
            };
          } catch (repairErr) {
            sqlResult = {
              stepId: step.id,
              pilotRows: [],
              data: '',
              columns: [],
              rowCount: 0,
              error: `${errMsg} (repair also failed: ${repairErr instanceof Error ? repairErr.message : String(repairErr)})`,
            };
          }
        }
        result.sqlResult = sqlResult;
      }

      // ── Chart spec ────────────────────────────────────────────────────────
      if (step.chartType && result.sqlResult) {
        try {
          const chartPrompt = buildChartSpecPrompt(
            step.description,
            step.chartType,
            result.sqlResult.data,
            priorContext,
          );
          const llmWithChart = structuredLlm.withStructuredOutput(
            ChartSpecSchema,
            { name: 'generate_chart' },
          );
          const chartSpec = await llmWithChart.invoke([
            new SystemMessage(chartPrompt),
            new HumanMessage(state.userQuestion),
          ]);
          result.chartSpec = chartSpec;
        } catch {
          // chart generation failed — non-blocking
        }
      }

      // ── Python execution ──────────────────────────────────────────────────
      if (
        (step.strategy === 'python' || step.strategy === 'sql_then_python') &&
        !step.chartType
      ) {
        const sqlData = result.sqlResult?.data ?? '';
        const pythonPrompt = buildPythonGenerationPrompt(
          step.description,
          step.strategy,
          sqlData,
          priorContext,
          datasetSchemas,
        );

        try {
          emit({
            type: 'tool_start',
            phase: 'executor',
            stepId: step.id,
            name: 'sandbox.execute',
            args: {},
          });
          const codeResponse = await tracer.trace(
            'executor',
            'python_generation',
            false,
            () =>
              llm.invoke([
                new SystemMessage(pythonPrompt),
                new HumanMessage(state.userQuestion),
              ]),
          );
          const code =
            typeof codeResponse.content === 'string'
              ? codeResponse.content
              : '';

          const sandboxResult = await sandboxService.executeCode(code, 30);
          const pythonResult: PythonResult = {
            stdout: sandboxResult.stdout,
            stderr: sandboxResult.stderr,
            charts: sandboxResult.files
              .filter((f) => f.mimeType.startsWith('image/'))
              .map((f) => `data:${f.mimeType};base64,${f.base64}`),
          };
          result.pythonResult = pythonResult;
          emit({
            type: 'tool_end',
            phase: 'executor',
            stepId: step.id,
            name: 'sandbox.execute',
            result: sandboxResult.stdout.slice(0, 200),
          });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          emit({
            type: 'tool_error',
            phase: 'executor',
            stepId: step.id,
            name: 'sandbox.execute',
            error: errMsg,
          });
          result.pythonResult = {
            stdout: '',
            stderr: errMsg,
            charts: [],
            error: errMsg,
          };
        }
      }

      stepResults.push(result);
      emit({ type: 'step_complete', stepId: step.id });
    }

    emit({ type: 'phase_artifact', phase: 'executor', artifact: stepResults });
    emit({ type: 'phase_complete', phase: 'executor' });

    return {
      stepResults,
      currentPhase: 'executor',
    };
  };
}
