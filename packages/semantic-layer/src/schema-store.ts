import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

import { getLogger } from '@qwery/shared/logger';

import type { OSISemanticModel } from './osi/types';
import type {
  DiscoveryStatus,
  DiscoveryStatusRecord,
  SemanticModelStatusRecord,
} from './types';

export interface OsiModelRecord {
  datasourceId: string;
  semanticModelId: string;
  generatedAt: string;
  model: OSISemanticModel;
}

function getStoreDir(): string {
  const storageDir = process.env['QWERY_STORAGE_DIR'] ?? 'qwery.db';
  return join(storageDir, 'semantic-layer');
}

function recordPath(datasourceId: string): string {
  return join(getStoreDir(), `${datasourceId}.json`);
}

async function ensureStoreDir(): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true });
}

export async function saveDiscoveryRecord(
  record: DiscoveryStatusRecord,
): Promise<void> {
  await ensureStoreDir();
  await writeFile(
    recordPath(record.datasourceId),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}

export async function loadDiscoveryRecord(
  datasourceId: string,
): Promise<DiscoveryStatusRecord | null> {
  try {
    const raw = await readFile(recordPath(datasourceId), 'utf-8');
    return JSON.parse(raw) as DiscoveryStatusRecord;
  } catch {
    return null;
  }
}

export async function saveOsiModel(
  datasourceId: string,
  semanticModelId: string,
  model: OSISemanticModel,
): Promise<void> {
  await ensureStoreDir();
  const record: OsiModelRecord = {
    datasourceId,
    semanticModelId,
    generatedAt: new Date().toISOString(),
    model,
  };
  const path = join(getStoreDir(), `${datasourceId}.osm.json`);
  await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
}

export async function loadOsiModel(
  datasourceId: string,
): Promise<OsiModelRecord | null> {
  try {
    const path = join(getStoreDir(), `${datasourceId}.osm.json`);
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as OsiModelRecord;
  } catch {
    return null;
  }
}

export async function saveSemanticModelStatusRecord(
  record: SemanticModelStatusRecord,
): Promise<void> {
  await ensureStoreDir();
  const path = join(getStoreDir(), `${record.datasourceId}.sm-status.json`);
  await writeFile(path, JSON.stringify(record, null, 2), 'utf-8');
}

export async function loadSemanticModelStatusRecord(
  datasourceId: string,
): Promise<SemanticModelStatusRecord | null> {
  try {
    const path = join(getStoreDir(), `${datasourceId}.sm-status.json`);
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as SemanticModelStatusRecord;
  } catch {
    return null;
  }
}

export async function updateDiscoveryStatus(
  datasourceId: string,
  status: DiscoveryStatus,
  error?: string,
): Promise<void> {
  const existing = await loadDiscoveryRecord(datasourceId);
  const record: DiscoveryStatusRecord = {
    datasourceId,
    status,
    updatedAt: new Date().toISOString(),
    error: error ?? null,
    schema: existing?.schema ?? null,
  };
  await saveDiscoveryRecord(record);
  const logger = await getLogger();
  logger.info({ datasourceId, status }, 'semantic-layer: status updated');
}
