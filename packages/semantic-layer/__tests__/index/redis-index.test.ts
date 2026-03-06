import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RedisIndex } from '../../src/index/redis-index';

describe('RedisIndex', () => {
  let redisIndex: RedisIndex;

  beforeAll(async () => {
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisIndex = new RedisIndex(redisUrl);
    await redisIndex.connect();
  });

  afterAll(async () => {
    await redisIndex.disconnect();
  });

  describe('MappingIndex', () => {
    it('should set and get mapping index', async () => {
      const datasourceId = 'test-datasource-1';
      const concept = 'TestConcept';

      await redisIndex.setMappingIndex(datasourceId, concept, {
        s3Path: 'mappings/test-datasource-1/1.0.0/mappings.json',
        version: '1.0.0',
      });

      const entry = await redisIndex.getMappingIndex(datasourceId, concept);

      expect(entry).toBeDefined();
      expect(entry?.s3Path).toBe('mappings/test-datasource-1/1.0.0/mappings.json');
      expect(entry?.version).toBe('1.0.0');
    });

    it('should delete mapping index', async () => {
      const datasourceId = 'test-datasource-1';
      const concept = 'TestConcept2';

      await redisIndex.setMappingIndex(datasourceId, concept, {
        s3Path: 'mappings/test-datasource-1/1.0.0/mappings.json',
        version: '1.0.0',
      });

      await redisIndex.deleteMappingIndex(datasourceId, concept);
      const entry = await redisIndex.getMappingIndex(datasourceId, concept);

      expect(entry).toBeNull();
    });
  });

  describe('CacheIndex', () => {
    it('should set and get cache index', async () => {
      const datasourceId = 'test-datasource-1';
      const cacheKey = 'test-cache-key';
      const expiresAt = Date.now() + 3600000;

      await redisIndex.setCacheIndex(datasourceId, cacheKey, {
        s3Path: 'cache/snapshots/test-datasource-1/test-cache-key.json',
        expiresAt,
        hitCount: 0,
      });

      const entry = await redisIndex.getCacheIndex(datasourceId, cacheKey);

      expect(entry).toBeDefined();
      expect(entry?.s3Path).toBe('cache/snapshots/test-datasource-1/test-cache-key.json');
      expect(entry?.expiresAt).toBe(expiresAt);
    });

    it('should increment cache hit count', async () => {
      const datasourceId = 'test-datasource-1';
      const cacheKey = 'test-cache-key-2';
      const expiresAt = Date.now() + 3600000;

      await redisIndex.setCacheIndex(datasourceId, cacheKey, {
        s3Path: 'cache/snapshots/test-datasource-1/test-cache-key-2.json',
        expiresAt,
        hitCount: 0,
      });

      const hitCount = await redisIndex.incrementCacheHitCount(datasourceId, cacheKey);

      expect(hitCount).toBe(1);
    });
  });

  describe('CacheConfig', () => {
    it('should set and get cache config', async () => {
      const datasourceId = 'test-datasource-1';

      await redisIndex.setCacheConfig(datasourceId, { ttlHours: 48 });

      const config = await redisIndex.getCacheConfig(datasourceId);

      expect(config).toBeDefined();
      expect(config?.ttlHours).toBe(48);
    });
  });
});
