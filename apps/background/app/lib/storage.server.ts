import { readdir, readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import yaml from 'yaml';

export const storageDir = (): string =>
  process.env.QWERY_STORAGE_DIR ?? 'qwery.db';

export type SemanticField = {
  label?: string;
  description?: string;
  type?: string;
  table?: string;
  sql?: string;
  synonyms?: string[];
  format?: string;
  filters?: string[];
  confidence?: number;
  flagged?: boolean;
  flagReason?: string;
  when_to_use?: string;
  hidden?: boolean;
};

export type JoinDef = {
  from: string;
  to: string;
  type: string;
  sql_on: string;
  relationship?: string;
};

export type SemanticLayer = {
  measures?: Record<string, SemanticField>;
  dimensions?: Record<string, SemanticField>;
  business_rules?: Record<string, SemanticField>;
  joins?: Record<string, JoinDef>;
};

export type MeasureCandidate = {
  id: string;
  expression: string;
  question: string;
  proposedAt: string;
  validated: boolean;
};

export type DatasourceInfo = {
  id: string;
  shortId: string;
  hasSemanticLayer: boolean;
  hasCandidates: boolean;
  measureCount: number;
  dimensionCount: number;
  ruleCount: number;
  flaggedCount: number;
  lowConfidenceCount: number;
};

export async function listDatasources(): Promise<DatasourceInfo[]> {
  const dsDir = join(storageDir(), 'datasources');
  let ids: string[];
  try {
    const entries = await readdir(dsDir, { withFileTypes: true });
    ids = entries.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }

  return Promise.all(
    ids.map(async (id) => {
      const slPath = join(dsDir, id, 'semantic_layer.yaml');
      const candidatesPath = join(dsDir, id, 'measure_candidates.json');

      let hasSemanticLayer = false;
      let measureCount = 0;
      let dimensionCount = 0;
      let ruleCount = 0;
      let flaggedCount = 0;
      let lowConfidenceCount = 0;

      try {
        const raw = await readFile(slPath, 'utf-8');
        const layer = yaml.parse(raw) as SemanticLayer;
        hasSemanticLayer = true;
        measureCount = Object.keys(layer.measures ?? {}).length;
        dimensionCount = Object.keys(layer.dimensions ?? {}).length;
        ruleCount = Object.keys(layer.business_rules ?? {}).length;
        const allFields = [
          ...Object.values(layer.measures ?? {}),
          ...Object.values(layer.dimensions ?? {}),
        ];
        flaggedCount = allFields.filter((f) => f.flagged).length;
        lowConfidenceCount = allFields.filter(
          (f) => (f.confidence ?? 1) < 0.5,
        ).length;
      } catch {
        // no semantic layer
      }

      let hasCandidates = false;
      try {
        await access(candidatesPath);
        hasCandidates = true;
      } catch {
        // no candidates
      }

      return {
        id,
        shortId: id.slice(0, 8),
        hasSemanticLayer,
        hasCandidates,
        measureCount,
        dimensionCount,
        ruleCount,
        flaggedCount,
        lowConfidenceCount,
      };
    }),
  );
}

export async function getSemanticLayer(
  datasourceId: string,
): Promise<SemanticLayer | null> {
  const slPath = join(
    storageDir(),
    'datasources',
    datasourceId,
    'semantic_layer.yaml',
  );
  try {
    const raw = await readFile(slPath, 'utf-8');
    return yaml.parse(raw) as SemanticLayer;
  } catch {
    return null;
  }
}

export async function getMeasureCandidates(
  datasourceId: string,
): Promise<MeasureCandidate[]> {
  const candidatesPath = join(
    storageDir(),
    'datasources',
    datasourceId,
    'measure_candidates.json',
  );
  try {
    const raw = await readFile(candidatesPath, 'utf-8');
    return JSON.parse(raw) as MeasureCandidate[];
  } catch {
    return [];
  }
}

export type FlatField = SemanticField & {
  id: string;
  fieldType: 'measure' | 'dimension' | 'business_rule';
};

export function flattenLayer(layer: SemanticLayer): FlatField[] {
  const fields: FlatField[] = [];
  for (const [id, f] of Object.entries(layer.measures ?? {}))
    fields.push({ ...f, id, fieldType: 'measure' });
  for (const [id, f] of Object.entries(layer.dimensions ?? {}))
    fields.push({ ...f, id, fieldType: 'dimension' });
  for (const [id, f] of Object.entries(layer.business_rules ?? {}))
    fields.push({ ...f, id, fieldType: 'business_rule' });
  return fields;
}
