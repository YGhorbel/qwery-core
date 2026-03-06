import { createClient, type RedisClientType } from 'redis';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface CacheIndexEntry {
  s3Path: string;
  expiresAt: number;
  hitCount: number;
}

export interface MappingIndexEntry {
  s3Path: string;
  version: string;
}

export interface OntologyIndexEntry {
  s3Path: string;
  version: string;
}

export interface CacheConfigEntry {
  ttlHours: number;
}

export class RedisIndex {
  private client: RedisClientType | null = null;
  private connected = false;

  constructor(private url?: string) {}

  async connect(): Promise<void> {
    if (this.connected && this.client) {
      return;
    }

    const logger = await getLogger();
    const redisUrl = this.url || process.env.REDIS_URL;

    if (!redisUrl) {
      logger.warn('[RedisIndex] REDIS_URL not configured, Redis index disabled');
      return;
    }

    try {
      this.client = createClient({ url: redisUrl });
      this.client.on('error', (err: Error) => {
        logger.error('[RedisIndex] Redis client error', {
          error: err instanceof Error ? err.message : String(err),
        });
      });

      await this.client.connect();
      this.connected = true;
      logger.info('[RedisIndex] Connected to Redis');
    } catch (error) {
      logger.error('[RedisIndex] Failed to connect to Redis', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.client && this.connected) {
      await this.client.quit();
      this.connected = false;
    }
  }

  private ensureConnected(): void {
    if (!this.connected || !this.client) {
      throw new Error('Redis client not connected. Call connect() first.');
    }
  }

  async getMappingIndex(datasourceId: string, concept: string): Promise<MappingIndexEntry | null> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `mapping:${datasourceId}:${concept}`;

    try {
      const value = await this.client!.get(key);
      if (!value) {
        return null;
      }

      const entry = JSON.parse(value) as MappingIndexEntry;
      logger.info('[RedisIndex] Mapping index hit', { datasourceId, concept });
      return entry;
    } catch (error) {
      logger.error('[RedisIndex] Failed to get mapping index', {
        datasourceId,
        concept,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setMappingIndex(
    datasourceId: string,
    concept: string,
    entry: MappingIndexEntry,
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `mapping:${datasourceId}:${concept}`;

    try {
      await this.client!.set(key, JSON.stringify(entry));
      logger.info('[RedisIndex] Mapping index set', { datasourceId, concept });
      } catch (error) {
      logger.error('[RedisIndex] Failed to set mapping index', {
        datasourceId,
        concept,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteMappingIndex(datasourceId: string, concept: string): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `mapping:${datasourceId}:${concept}`;

    try {
      await this.client!.del(key);
      logger.debug('[RedisIndex] Mapping index deleted', { datasourceId, concept });
    } catch (error) {
      logger.error('[RedisIndex] Failed to delete mapping index', {
        datasourceId,
        concept,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getCacheIndex(datasourceId: string, cacheKey: string): Promise<CacheIndexEntry | null> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheIndex:${datasourceId}:${cacheKey}`;

    try {
      const value = await this.client!.get(key);
      if (!value) {
        return null;
      }

      const entry = JSON.parse(value) as CacheIndexEntry;
      if (entry.expiresAt < Date.now()) {
        await this.deleteCacheIndex(datasourceId, cacheKey);
        return null;
      }

      logger.info('[RedisIndex] Cache index hit', { datasourceId, cacheKey });
      return entry;
    } catch (error) {
      logger.error('[RedisIndex] Failed to get cache index', {
        datasourceId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setCacheIndex(
    datasourceId: string,
    cacheKey: string,
    entry: CacheIndexEntry,
    ttlSeconds?: number,
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheIndex:${datasourceId}:${cacheKey}`;

    try {
      const ttl = ttlSeconds || Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
      await this.client!.setEx(key, ttl, JSON.stringify(entry));
      logger.info('[RedisIndex] Cache index set', { datasourceId, cacheKey, ttl });
      } catch (error) {
      logger.error('[RedisIndex] Failed to set cache index', {
        datasourceId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async incrementCacheHitCount(datasourceId: string, cacheKey: string): Promise<number> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheIndex:${datasourceId}:${cacheKey}`;

    try {
      const value = await this.client!.get(key);
      if (!value) {
        return 0;
      }

      const entry = JSON.parse(value) as CacheIndexEntry;
      entry.hitCount += 1;
      const ttl = Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
      await this.client!.setEx(key, ttl, JSON.stringify(entry));
      logger.info('[RedisIndex] Cache hit count incremented', {
        datasourceId,
        cacheKey,
        hitCount: entry.hitCount,
      });
      return entry.hitCount;
    } catch (error) {
      logger.error('[RedisIndex] Failed to increment cache hit count', {
        datasourceId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  }

  async deleteCacheIndex(datasourceId: string, cacheKey: string): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheIndex:${datasourceId}:${cacheKey}`;

    try {
      await this.client!.del(key);
      logger.debug('[RedisIndex] Cache index deleted', { datasourceId, cacheKey });
    } catch (error) {
      logger.error('[RedisIndex] Failed to delete cache index', {
        datasourceId,
        cacheKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getOntologyIndex(version: string): Promise<OntologyIndexEntry | null> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `ontology:${version}`;

    try {
      const value = await this.client!.get(key);
      if (!value) {
        return null;
      }

      const entry = JSON.parse(value) as OntologyIndexEntry;
      logger.debug('[RedisIndex] Ontology index hit', { version });
      return entry;
    } catch (error) {
      logger.error('[RedisIndex] Failed to get ontology index', {
        version,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setOntologyIndex(version: string, entry: OntologyIndexEntry): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `ontology:${version}`;

    try {
      await this.client!.set(key, JSON.stringify(entry));
      logger.debug('[RedisIndex] Ontology index set', { version });
    } catch (error) {
      logger.error('[RedisIndex] Failed to set ontology index', {
        version,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteOntologyIndex(version: string): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `ontology:${version}`;

    try {
      await this.client!.del(key);
      logger.debug('[RedisIndex] Ontology index deleted', { version });
    } catch (error) {
      logger.error('[RedisIndex] Failed to delete ontology index', {
        version,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getCacheConfig(datasourceId: string): Promise<CacheConfigEntry | null> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheConfig:${datasourceId}`;

    try {
      const value = await this.client!.get(key);
      if (!value) {
        return null;
      }

      const entry = JSON.parse(value) as CacheConfigEntry;
      logger.debug('[RedisIndex] Cache config retrieved', { datasourceId });
      return entry;
    } catch (error) {
      logger.error('[RedisIndex] Failed to get cache config', {
        datasourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  async setCacheConfig(datasourceId: string, entry: CacheConfigEntry): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();
    const key = `cacheConfig:${datasourceId}`;

    try {
      await this.client!.set(key, JSON.stringify(entry));
      logger.debug('[RedisIndex] Cache config set', { datasourceId });
    } catch (error) {
      logger.error('[RedisIndex] Failed to set cache config', {
        datasourceId,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async batchSetMappingIndices(
    entries: Array<{ datasourceId: string; concept: string; entry: MappingIndexEntry }>,
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();

    try {
      const pipeline = this.client!.multi();
      for (const { datasourceId, concept, entry } of entries) {
        const key = `mapping:${datasourceId}:${concept}`;
        pipeline.set(key, JSON.stringify(entry));
      }
      await pipeline.exec();
      logger.info('[RedisIndex] Batch set mapping indices', { count: entries.length });
    } catch (error) {
      logger.error('[RedisIndex] Failed to batch set mapping indices', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async batchSetCacheIndices(
    entries: Array<{
      datasourceId: string;
      cacheKey: string;
      entry: CacheIndexEntry;
      ttlSeconds?: number;
    }>,
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();

    try {
      const pipeline = this.client!.multi();
      for (const { datasourceId, cacheKey, entry, ttlSeconds } of entries) {
        const key = `cacheIndex:${datasourceId}:${cacheKey}`;
        const ttl = ttlSeconds || Math.max(0, Math.floor((entry.expiresAt - Date.now()) / 1000));
        pipeline.setEx(key, ttl, JSON.stringify(entry));
      }
      await pipeline.exec();
      logger.info('[RedisIndex] Batch set cache indices', { count: entries.length });
    } catch (error) {
      logger.error('[RedisIndex] Failed to batch set cache indices', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

let defaultIndex: RedisIndex | null = null;

export function getRedisIndex(): RedisIndex | null {
  return defaultIndex;
}

export function setRedisIndex(index: RedisIndex | null): void {
  defaultIndex = index;
}

export function createRedisIndexFromEnv(): RedisIndex {
  return new RedisIndex(process.env.REDIS_URL);
}
