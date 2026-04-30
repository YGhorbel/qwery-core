import fs from 'node:fs/promises';
import path from 'node:path';

export type MeasureCandidate = {
  id: string;
  expression: string;
  question: string;
  proposedAt: string;
  seenCount: number;
  validated: boolean;
  table?: string;
  // LLM-enriched — populated on first capture (seenCount = 1)
  label?: string;
  description?: string;
  format?: 'currency_usd' | 'integer' | 'percent' | 'decimal';
  synonyms?: string[];
  filters?: string[];
  labeledAt?: string;   // ISO timestamp set when the LLM label is written
  rejected?: boolean;   // set to true if manually or automatically rejected
};

export type ArtifactProposal = {
  id: string;
  type: 'business_rule';
  datasourceId: string;
  sql: string;
  question: string;
  table: string;
  proposedAt: string;
  seenCount: number;
  promoted: boolean;
  label?: string;
  description?: string;
};

async function atomicWrite(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`;
  await fs.writeFile(tmp, content, 'utf-8');
  await fs.rename(tmp, filePath);
}

function candidatesPath(storageDir: string, datasourceId: string): string {
  return path.join(storageDir, 'datasources', datasourceId, 'measure_candidates.json');
}

function proposalsPath(storageDir: string, datasourceId: string): string {
  return path.join(storageDir, 'datasources', datasourceId, 'artifact_proposals.json');
}

export async function readCandidates(
  storageDir: string,
  datasourceId: string,
): Promise<MeasureCandidate[]> {
  try {
    const raw = await fs.readFile(candidatesPath(storageDir, datasourceId), 'utf-8');
    return JSON.parse(raw) as MeasureCandidate[];
  } catch {
    return [];
  }
}

export async function writeCandidates(
  storageDir: string,
  datasourceId: string,
  candidates: MeasureCandidate[],
): Promise<void> {
  const p = candidatesPath(storageDir, datasourceId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await atomicWrite(p, JSON.stringify(candidates, null, 2));
}

export async function readProposals(
  storageDir: string,
  datasourceId: string,
): Promise<ArtifactProposal[]> {
  try {
    const raw = await fs.readFile(proposalsPath(storageDir, datasourceId), 'utf-8');
    return JSON.parse(raw) as ArtifactProposal[];
  } catch {
    return [];
  }
}

export async function writeProposals(
  storageDir: string,
  datasourceId: string,
  proposals: ArtifactProposal[],
): Promise<void> {
  const p = proposalsPath(storageDir, datasourceId);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await atomicWrite(p, JSON.stringify(proposals, null, 2));
}
