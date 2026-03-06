import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { MinIOClient, getMinIOClient } from '../storage/minio-client';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface QueryLogEntry {
  query: string;
  datasourceId: string;
  ontologyVersion: string;
  semanticPlan?: unknown;
  compiledSQL?: string;
  timestamp: string;
  executionTimeMs?: number;
  resultRowCount?: number;
  error?: string;
}

export class QueryHistoryLogger {
  private client: MinIOClient | null;
  private enabled: boolean;

  constructor(client: MinIOClient | null, enabled = true) {
    this.client = client;
    this.enabled = enabled;
  }

  async logQuery(entry: QueryLogEntry): Promise<void> {
    if (!this.enabled || !this.client) {
      return;
    }

    const logger = await getLogger();
    const date = new Date(entry.timestamp);
    const dateStr = date.toISOString().split('T')[0];
    const path = `history/queries/${dateStr}.jsonl`;

    try {
      const logLine = JSON.stringify(entry) + '\n';
      const existingContent = await this.client.getObject(path);
      const newContent = (existingContent?.content || '') + logLine;
      await this.client.putObject(path, newContent, 'text/plain');
      
      logger.debug('[QueryHistoryLogger] Query logged', {
        datasourceId: entry.datasourceId,
        date: dateStr,
      });
    } catch (error) {
      logger.warn('[QueryHistoryLogger] Failed to log query', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async getQueryHistory(
    datasourceId: string,
    startDate?: Date,
    endDate?: Date,
  ): Promise<QueryLogEntry[]> {
    if (!this.client) {
      return [];
    }

    const logger = await getLogger();
    const entries: QueryLogEntry[] = [];

    try {
      const files = await this.client.listObjects('history/queries/');
      const dateFiles = files.filter((f) => f.endsWith('.jsonl'));

      for (const file of dateFiles) {
        const dateStr = file.replace('history/queries/', '').replace('.jsonl', '');
        const fileDate = new Date(dateStr);

        if (startDate && fileDate < startDate) continue;
        if (endDate && fileDate > endDate) continue;

        const object = await this.client.getObject(file);
        if (!object) continue;

        const lines = object.content.split('\n').filter((l) => l.trim());
        for (const line of lines) {
          try {
            const entry = JSON.parse(line) as QueryLogEntry;
            if (entry.datasourceId === datasourceId) {
              entries.push(entry);
            }
          } catch (parseError) {
            logger.warn('[QueryHistoryLogger] Failed to parse log entry', {
              file,
              error: parseError instanceof Error ? parseError.message : String(parseError),
            });
          }
        }
      }

      entries.sort((a, b) => 
        new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );

      logger.debug('[QueryHistoryLogger] Retrieved query history', {
        datasourceId,
        entriesCount: entries.length,
      });
    } catch (error) {
      logger.error('[QueryHistoryLogger] Failed to get query history', {
        datasourceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return entries;
  }
}

let defaultLogger: QueryHistoryLogger | null = null;

export function getQueryHistoryLogger(): QueryHistoryLogger | null {
  if (!defaultLogger) {
    const client = getMinIOClient();
    defaultLogger = new QueryHistoryLogger(client, true);
  }
  return defaultLogger;
}
