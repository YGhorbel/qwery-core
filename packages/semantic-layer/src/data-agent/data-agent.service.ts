import { getLogger } from '@qwery/shared/logger';
import type { IDatasourceRepository } from '@qwery/domain/repositories';
import { neoOntologyService } from '../ontology/neo-ontology.service';
import { discoveryService } from '../discovery.service';
import { sandboxService } from './sandbox.service';
import { getChatModel } from '../llm';
import { buildDataAgentGraph } from './agent/graph';
import { DataAgentTracer } from './agent/tracer';
import { fieldsToYaml, getDialectFromDriverId } from './utils';
import type { EmitFn } from './types';

export interface ExecuteDataAgentParams {
  datasourceId: string;
  userQuestion: string;
  conversationContext?: string;
  clarificationRound?: number;
  onEvent: EmitFn;
}

export class DataAgentService {
  async executeAgent(
    params: ExecuteDataAgentParams,
    datasourceRepo: IDatasourceRepository,
  ): Promise<void> {
    const logger = await getLogger();
    const {
      datasourceId,
      userQuestion,
      conversationContext = '',
      clarificationRound = 0,
      onEvent,
    } = params;

    onEvent({ type: 'message_start', startedAt: Date.now() });

    try {
      onEvent({ type: 'discovery_start' });

      const embeddingStart = Date.now();

      // ── Load datasource ───────────────────────────────────────────────────
      const datasource = await datasourceRepo.findById(datasourceId);
      if (!datasource) throw new Error(`Datasource ${datasourceId} not found`);

      const revealedConfig = await datasourceRepo.revealSecrets(
        datasource.config,
      );
      const driverId = datasource.datasource_driver;
      const databaseType = getDialectFromDriverId(driverId);

      // ── Vector search ─────────────────────────────────────────────────────
      const vectorSearchStart = Date.now();
      const embeddingDurationMs = vectorSearchStart - embeddingStart;

      const similarDatasets = await neoOntologyService.searchSimilar(
        datasourceId,
        userQuestion,
        10,
      );
      const vectorSearchDurationMs = Date.now() - vectorSearchStart;

      const relevantDatasets = similarDatasets.map((d) => d.name);
      const matchedDatasets = similarDatasets.map((d) => ({
        name: d.name,
        score: d.score,
      }));

      // ── Pre-fetch dataset YAML details ─────────────────────────────────────
      const yamlStart = Date.now();
      const rawDetails =
        relevantDatasets.length > 0
          ? await neoOntologyService.getDatasetDetails(
              datasourceId,
              relevantDatasets,
            )
          : [];

      const relevantDatasetDetails = rawDetails.map((d) => ({
        name: d.name,
        description: d.description,
        source: d.source,
        yaml: fieldsToYaml(d.name, d.source, d.fields),
      }));
      const yamlFetchDurationMs = Date.now() - yamlStart;

      onEvent({
        type: 'discovery_complete',
        embeddingDurationMs,
        vectorSearchDurationMs,
        yamlFetchDurationMs,
        matchedDatasets,
        datasetsWithYaml: relevantDatasetDetails.length,
      });

      logger.info(
        { datasourceId, matchedDatasets: matchedDatasets.length },
        'data-agent: vector search complete',
      );

      // ── Build LLM instances ───────────────────────────────────────────────
      const llm = getChatModel(1);
      const structuredLlm = getChatModel(0);

      const llmProvider = process.env['LLM_DEFAULT_PROVIDER'] ?? 'openai';
      const llmModel =
        llmProvider === 'anthropic'
          ? (process.env['ANTHROPIC_MODEL'] ?? 'claude-opus-4-6')
          : llmProvider === 'azure'
            ? (process.env['AZURE_OPENAI_DEPLOYMENT'] ?? 'gpt-4o')
            : (process.env['OPENAI_MODEL'] ?? 'gpt-4o');
      const tracer = new DataAgentTracer(onEvent, llmProvider, llmModel);

      // ── Build and invoke graph ────────────────────────────────────────────
      const graph = buildDataAgentGraph({
        llm,
        structuredLlm,
        neoOntologyService,
        discoveryService,
        sandboxService,
        datasourceId,
        emit: onEvent,
        tracer,
      });

      const finalState = await graph.invoke({
        userQuestion,
        datasourceId,
        driverId,
        driverConfig: revealedConfig,
        databaseType,
        conversationContext,
        clarificationRound,
        relevantDatasets,
        relevantDatasetDetails,
      });

      let finalContent = '';
      let finalStatus: 'clarification_needed' | undefined;

      // Determine if we ended with a clarification request
      if (
        finalState.plan?.shouldClarify &&
        finalState.plan.clarificationQuestions.length > 0
      ) {
        finalStatus = 'clarification_needed';
        onEvent({
          type: 'clarification_requested',
          questions: finalState.plan.clarificationQuestions,
        });
        finalContent = finalState.plan.clarificationQuestions
          .map((q) => q.question)
          .join('\n');
      } else {
        finalContent = finalState.explainerOutput?.narrative ?? '';
      }

      onEvent({
        type: 'message_complete',
        content: finalContent,
        metadata: {
          datasourceId,
          tokensUsed: finalState.tokensUsed,
          phase: finalState.currentPhase,
          verificationPassed: finalState.verificationReport?.passed ?? null,
          lineage: finalState.explainerOutput?.lineage ?? null,
        },
        status: finalStatus,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ datasourceId, err }, 'data-agent: execution failed');
      onEvent({ type: 'message_error', message });
    }
  }
}

export const dataAgentService = new DataAgentService();
