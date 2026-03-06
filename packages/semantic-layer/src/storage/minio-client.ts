import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

export interface MinIOConfig {
  endpoint: string;
  accessKeyId: string;
  secretAccessKey: string;
  bucket: string;
  region?: string;
  useSSL?: boolean;
  pathStyle?: boolean;
}

export interface MinIOObject {
  key: string;
  content: string;
  lastModified?: Date;
  size?: number;
}

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export class MinIOClient {
  private client: S3Client;
  private bucket: string;
  private basePrefix: string;

  constructor(config: MinIOConfig, basePrefix = 'semantic-layer') {
    this.bucket = config.bucket;
    this.basePrefix = basePrefix;

    const endpoint = config.endpoint.startsWith('http') 
      ? config.endpoint 
      : `${config.useSSL !== false ? 'https' : 'http'}://${config.endpoint}`;

    this.client = new S3Client({
      endpoint,
      region: config.region || 'us-east-1',
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
      forcePathStyle: config.pathStyle ?? true,
    });
  }

  private async logDebug(message: string, data?: Record<string, unknown>): Promise<void> {
    const logger = await getLogger();
    logger.debug(`[MinIOClient] ${message}`, data);
  }

  private async logError(message: string, data?: Record<string, unknown>): Promise<void> {
    const logger = await getLogger();
    logger.error(`[MinIOClient] ${message}`, data);
  }

  private getKey(path: string): string {
    const normalizedPath = path.replace(/^\//, '').replace(/\/$/, '');
    return this.basePrefix ? `${this.basePrefix}/${normalizedPath}` : normalizedPath;
  }

  async getObject(path: string): Promise<MinIOObject | null> {
    const key = this.getKey(path);

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);
      
      if (!response.Body) {
        return null;
      }

      const content = await response.Body.transformToString();
      const lastModified = response.LastModified;

      await this.logDebug('Retrieved object', {
        key,
        size: content.length,
        lastModified,
      });

      return {
        key,
        content,
        lastModified,
        size: content.length,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === 'NoSuchKey' || error.name === 'NotFound')) {
        await this.logDebug('Object not found', { key });
        return null;
      }
      await this.logError('Failed to get object', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async putObject(path: string, content: string, contentType = 'application/json'): Promise<void> {
    const key = this.getKey(path);

    try {
      const command = new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: content,
        ContentType: contentType,
      });

      await this.client.send(command);

      await this.logDebug('Stored object', {
        key,
        size: content.length,
        contentType,
      });
    } catch (error) {
      await this.logError('Failed to put object', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async objectExists(path: string): Promise<boolean> {
    const key = this.getKey(path);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);
      return true;
    } catch (error) {
      if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
        await this.logDebug('Object does not exist', { key });
        return false;
      }
      await this.logError('Failed to check object existence', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async listObjects(prefix: string): Promise<string[]> {
    const keyPrefix = this.getKey(prefix);

    try {
      const command = new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: keyPrefix,
      });

      const response = await this.client.send(command);
      const keys = (response.Contents || [])
        .map((obj) => obj.Key)
        .filter((key): key is string => !!key)
        .map((key) => {
          if (this.basePrefix && key.startsWith(`${this.basePrefix}/`)) {
            return key.substring(this.basePrefix.length + 1);
          }
          return key;
        });

      await this.logDebug('Listed objects', {
        prefix: keyPrefix,
        count: keys.length,
      });

      return keys;
    } catch (error) {
      await this.logError('Failed to list objects', {
        prefix: keyPrefix,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async deleteObject(path: string): Promise<void> {
    const key = this.getKey(path);

    try {
      const command = new DeleteObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      await this.client.send(command);

      await this.logDebug('Deleted object', { key });
    } catch (error) {
      await this.logError('Failed to delete object', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async getObjectMetadata(path: string): Promise<{ lastModified?: Date; size?: number } | null> {
    const key = this.getKey(path);

    try {
      const command = new HeadObjectCommand({
        Bucket: this.bucket,
        Key: key,
      });

      const response = await this.client.send(command);

      return {
        lastModified: response.LastModified,
        size: response.ContentLength,
      };
    } catch (error) {
      if (error instanceof Error && (error.name === 'NotFound' || error.name === 'NoSuchKey')) {
        await this.logDebug('Object metadata not found', { key });
        return null;
      }
      await this.logError('Failed to get object metadata', {
        key,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }
}

let defaultClient: MinIOClient | null = null;

export function getMinIOClient(): MinIOClient | null {
  return defaultClient;
}

export function setMinIOClient(client: MinIOClient | null): void {
  defaultClient = client;
}

export function createMinIOClientFromEnv(): MinIOClient | null {
  const endpoint = process.env.MINIO_ENDPOINT;
  const accessKeyId = process.env.MINIO_ACCESS_KEY_ID;
  const secretAccessKey = process.env.MINIO_SECRET_ACCESS_KEY;
  const bucket = process.env.MINIO_BUCKET || 'qwery-semantic-layer';
  const region = process.env.MINIO_REGION;
  const useSSL = process.env.MINIO_USE_SSL !== 'false';
  const pathStyle = process.env.MINIO_PATH_STYLE !== 'false';

  if (!endpoint || !accessKeyId || !secretAccessKey) {
    return null;
  }

  return new MinIOClient({
    endpoint,
    accessKeyId,
    secretAccessKey,
    bucket,
    region,
    useSSL,
    pathStyle,
  });
}
