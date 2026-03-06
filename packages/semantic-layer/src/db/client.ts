import { Client, type QueryResult as PgQueryResult, type QueryResultRow } from 'pg';
import type { ConnectionOptions } from 'tls';
import type { Datasource } from '@qwery/domain/entities';
import { extractConnectionUrl } from '@qwery/extensions-sdk';

function buildPgConfig(connectionUrl: string) {
  const url = new URL(connectionUrl);
  const sslmode = url.searchParams.get('sslmode');
  const ssl: ConnectionOptions | undefined =
    sslmode === 'require'
      ? {
          rejectUnauthorized: false,
          checkServerIdentity: () => undefined,
        }
      : undefined;

  return {
    user: url.username ? decodeURIComponent(url.username) : undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    host: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    database: url.pathname ? url.pathname.replace(/^\//, '') || undefined : undefined,
    ssl,
  };
}

export interface SemanticDbClient {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[],
  ): Promise<PgQueryResult<T>>;
  close(): Promise<void>;
}

export async function createSemanticDbClient(
  datasource: Datasource,
): Promise<SemanticDbClient> {
  const connectionUrl = extractConnectionUrl(
    datasource.config as Record<string, unknown>,
    'postgresql',
  );
  const config = buildPgConfig(connectionUrl);
  const client = new Client(config);
  await client.connect();

  return {
    query: <T extends QueryResultRow = QueryResultRow>(
      text: string,
      params?: unknown[],
    ) => client.query<T>(text, params),
    close: () => client.end(),
  };
}
