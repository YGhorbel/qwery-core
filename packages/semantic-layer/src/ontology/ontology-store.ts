import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

function getStoreDir(): string {
  const storageDir = process.env['QWERY_STORAGE_DIR'] ?? 'qwery.db';
  return join(storageDir, 'semantic-layer');
}

function ontologyPath(datasourceId: string): string {
  return join(getStoreDir(), `${datasourceId}.ontology.json`);
}

export type OntologyStatus = 'indexing' | 'ready' | 'failed';

export interface OntologyRecord {
  datasourceId: string;
  status: OntologyStatus;
  nodeCount: number;
  relationshipCount: number;
  datasetCount: number;
  indexedAt: string | null;
  error: string | null;
}

export async function saveOntologyRecord(
  record: OntologyRecord,
): Promise<void> {
  await mkdir(getStoreDir(), { recursive: true });
  await writeFile(
    ontologyPath(record.datasourceId),
    JSON.stringify(record, null, 2),
    'utf-8',
  );
}

export async function loadOntologyRecord(
  datasourceId: string,
): Promise<OntologyRecord | null> {
  try {
    const raw = await readFile(ontologyPath(datasourceId), 'utf-8');
    return JSON.parse(raw) as OntologyRecord;
  } catch {
    return null;
  }
}
