#!/usr/bin/env tsx

import { performance } from 'node:perf_hooks';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { getCachedQuery, storeCachedQuery } from '../src/cache/semantic-cache';
import { loadOntology } from '../src/ontology/loader';
import { loadMappings } from '../src/mapping/store';
import { resolveConcept } from '../src/mapping/resolver';
import type { SemanticPlan } from '../src/compiler/types';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

interface BenchmarkResult {
  operation: string;
  iterations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  errors: number;
}

async function runBenchmark<T>(
  name: string,
  iterations: number,
  operation: () => Promise<T>,
): Promise<BenchmarkResult> {
  const logger = await getLogger();
  logger.info(`[Benchmark] Starting ${name}`, { iterations });

  const times: number[] = [];
  let errors = 0;

  for (let i = 0; i < iterations; i++) {
    try {
      const start = performance.now();
      await operation();
      const end = performance.now();
      times.push(end - start);
    } catch (error) {
      errors++;
      logger.warn(`[Benchmark] Error in ${name} iteration ${i}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  times.sort((a, b) => a - b);
  const totalTime = times.reduce((sum, t) => sum + t, 0);
  const avgTime = totalTime / times.length;
  const p50 = times[Math.floor(times.length * 0.5)] || 0;
  const p95 = times[Math.floor(times.length * 0.95)] || 0;
  const p99 = times[Math.floor(times.length * 0.99)] || 0;

  const result: BenchmarkResult = {
    operation: name,
    iterations,
    totalTimeMs: totalTime,
    avgTimeMs: avgTime,
    p50Ms: p50,
    p95Ms: p95,
    p99Ms: p99,
    errors,
  };

  logger.info(`[Benchmark] Completed ${name}`, result);
  return result;
}

async function benchmarkCacheOperations(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const datasourceId = process.env.BENCHMARK_DATASOURCE_ID || 'test-datasource';
  const ontologyVersion = '1.0.0';

  const testPlan: SemanticPlan = {
    concepts: ['TestConcept'],
    properties: [],
    relationships: [],
    filters: [],
    aggregations: [],
  };

  const cacheKey = {
    datasourceId,
    ontologyVersion,
    semanticPlan: testPlan,
  };

  results.push(
    await runBenchmark('cache.get (hot path)', 1000, async () => {
      await getCachedQuery(cacheKey);
    }),
  );

  results.push(
    await runBenchmark('cache.put', 100, async () => {
      await storeCachedQuery(
        cacheKey,
        {
          sql: 'SELECT * FROM test_table',
          parameters: [],
          table_mappings: [],
          join_paths: [],
        },
        {
          columns: [{ name: 'id', type: 'string' }],
          row_count: 10,
          sample_rows: [],
        },
      );
    }),
  );

  return results;
}

async function benchmarkMappingResolution(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];
  const datasourceId = process.env.BENCHMARK_DATASOURCE_ID || 'test-datasource';
  const ontologyVersion = '1.0.0';

  results.push(
    await runBenchmark('resolveConcept', 1000, async () => {
      await resolveConcept(datasourceId, 'TestConcept', ontologyVersion);
    }),
  );

  results.push(
    await runBenchmark('loadMappings', 100, async () => {
      await loadMappings(datasourceId, ontologyVersion);
    }),
  );

  return results;
}

async function benchmarkOntologyLoading(): Promise<BenchmarkResult[]> {
  const results: BenchmarkResult[] = [];

  results.push(
    await runBenchmark('loadOntology (latest)', 100, async () => {
      await loadOntology('latest');
    }),
  );

  results.push(
    await runBenchmark('loadOntology (specific version)', 100, async () => {
      await loadOntology('1.0.0');
    }),
  );

  return results;
}

async function main(): Promise<void> {
  const logger = await getLogger();
  logger.info('[Benchmark] Starting semantic layer benchmarks');

  const allResults: BenchmarkResult[] = [];

  try {
    const cacheResults = await benchmarkCacheOperations();
    allResults.push(...cacheResults);
  } catch (error) {
    logger.error('[Benchmark] Cache benchmark failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const mappingResults = await benchmarkMappingResolution();
    allResults.push(...mappingResults);
  } catch (error) {
    logger.error('[Benchmark] Mapping benchmark failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const ontologyResults = await benchmarkOntologyLoading();
    allResults.push(...ontologyResults);
  } catch (error) {
    logger.error('[Benchmark] Ontology benchmark failed', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.info('[Benchmark] All benchmarks completed', {
    totalOperations: allResults.length,
    results: allResults.map((r) => ({
      operation: r.operation,
      avgTimeMs: r.avgTimeMs.toFixed(2),
      p95Ms: r.p95Ms.toFixed(2),
      errors: r.errors,
    })),
  });

  const cacheHotPath = allResults.find((r) => r.operation === 'cache.get (hot path)');
  if (cacheHotPath) {
    logger.info('[Benchmark] Cache hot-path performance', {
      avgTimeMs: cacheHotPath.avgTimeMs.toFixed(2),
      p95Ms: cacheHotPath.p95Ms.toFixed(2),
      targetMet: cacheHotPath.avgTimeMs <= 50,
    });
  }
}

main().catch((error) => {
  console.error('Benchmark failed:', error);
  process.exit(1);
});
