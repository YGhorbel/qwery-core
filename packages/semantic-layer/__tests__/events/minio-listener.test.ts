import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MinIOEventListener } from '../../src/events/minio-listener';
import { MinIOStore } from '../../src/storage/minio-store';
import { RedisIndex } from '../../src/index/redis-index';
import { NATSPublisher } from '../../src/events/nats-publisher';
import { MinIOClient } from '../../src/storage/minio-client';

describe('MinIOEventListener', () => {
  let minIOStore: MinIOStore;
  let redisIndex: RedisIndex;
  let natsPublisher: NATSPublisher;
  let listener: MinIOEventListener;

  beforeAll(async () => {
    const endpoint = process.env.MINIO_ENDPOINT || 'localhost:9000';
    const accessKeyId = process.env.MINIO_ACCESS_KEY_ID || 'minioadmin';
    const secretAccessKey = process.env.MINIO_SECRET_ACCESS_KEY || 'minioadmin';
    const bucket = process.env.MINIO_BUCKET || 'test-semantic-layer';

    const minIOClient = new MinIOClient({
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket,
      useSSL: false,
      pathStyle: true,
    });

    minIOStore = new MinIOStore(minIOClient);

    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    redisIndex = new RedisIndex(redisUrl);
    await redisIndex.connect();

    const natsUrl = process.env.NATS_URL || 'nats://localhost:4222';
    natsPublisher = new NATSPublisher(natsUrl);
    try {
      await natsPublisher.connect();
    } catch {
    }

    listener = new MinIOEventListener({
      minIOStore,
      redisIndex,
      natsPublisher,
      dryRun: true,
    });
  });

  afterAll(async () => {
    await redisIndex.disconnect();
    await natsPublisher.disconnect();
  });

  it('should handle ontology upload event', async () => {
    const event = {
      EventName: 's3:ObjectCreated:Put',
      Key: 'incoming/test-datasource-1/ontology/test.yaml',
    };

    await expect(listener.handleEvent(event)).resolves.not.toThrow();
  });

  it('should handle mapping upload event', async () => {
    const event = {
      EventName: 's3:ObjectCreated:Put',
      Key: 'incoming/test-datasource-1/mappings/test.json',
    };

    await expect(listener.handleEvent(event)).resolves.not.toThrow();
  });
});
