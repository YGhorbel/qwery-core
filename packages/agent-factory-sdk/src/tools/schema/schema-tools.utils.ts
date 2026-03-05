import type { Repositories } from '@qwery/domain/repositories';
import {
  GetDatasourceSchemaService,
  TransformMetadataToCompactSchemaService,
} from '@qwery/domain/services';
import type { GetSchemaMode } from '@qwery/domain/usecases';
import { NodeDatasourceMetadataRepository } from '../../adapters/node-datasource-metadata.repository';

const DEFAULT_SCHEMA_MODE: GetSchemaMode = 'compact';
const ESTIMATED_CHARS_PER_TOKEN = 4;

export function resolveGetSchemaMode(
  envMode = process.env.QWERY_GET_SCHEMA_MODE,
) {
  if (envMode === 'legacy') {
    return 'legacy' as const;
  }

  return DEFAULT_SCHEMA_MODE;
}

export function createDatasourceSchemaService(repositories: Repositories) {
  return new GetDatasourceSchemaService(
    repositories.datasource,
    new NodeDatasourceMetadataRepository(),
    new TransformMetadataToCompactSchemaService(),
  );
}

export function logSchemaPayloadStats(
  logger: {
    debug: (message: string, payload: Record<string, unknown>) => void;
  },
  toolName: string,
  payload: unknown,
) {
  const serialized = JSON.stringify(payload) ?? 'null';
  const payloadBytes = Buffer.byteLength(serialized, 'utf8');
  const estimatedTokens = Math.ceil(
    serialized.length / ESTIMATED_CHARS_PER_TOKEN,
  );

  logger.debug(`[${toolName}] Payload stats`, {
    payloadBytes,
    estimatedTokens,
  });
}
