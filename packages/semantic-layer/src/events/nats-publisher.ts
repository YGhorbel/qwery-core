import { connect, JSONCodec, type NatsConnection } from 'nats';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface SemanticUpdateEvent {
  type: 'semantic.update.succeeded' | 'semantic.update.failed';
  datasourceId: string;
  version?: string;
  timestamp: string;
  diffSummary?: {
    conceptsAdded?: number;
    conceptsRemoved?: number;
    mappingsAdded?: number;
    mappingsRemoved?: number;
  };
  checksums?: {
    ontology?: string;
    mappings?: string;
  };
  error?: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

export class NATSPublisher {
  private connection: NatsConnection | null = null;
  private codec: ReturnType<typeof JSONCodec<SemanticUpdateEvent>> | null = null;
  private connected = false;
  private topic = 'semantic-events';

  constructor(private url?: string, topic?: string) {
    if (topic) {
      this.topic = topic;
    }
  }

  async connect(): Promise<void> {
    if (this.connected && this.connection) {
      return;
    }

    const logger = await getLogger();
    const natsUrl = this.url || process.env.NATS_URL;

    if (!natsUrl) {
      logger.warn('[NATSPublisher] NATS_URL not configured, event publishing disabled');
      return;
    }

    try {
      this.codec = JSONCodec<SemanticUpdateEvent>();
      this.connection = await connect({ servers: natsUrl });
      this.connected = true;
      logger.info('[NATSPublisher] Connected to NATS', { url: natsUrl });
    } catch (error) {
      logger.error('[NATSPublisher] Failed to connect to NATS', {
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    if (this.connection && this.connected) {
      await this.connection.close();
      this.connected = false;
    }
  }

  private ensureConnected(): void {
    if (!this.connected || !this.connection || !this.codec) {
      throw new Error('NATS client not connected. Call connect() first.');
    }
  }

  async publishSemanticUpdate(
    datasourceId: string,
    version: string,
    diffSummary?: SemanticUpdateEvent['diffSummary'],
    checksums?: SemanticUpdateEvent['checksums'],
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();

    const event: SemanticUpdateEvent = {
      type: 'semantic.update.succeeded',
      datasourceId,
      version,
      timestamp: new Date().toISOString(),
      diffSummary,
      checksums,
    };

    try {
      const data = this.codec!.encode(event);
      await this.connection!.publish(this.topic, data);
      logger.info('[NATSPublisher] Published semantic.update.succeeded', {
        datasourceId,
        version,
        topic: this.topic,
      });
    } catch (error) {
      logger.error('[NATSPublisher] Failed to publish semantic.update.succeeded', {
        datasourceId,
        version,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async publishSemanticUpdateFailed(
    datasourceId: string,
    error: Error | string,
    details?: unknown,
  ): Promise<void> {
    this.ensureConnected();
    const logger = await getLogger();

    const event: SemanticUpdateEvent = {
      type: 'semantic.update.failed',
      datasourceId,
      timestamp: new Date().toISOString(),
      error: {
        message: error instanceof Error ? error.message : String(error),
        code: error instanceof Error ? error.name : undefined,
        details,
      },
    };

    try {
      const data = this.codec!.encode(event);
      await this.connection!.publish(this.topic, data);
      logger.info('[NATSPublisher] Published semantic.update.failed', {
        datasourceId,
        topic: this.topic,
      });
    } catch (err) {
      logger.error('[NATSPublisher] Failed to publish semantic.update.failed', {
        datasourceId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }
}

let defaultPublisher: NATSPublisher | null = null;

export function getNATSPublisher(): NATSPublisher | null {
  return defaultPublisher;
}

export function setNATSPublisher(publisher: NATSPublisher | null): void {
  defaultPublisher = publisher;
}

export function createNATSPublisherFromEnv(): NATSPublisher {
  const topic = process.env.SEMANTIC_EVENTS_TOPIC || 'semantic-events';
  return new NATSPublisher(process.env.NATS_URL, topic);
}
