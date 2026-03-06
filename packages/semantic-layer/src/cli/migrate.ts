#!/usr/bin/env tsx

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { validateOntology } from '../loader/yaml-loader';

const __dirname = fileURLToPath(new URL('.', import.meta.url));

function loadEnvFile(filePath: string): void {
  if (!existsSync(filePath)) {
    return;
  }

  try {
    const content = readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) {
        continue;
      }

      const equalIndex = trimmed.indexOf('=');
      if (equalIndex === -1) {
        continue;
      }

      const key = trimmed.substring(0, equalIndex).trim();
      let value = trimmed.substring(equalIndex + 1).trim();

      if (value.startsWith('"') && value.endsWith('"')) {
        value = value.slice(1, -1);
      } else if (value.startsWith("'") && value.endsWith("'")) {
        value = value.slice(1, -1);
      }

      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch (error) {
    // Silently ignore errors loading .env files
  }
}

function loadEnvFiles(): void {
  const repoRoot = resolve(__dirname, '../../../../');
  const currentDir = process.cwd();

  const envPaths = [
    join(currentDir, '.env'),
    join(repoRoot, '.env'),
    join(repoRoot, 'apps', 'server', '.env'),
    join(repoRoot, 'packages', 'semantic-layer', '.env'),
  ];

  for (const envPath of envPaths) {
    if (existsSync(envPath)) {
      loadEnvFile(envPath);
    }
  }
}

interface MigrationConfig {
  ontologyPath?: string;
  ontologyVersion?: string;
}

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

async function parseArgs(): Promise<MigrationConfig> {
  const args = process.argv.slice(2);
  const config: MigrationConfig = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const nextArg = args[i + 1];
    if (arg === '--ontology' && nextArg) {
      config.ontologyPath = nextArg;
      i++;
    } else if (arg === '--version' && nextArg) {
      config.ontologyVersion = nextArg;
      i++;
    } else if (arg === '--help' || arg === '-h') {
      console.log(`
Usage: pnpm semantic:migrate [options]

Options:
  --ontology <path>      Path to ontology YAML file (default: models/default-ontology.yaml)
  --version <version>    Ontology version (default: 1.0.0)
  --help, -h            Show this help message

Environment Variables:
  MINIO_ENDPOINT         MinIO server endpoint
  MINIO_ACCESS_KEY_ID    MinIO access key
  MINIO_SECRET_ACCESS_KEY MinIO secret key
  MINIO_BUCKET           MinIO bucket name (default: qwery-semantic-layer)
  REDIS_URL              Redis connection URL

Example:
  pnpm semantic:migrate --ontology models/default-ontology.yaml --version 1.0.0
`);
      process.exit(0);
    }
  }

  return config;
}

async function loadOntology(
  ontologyPath: string,
  version: string,
): Promise<void> {
  const logger = await getLogger();

  logger.info({ path: ontologyPath, version }, 'Loading ontology from YAML');

  const fileContent = readFileSync(ontologyPath, 'utf-8');
  const parsed = parse(fileContent);
  const ontology = validateOntology(parsed);

  const { createMinIOStoreFromClient } = await import('../storage/minio-store');
  const { createMinIOClientFromEnv } = await import('../storage/minio-client');
  const { createRedisIndexFromEnv } = await import('../index/redis-index');
  const minIOClient = createMinIOClientFromEnv();

  if (!minIOClient) {
    throw new Error('MinIO client not available. Set MINIO_ENDPOINT, MINIO_ACCESS_KEY_ID, and MINIO_SECRET_ACCESS_KEY environment variables.');
  }

  const minIOStore = createMinIOStoreFromClient(minIOClient);
  const redisIndex = createRedisIndexFromEnv();

  try {
    await redisIndex.connect();
    const ontologyStore = minIOStore.createOntologyStore();
    await ontologyStore.put(version, ontology);

    const s3Path = `ontology/${version}/base.yaml`;
    await redisIndex.setOntologyIndex(version, {
      s3Path,
      version,
    });

    logger.info({ version }, 'Ontology loaded successfully to MinIO');
  } catch (error) {
    logger.error({ error }, 'Failed to load ontology to MinIO');
    throw error;
  } finally {
    await redisIndex.disconnect();
  }
}

function resolveOntologyPath(path?: string): string {
  if (!path) {
    return join(__dirname, '../../models/default-ontology.yaml');
  }

  if (path.startsWith('/')) {
    return path;
  }

  const repoRoot = resolve(__dirname, '../../../../');
  const cwdPath = resolve(process.cwd(), path);
  const repoRootPath = resolve(repoRoot, path);
  const packagePath = resolve(__dirname, '../../', path);

  if (existsSync(cwdPath)) {
    return cwdPath;
  }
  if (existsSync(repoRootPath)) {
    return repoRootPath;
  }
  if (existsSync(packagePath)) {
    return packagePath;
  }

  return path;
}

async function main(): Promise<void> {
  loadEnvFiles();

  const logger = await getLogger();

  try {
    const config = await parseArgs();
    const version = config.ontologyVersion || '1.0.0';
    const ontologyPath = resolveOntologyPath(config.ontologyPath);

    logger.info('Loading ontology to MinIO');

    await loadOntology(ontologyPath, version);

    logger.info('Migration completed successfully');
  } catch (error) {
    logger.error({ error }, 'Migration failed');
    console.error('Migration failed:', error);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('Unhandled error:', error);
  process.exit(1);
});
