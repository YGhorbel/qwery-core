import { z } from 'zod';
import { Tool } from './tool';
import { getLogger } from '@qwery/shared/logger';
import { Repositories } from '@qwery/domain/repositories';
import {
  ExtensionsRegistry,
  type DatasourceExtension,
} from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { compileSemanticQuery } from '@qwery/semantic-layer/compiler/semantic-compiler';
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';
import { loadMappings } from '@qwery/semantic-layer/mapping/store';
import type { MappingResult } from '@qwery/semantic-layer/mapping/generator';
import { extractSemanticIntent } from '@qwery/semantic-layer/compiler/intent-extractor';
import {
  getCachedQuery,
  storeCachedQuery,
  invalidateCache,
  type ResultSummary,
} from '@qwery/semantic-layer/cache/semantic-cache';
import {
  explainQueryResult,
  validateResultAgainstIntent,
} from '@qwery/semantic-layer/post-processor/explainer';
import { reasonOverOntology, type ReasoningChain } from '@qwery/semantic-layer/reasoning/cot-reasoner';
import { formatReasoningChain } from '@qwery/semantic-layer/reasoning/format-reasoning';
import { RunQueryTool } from './run-query';
import { ExportFilenameSchema, RunQueryResultSchema } from './schema';
import { Provider } from '../llm';

const DESCRIPTION = `Run a semantic query using natural language. This tool translates natural language queries into SQL by leveraging the semantic ontology and mappings.
The query is first analyzed to extract semantic concepts, then compiled to SQL using table/column mappings, and finally executed.`;

export const RunSemanticQueryTool = Tool.define('runSemanticQuery', {
  description: DESCRIPTION,
  parameters: z.object({
    query: z
      .string()
      .describe('The natural language query to execute (e.g., "Show me top customers by revenue")'),
    datasourceId: z
      .string()
      .optional()
      .describe('The ID of the datasource. If not provided, uses the attached datasource.'),
    ontologyVersion: z
      .string()
      .default('1.0.0')
      .describe('The ontology version to use for semantic compilation'),
    exportFilename: ExportFilenameSchema.describe(
      'Short filename for the table export (lowercase, hyphens; e.g. top-customers-by-revenue)',
    ),
  }),
  async execute(params, ctx) {
    const logger = await getLogger();
    const { repositories, attachedDatasources } = ctx.extra as {
      repositories: Repositories;
      attachedDatasources: string[];
    };

    const datasourceId = params.datasourceId ?? attachedDatasources[0];

    if (!datasourceId) {
      throw new Error('No datasource ID provided and no attached datasource found');
    }

    const startTime = performance.now();

    // Try findById first, then findBySlug if not found (handles both UUIDs and slugs)
    let datasource = await repositories.datasource.findById(datasourceId);
    if (!datasource) {
      datasource = await repositories.datasource.findBySlug(datasourceId);
    }
    if (!datasource) {
      throw new Error(`Datasource not found: ${datasourceId}`);
    }

    // Use actual datasource ID (UUID) instead of original parameter (which might be a slug)
    const actualDatasourceId = datasource.id;

    logger.info('[RunSemanticQueryTool] Starting semantic query', {
      query: params.query,
      datasourceId: actualDatasourceId,
      originalDatasourceId: datasourceId,
      ontologyVersion: params.ontologyVersion,
      hasAttachedDatasource: !!attachedDatasources[0],
    });

    if (datasource.datasource_provider !== 'postgresql') {
      throw new Error(
        `Semantic layer currently only supports PostgreSQL datasources. Got: ${datasource.datasource_provider}`,
      );
    }

    const extension = ExtensionsRegistry.get(
      datasource.datasource_provider,
    ) as DatasourceExtension | undefined;

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

    const driverInstance = await getDriverInstance(nodeDriver, {
      config: datasource.config,
    });

    let compiledQuery;
    let semanticPlan;
    let cachedEntry = null;

    try {
      const metadata = await driverInstance.metadata();

      const gptModel = Provider.getModel('azure', 'gpt-5.2-chat');
      const gptLanguageModel = await Provider.getLanguage(gptModel);

      const ontology = await loadOntology(params.ontologyVersion);
      if (!ontology) {
        throw new Error(
          `Ontology version ${params.ontologyVersion} not found. Please run semantic:migrate to load the ontology.`,
        );
      }

      logger.info('[RunSemanticQueryTool] Ontology loaded', {
        version: params.ontologyVersion,
        conceptsCount: ontology.ontology.concepts.length,
        relationshipsCount: ontology.ontology.concepts.reduce(
          (sum, c) => sum + c.relationships.length,
          0,
        ),
      });

      let reasoningChain: ReasoningChain | null = null;
      let reasoningFormatted: string | null = null;

      // Generate CoT reasoning before compilation
      try {
        const cotStart = performance.now();
        reasoningChain = await reasonOverOntology(
          params.query,
          ontology,
          params.ontologyVersion,
          actualDatasourceId,
          gptLanguageModel,
        );
        const cotTime = performance.now() - cotStart;

        reasoningFormatted = formatReasoningChain(reasoningChain);

        logger.info('[RunSemanticQueryTool] CoT reasoning generated', {
          stepsCount: reasoningChain.steps.length,
          durationMs: cotTime.toFixed(2),
        });

        // Emit reasoning as metadata for UI display
        if (ctx.metadata) {
          await ctx.metadata({
            title: 'Semantic Query Reasoning',
            metadata: {
              reasoning: {
                steps: reasoningChain.steps,
                formatted: reasoningFormatted,
                chain: reasoningChain,
              },
            },
          });
        }
      } catch (cotError) {
        logger.warn('[RunSemanticQueryTool] CoT reasoning failed, continuing without reasoning', {
          error: cotError instanceof Error ? cotError.message : String(cotError),
        });
      }

      try {
        const intentStart = performance.now();
        // Use reasoning plan if available, otherwise extract intent
        if (reasoningChain?.finalPlan) {
          semanticPlan = reasoningChain.finalPlan;
          logger.info('[RunSemanticQueryTool] Using CoT reasoning plan', {
            concepts: semanticPlan.concepts,
            properties: semanticPlan.properties,
            relationships: semanticPlan.relationships.length,
          });
        } else {
          semanticPlan = await extractSemanticIntent(
            params.query,
            ontology,
            gptLanguageModel,
          );
        }
        const intentTime = performance.now() - intentStart;

        logger.info('[RunSemanticQueryTool] Intent extracted', {
          concepts: semanticPlan.concepts,
          properties: semanticPlan.properties,
          relationships: semanticPlan.relationships.length,
          durationMs: intentTime.toFixed(2),
          fromCoT: !!reasoningChain?.finalPlan,
        });

        const cacheStart = performance.now();
        cachedEntry = await getCachedQuery({
          datasourceId: actualDatasourceId,
          ontologyVersion: params.ontologyVersion,
          semanticPlan,
        });
        const cacheTime = performance.now() - cacheStart;

        logger.info('[RunSemanticQueryTool] Cache lookup', {
          hit: !!cachedEntry,
          durationMs: cacheTime.toFixed(2),
          cacheKey: cachedEntry?.cache_key?.substring(0, 16),
        });

        if (cachedEntry) {
          logger.info('[RunSemanticQueryTool] Cache hit, using cached query');
          compiledQuery = {
            sql: cachedEntry.compiled_sql,
            parameters: [],
            table_mappings: [],
            join_paths: [],
          };
        }
      } catch (error) {
        logger.warn('[RunSemanticQueryTool] Cache lookup failed, continuing', {
          error,
        });
      }

      if (!cachedEntry) {
        logger.info('[RunSemanticQueryTool] Cache miss, compiling semantic query');

        try {
          // Use reasoning plan if available from CoT
          const compileResult = await compileSemanticQuery({
            query: params.query,
            datasourceId: actualDatasourceId,
            ontologyVersion: params.ontologyVersion,
            metadata, // Required for validation
            languageModel: gptLanguageModel,
            useGraphInference: true, // Use graph-based join inference
            semanticPlan: reasoningChain?.finalPlan, // Use reasoning plan if available
          });

          compiledQuery = compileResult.compiledQuery;
          semanticPlan = compileResult.semanticPlan;

          // Validate query agreement (ensure table/column names match)
          if (metadata) {
            const { agreeOnQueryNames } = await import('./utils/query-agreement');
            const mappingsArray = await loadMappings(actualDatasourceId, params.ontologyVersion);
            // Convert array to MappingResult format expected by agreeOnQueryNames
            const mappings: MappingResult = {
              table_mappings: mappingsArray.map((m) => ({
                table_schema: m.table_schema,
                table_name: m.table_name,
                concept_id: m.concept_id,
                confidence: m.confidence,
                synonyms: m.synonyms,
                column_mappings: m.column_mappings,
              })),
            };
            const agreement = await agreeOnQueryNames(
              semanticPlan,
              compiledQuery.sql,
              metadata,
              mappings,
            );

            if (!agreement.agreed && agreement.corrections.length > 0) {
              logger.warn('[RunSemanticQueryTool] Query agreement issues detected', {
                correctionsCount: agreement.corrections.length,
                corrections: agreement.corrections.slice(0, 3),
              });
              // Note: In a full implementation, we would apply corrections here
            }
          }

          logger.info('[RunSemanticQueryTool] Compilation complete', {
            sqlLength: compiledQuery.sql.length,
            parametersCount: compiledQuery.parameters.length,
            joinPathsCount: compiledQuery.join_paths.length,
            tableMappingsCount: compiledQuery.table_mappings.length,
            sqlPreview: compiledQuery.sql.substring(0, 150) + '...',
          });
        } catch (compileError) {
          logger.error('[RunSemanticQueryTool] Compilation failed', {
            error: compileError,
          });
          throw new Error(
            `Failed to compile semantic query: ${compileError instanceof Error ? compileError.message : String(compileError)}`,
          );
        }

        try {
          await storeCachedQuery(
            {
              datasourceId: actualDatasourceId,
              ontologyVersion: params.ontologyVersion,
              semanticPlan,
            },
            compiledQuery,
          );
        } catch (cacheError) {
          logger.warn('[RunSemanticQueryTool] Cache store failed, continuing', {
            error: cacheError,
          });
        }
      }

      if (!compiledQuery) {
        throw new Error('Failed to compile or retrieve query from cache');
      }

      logger.debug('[RunSemanticQueryTool] Executing compiled SQL', {
        sql: compiledQuery.sql,
        parameters: compiledQuery.parameters,
      });

      if (
        !('execute' in RunQueryTool) ||
        typeof RunQueryTool.execute !== 'function'
      ) {
        throw new Error('RunQueryTool does not have a valid execute function');
      }

      let result;
      try {
        const queryStart = performance.now();
        result = await RunQueryTool.execute(
          {
            datasourceId: actualDatasourceId,
            query: compiledQuery.sql,
            exportFilename: params.exportFilename,
          },
          ctx,
        );
        const queryTime = performance.now() - queryStart;

        const resultObj = result as Record<string, unknown>;
        const queryResult = resultObj.result as {
          columns: string[];
          rows: unknown[][];
        };

        logger.info('[RunSemanticQueryTool] Query executed', {
          rowsReturned: queryResult?.rows?.length || 0,
          columnsCount: queryResult?.columns?.length || 0,
          durationMs: queryTime.toFixed(2),
        });

        // Collect training data if query was successful
        try {
          const { getLearningLoop } = await import('@qwery/semantic-layer/training/learning-loop');
          const learningLoop = getLearningLoop();
          await learningLoop.collectSuccessfulQuery(
            actualDatasourceId,
            params.ontologyVersion,
            {
              naturalLanguageQuery: params.query,
              semanticPlan,
              generatedSQL: compiledQuery.sql,
              executedSQL: compiledQuery.sql,
              result: {
                columns: queryResult?.columns || [],
                rowCount: queryResult?.rows?.length || 0,
              },
            },
          );
        } catch (trainingError) {
          logger.debug('[RunSemanticQueryTool] Training data collection failed', {
            error: trainingError instanceof Error ? trainingError.message : String(trainingError),
          });
        }
      } catch (queryError) {
        logger.error('[RunSemanticQueryTool] Query execution failed', {
          error: queryError,
          sql: compiledQuery.sql.substring(0, 200),
        });

        if (cachedEntry) {
          logger.info(
            '[RunSemanticQueryTool] Cached query failed, invalidating cache and retrying compilation',
          );
          try {
            await invalidateCache(actualDatasourceId);
          } catch (invalidateError) {
            logger.warn('[RunSemanticQueryTool] Cache invalidation failed', {
              error: invalidateError,
            });
          }

          const compileResult = await compileSemanticQuery({
            query: params.query,
            datasourceId: actualDatasourceId,
            ontologyVersion: params.ontologyVersion,
            metadata,
            languageModel: gptLanguageModel,
          });

          compiledQuery = compileResult.compiledQuery;
          semanticPlan = compileResult.semanticPlan;

          result = await RunQueryTool.execute(
            {
              datasourceId: actualDatasourceId,
              query: compiledQuery.sql,
              exportFilename: params.exportFilename,
            },
            ctx,
          );
        } else {
          throw queryError;
        }
      }

      const resultObj = result as Record<string, unknown>;
      const queryResult = resultObj.result as {
        columns: string[];
        rows: unknown[][];
      };

      let explanation = null;
      let validation = null;

      if (queryResult && queryResult.rows && semanticPlan) {
        try {
          const resultSummary: ResultSummary = {
            columns: queryResult.columns.map((col, idx) => {
              const value = queryResult.rows[0]?.[idx];
              return {
                name: col,
                type: value !== undefined ? typeof value : 'unknown',
              };
            }),
            row_count: queryResult.rows.length,
            sample_rows: queryResult.rows.slice(0, 5),
          };

          await storeCachedQuery(
            {
              datasourceId: actualDatasourceId,
              ontologyVersion: params.ontologyVersion,
              semanticPlan,
            },
            compiledQuery,
            resultSummary,
          );

          try {
            const postStart = performance.now();
            explanation = await explainQueryResult(
              params.query,
              semanticPlan,
              {
                columns: queryResult.columns,
                rows: queryResult.rows,
              },
              gptLanguageModel,
            );
            const postTime = performance.now() - postStart;

            logger.info('[RunSemanticQueryTool] Post-processing complete', {
              explanationLength: explanation.summary?.length || 0,
              insightsCount: explanation.insights?.length || 0,
              durationMs: postTime.toFixed(2),
            });
          } catch (explainError) {
            logger.warn('[RunSemanticQueryTool] Explanation generation failed', {
              error: explainError,
            });
          }

          try {
            validation = await validateResultAgainstIntent(
              params.query,
              semanticPlan,
              {
                columns: queryResult.columns,
                rows: queryResult.rows,
              },
              gptLanguageModel,
            );
          } catch (validateError) {
            logger.warn('[RunSemanticQueryTool] Validation failed', {
              error: validateError,
            });
          }
        } catch (postProcessError) {
          logger.warn('[RunSemanticQueryTool] Post-processing failed', {
            error: postProcessError,
          });
        }
      }

      if (!semanticPlan || !compiledQuery) {
        throw new Error('Semantic plan or compiled query is missing');
      }

      const totalTime = performance.now() - startTime;

      logger.info('[RunSemanticQueryTool] Semantic query complete', {
        totalDurationMs: totalTime.toFixed(2),
        cached: !!cachedEntry,
        rowsReturned: queryResult?.rows?.length || 0,
      });

      return {
        ...resultObj,
        semantic: {
          plan: semanticPlan,
          compiled_sql: compiledQuery.sql,
          table_mappings: compiledQuery.table_mappings.map(
            (m: {
              concept_id: string;
              table_schema: string;
              table_name: string;
            }) => ({
              concept_id: m.concept_id,
              table_schema: m.table_schema,
              table_name: m.table_name,
            }),
          ),
          join_paths: compiledQuery.join_paths,
          cached: !!cachedEntry,
          explanation,
          validation,
          reasoning: reasoningChain
            ? {
                steps: reasoningChain.steps,
                formatted: reasoningFormatted,
              }
            : undefined,
        },
      };
    } catch (error) {
      logger.error('[RunSemanticQueryTool] Execution failed', {
        error,
        query: params.query,
        datasourceId: actualDatasourceId,
        originalDatasourceId: datasourceId,
      });

      if (error instanceof Error) {
        throw error;
      }

      throw new Error(
        `Semantic query execution failed: ${String(error)}`,
      );
    } finally {
      if (typeof driverInstance.close === 'function') {
        await driverInstance.close();
      }
    }
  },
});
