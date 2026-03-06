import type { SemanticPlan, CompiledQuery } from '../compiler/types';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface CacheKey {
  datasourceId: string;
  semanticPlan: SemanticPlan;
  ontologyVersion: string;
}

export interface CacheEntry {
  id: string;
  cache_key: string;
  datasource_id: string;
  semantic_plan: SemanticPlan;
  compiled_sql: string;
  result_summary: ResultSummary | null;
  created_at: Date;
  expires_at: Date;
  hit_count: number;
}

export interface ResultSummary {
  columns: Array<{ name: string; type: string }>;
  row_count: number;
  sample_rows: unknown[][];
}

export interface CacheConfig {
  datasource_id: string;
  ttl_hours: number;
}

async function generateCacheKey(key: CacheKey): Promise<string> {
  const normalized = JSON.stringify({
    datasourceId: key.datasourceId,
    ontologyVersion: key.ontologyVersion,
    semanticPlan: key.semanticPlan,
  });
  
  // Use Web Crypto API which works in both Node.js (18+) and browsers
  // This avoids importing Node.js 'crypto' module which causes browser bundling issues
  const encoder = new TextEncoder();
  const data = encoder.encode(normalized);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function getCacheConfig(
  datasourceId: string,
): Promise<number> {
  const { getRedisIndex } = await import('../index/redis-index');
  const redisIndex = getRedisIndex();
  
  if (redisIndex) {
    const config = await redisIndex.getCacheConfig(datasourceId);
    if (config) {
      return config.ttlHours;
    }
  }

  return 24;
}

export async function getCachedQuery(
  key: CacheKey,
): Promise<CacheEntry | null> {
  const logger = await getLogger();
  const cacheKey = await generateCacheKey(key);

  logger.info('[SemanticCache] Cache lookup', {
    cacheKeyPrefix: cacheKey.substring(0, 16),
    datasourceId: key.datasourceId,
    concepts: key.semanticPlan.concepts,
  });

  const { getRedisIndex } = await import('../index/redis-index');
  const { getMinIOStore } = await import('../storage/minio-store');
  const redisIndex = getRedisIndex();
  const minIOStore = getMinIOStore();

  if (!redisIndex || !minIOStore) {
    logger.debug('[SemanticCache] Redis or MinIO not available', {
      cacheKeyPrefix: cacheKey.substring(0, 16),
    });
    return null;
  }

  const indexEntry = await redisIndex.getCacheIndex(key.datasourceId, cacheKey);
  if (!indexEntry) {
    logger.info('[SemanticCache] Cache miss', {
      cacheKeyPrefix: cacheKey.substring(0, 16),
    });
    return null;
  }

  const cacheStore = minIOStore.createCacheStore();
  const snapshot = await cacheStore.get(cacheKey);
  if (!snapshot) {
    logger.info('[SemanticCache] Cache snapshot not found in MinIO', {
      cacheKeyPrefix: cacheKey.substring(0, 16),
    });
    await redisIndex.deleteCacheIndex(key.datasourceId, cacheKey);
    return null;
  }

  const hitCount = await redisIndex.incrementCacheHitCount(key.datasourceId, cacheKey);

  const entry: CacheEntry = {
    id: cacheKey,
    cache_key: cacheKey,
    datasource_id: snapshot.datasourceId,
    semantic_plan: snapshot.semanticPlan as CacheEntry['semantic_plan'],
    compiled_sql: snapshot.compiledSQL,
    result_summary: snapshot.resultSummary as ResultSummary | null,
    created_at: new Date(snapshot.timestamp),
    expires_at: new Date(indexEntry.expiresAt),
    hit_count: hitCount,
  };

  const ageMinutes = Math.floor(
    (Date.now() - entry.created_at.getTime()) / 60000,
  );

  logger.info('[SemanticCache] Cache hit', {
    cacheKeyPrefix: cacheKey.substring(0, 16),
    hitCount,
    ageMinutes,
    expiresAt: entry.expires_at,
  });

  return entry;
}

export async function storeCachedQuery(
  key: CacheKey,
  compiledQuery: CompiledQuery,
  resultSummary?: ResultSummary,
): Promise<void> {
  const logger = await getLogger();
  const cacheKey = await generateCacheKey(key);
  const ttlHours = await getCacheConfig(key.datasourceId);
  const expiresAt = Date.now() + ttlHours * 60 * 60 * 1000;

  logger.info('[SemanticCache] Storing in cache', {
    cacheKeyPrefix: cacheKey.substring(0, 16),
    datasourceId: key.datasourceId,
    ttlHours,
    sqlLength: compiledQuery.sql.length,
  });

  const { getRedisIndex } = await import('../index/redis-index');
  const { getMinIOStore } = await import('../storage/minio-store');
  const redisIndex = getRedisIndex();
  const minIOStore = getMinIOStore();

  if (!redisIndex || !minIOStore) {
    logger.warn('[SemanticCache] Redis or MinIO not available, cannot store cache', {
      cacheKeyPrefix: cacheKey.substring(0, 16),
    });
    return;
  }

  const snapshot = {
    cacheKey,
    datasourceId: key.datasourceId,
    semanticPlan: key.semanticPlan,
    compiledSQL: compiledQuery.sql,
    resultSummary,
    timestamp: new Date().toISOString(),
  };

  const cacheStore = minIOStore.createCacheStore();
  await cacheStore.put(cacheKey, snapshot);

  await redisIndex.setCacheIndex(
    key.datasourceId,
    cacheKey,
    {
      s3Path: `cache/snapshots/${key.datasourceId}/${cacheKey}.json`,
      expiresAt,
      hitCount: 0,
    },
    ttlHours * 3600,
  );

  logger.debug('[SemanticCache] Cache stored', {
    cacheKeyPrefix: cacheKey.substring(0, 16),
    expiresAt: new Date(expiresAt).toISOString(),
  });
}

export async function invalidateCache(
  datasourceId: string,
): Promise<void> {
  const logger = await getLogger();

  const { getRedisIndex } = await import('../index/redis-index');
  const { getMinIOStore } = await import('../storage/minio-store');
  const redisIndex = getRedisIndex();
  const minIOStore = getMinIOStore();

  if (!redisIndex || !minIOStore) {
    logger.warn('[SemanticCache] Redis or MinIO not available, cannot invalidate cache', {
      datasourceId,
    });
    return;
  }

  const cacheStore = minIOStore.createCacheStore();
  const cacheKeys = await cacheStore.list(datasourceId);

  for (const cacheKey of cacheKeys) {
    await cacheStore.delete(cacheKey);
    await redisIndex.deleteCacheIndex(datasourceId, cacheKey);
  }

  logger.info('[SemanticCache] Cache invalidated', { datasourceId, deletedCount: cacheKeys.length });
}

export async function setCacheConfig(
  datasourceId: string,
  ttlHours: number,
): Promise<void> {
  const logger = await getLogger();

  const { getRedisIndex } = await import('../index/redis-index');
  const redisIndex = getRedisIndex();

  if (!redisIndex) {
    logger.warn('[SemanticCache] Redis not available, cannot set cache config', {
      datasourceId,
    });
    return;
  }

  await redisIndex.setCacheConfig(datasourceId, { ttlHours });

  logger.debug('[SemanticCache] Cache config updated', {
    datasourceId,
    ttlHours,
  });
}

export async function cleanupExpiredCache(): Promise<number> {
  const logger = await getLogger();

  const { getRedisIndex } = await import('../index/redis-index');
  const { getMinIOStore } = await import('../storage/minio-store');
  const redisIndex = getRedisIndex();
  const minIOStore = getMinIOStore();

  if (!redisIndex || !minIOStore) {
    logger.warn('[SemanticCache] Redis or MinIO not available, cannot cleanup expired cache');
    return 0;
  }

  let deletedCount = 0;
  const now = Date.now();

  const { getMinIOClient } = await import('../storage/minio-client');
  const minIOClient = getMinIOClient();
  if (!minIOClient) {
    return 0;
  }

  const allCacheObjects = await minIOClient.listObjects('cache/snapshots/');
  for (const objPath of allCacheObjects) {
    const match = objPath.match(/^cache\/snapshots\/([^/]+)\/([^/]+)\.json$/);
    if (match && match[1] && match[2]) {
      const datasourceId = match[1];
      const cacheKey = match[2];
      const indexEntry = await redisIndex.getCacheIndex(datasourceId, cacheKey);
      if (!indexEntry || indexEntry.expiresAt < now) {
        const cacheStore = minIOStore.createCacheStore();
        await cacheStore.delete(cacheKey);
        await redisIndex.deleteCacheIndex(datasourceId, cacheKey);
        deletedCount++;
      }
    }
  }

  logger.debug('[SemanticCache] Cleaned up expired entries', {
    deletedCount,
  });

  return deletedCount;
}
