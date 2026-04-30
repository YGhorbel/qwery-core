import fs from 'node:fs/promises';
import path from 'node:path';
import yaml from 'yaml';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { LabelMap, SemanticLayer, Ontology, ValidationResult } from './types.js';

export function getDatasourceDir(datasourceId: string): string {
  const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
  return path.join(storageDir, 'datasources', datasourceId);
}

export function getSkillsDir(): string {
  const workspace = process.env.WORKSPACE ?? process.cwd();
  return path.join(workspace, '.qwery', 'skills');
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

export async function writeJson<T>(filePath: string, data: T): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function writeYaml(filePath: string, data: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, yaml.stringify(data), 'utf-8');
}

export async function readYaml<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    return yaml.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

// Convenience paths

export const paths = {
  schema: (id: string) => path.join(getDatasourceDir(id), 'schema.json'),
  labelMap: (id: string) => path.join(getDatasourceDir(id), 'label_map.json'),
  semanticLayer: (id: string) => path.join(getDatasourceDir(id), 'semantic_layer.yaml'),
  ontology: (id: string) => path.join(getDatasourceDir(id), 'ontology.json'),
  validationReport: (id: string) => path.join(getDatasourceDir(id), 'validation_report.json'),
  glossarySkill: (slug: string) => path.join(getSkillsDir(), `${slug}-glossary.md`),
  metricsSkill: (slug: string) => path.join(getSkillsDir(), `${slug}-metrics.md`),
};

// Typed read/write helpers

export async function readSchemaMetadata(datasourceId: string): Promise<DatasourceMetadata | null> {
  const raw = await readJson<{ metadata: DatasourceMetadata; cachedAt: number }>(
    paths.schema(datasourceId),
  );
  return raw?.metadata ?? null;
}

export async function readLabelMap(datasourceId: string): Promise<LabelMap | null> {
  return readJson<LabelMap>(paths.labelMap(datasourceId));
}

export async function writeLabelMap(datasourceId: string, data: LabelMap): Promise<void> {
  await writeJson(paths.labelMap(datasourceId), data);
}

export async function readSemanticLayer(datasourceId: string): Promise<SemanticLayer | null> {
  return readYaml<SemanticLayer>(paths.semanticLayer(datasourceId));
}

export async function writeSemanticLayer(datasourceId: string, data: SemanticLayer): Promise<void> {
  await writeYaml(paths.semanticLayer(datasourceId), data);
}

export async function readOntology(datasourceId: string): Promise<Ontology | null> {
  return readJson<Ontology>(paths.ontology(datasourceId));
}

export async function writeOntology(datasourceId: string, data: Ontology): Promise<void> {
  await writeJson(paths.ontology(datasourceId), data);
}

export async function writeValidationReport(
  datasourceId: string,
  results: ValidationResult[],
): Promise<void> {
  await writeJson(paths.validationReport(datasourceId), results);
}
