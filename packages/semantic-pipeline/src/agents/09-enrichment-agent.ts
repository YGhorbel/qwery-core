/**
 * Agent 09 — Semantic Layer Enrichment
 * Fires after every successful query to discover missing measures and business rules.
 * All I/O is fire-and-forget — never blocks the HTTP response.
 */
import { routeModel, extractR1Response } from '@qwery/agent-factory-sdk';
import { chatComplete } from '../llm-client.js';
import {
  readCandidates,
  writeCandidates,
  readProposals,
  writeProposals,
  type MeasureCandidate,
  type ArtifactProposal,
} from '../updater/artifact-proposals.js';

const AUTO_ENRICH_THRESHOLD = 1;

export type EnrichmentInput = {
  datasourceId: string;
  question: string;
  sqlFinal: string;
  fieldsUsed: Array<{ field_id: string; label: string; sql: string }>;
  queryPlan: { intent: string; cotPlan?: string; complexity: number };
  correctionTrace?: Record<string, unknown> | null;
};

function normalizeExpr(expr: string): string {
  return expr.toLowerCase().replace(/\s+/g, ' ').trim();
}

function extractAggregates(sql: string): string[] {
  const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM\b/i);
  if (!selectMatch?.[1]) return [];

  const found: string[] = [];
  const aggPattern = /\b(SUM|COUNT|AVG|MAX|MIN|ROUND|COALESCE|NULLIF)\s*\([^)]+\)/gi;
  let match: RegExpExecArray | null;
  while ((match = aggPattern.exec(selectMatch[1])) !== null) {
    found.push(match[0].trim());
  }
  return [...new Set(found)];
}

function extractTable(sql: string): string {
  const match = sql.match(/FROM\s+["'`]?(\w+)["'`]?/i);
  return match?.[1] ?? '';
}

function extractWhereConditions(sql: string): string[] {
  const whereMatch = sql.match(
    /WHERE\s+([\s\S]+?)(?:\s+(?:GROUP\s+BY|ORDER\s+BY|LIMIT|HAVING|UNION)\b|$)/i,
  );
  if (!whereMatch?.[1]) return [];

  const found: string[] = [];
  // Match conditions that reference a literal value (string, number, NULL, IN list)
  const condPattern =
    /\b(\w+)\s*(?:IS\s+NOT\s+NULL|IS\s+NULL|IN\s*\([^)]+\)|(?:[!=<>]+|NOT\s+LIKE|LIKE)\s*(?:'[^']*'|-?\d+(?:\.\d+)?))/gi;
  let match: RegExpExecArray | null;
  while ((match = condPattern.exec(whereMatch[1])) !== null) {
    found.push(match[0].trim());
  }
  return [...new Set(found)];
}

function isCoveredByFields(
  expr: string,
  fieldsUsed: Array<{ sql: string }>,
): boolean {
  const norm = normalizeExpr(expr);
  return fieldsUsed.some((f) => normalizeExpr(f.sql ?? '').includes(norm));
}

async function enrichCandidate(
  expression: string,
  question: string,
): Promise<{
  label: string;
  description: string;
  format: 'currency_usd' | 'integer' | 'percent' | 'decimal';
  synonyms: string[];
} | null> {
  const prompt = `Given this SQL aggregate expression found in queries about: "${question}"

Expression: ${expression}

Generate a semantic label, description, numeric format, and synonyms for this metric.
Respond as JSON only (no markdown):
{
  "label": "Human-readable label (2-5 words, title case)",
  "description": "One sentence describing what this metric measures",
  "format": "currency_usd" | "integer" | "percent" | "decimal",
  "synonyms": ["synonym1", "synonym2", "synonym3"]
}`;

  try {
    const raw = await chatComplete(
      [{ role: 'user', content: prompt }],
      { maxTokens: 256 },
      routeModel('classification'),
    );
    const { answer } = extractR1Response(raw);
    const clean = answer.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as {
      label: string;
      description: string;
      format: 'currency_usd' | 'integer' | 'percent' | 'decimal';
      synonyms: string[];
    };
  } catch {
    return null;
  }
}

async function enrichProposal(
  sql: string,
  table: string,
  question: string,
): Promise<{ label: string; description: string } | null> {
  const prompt = `Given this SQL WHERE condition: "${sql}"
Table: ${table}
Found in query about: "${question}"

Generate a business rule label and description.
Respond as JSON only (no markdown):
{
  "label": "Human-readable label (2-5 words)",
  "description": "One sentence describing this business rule"
}`;

  try {
    const raw = await chatComplete(
      [{ role: 'user', content: prompt }],
      { maxTokens: 128 },
      routeModel('classification'),
    );
    const { answer } = extractR1Response(raw);
    const clean = answer.replace(/```json|```/g, '').trim();
    return JSON.parse(clean) as { label: string; description: string };
  } catch {
    return null;
  }
}

export class EnrichmentAgent {
  constructor(private storageDir: string) {}

  async analyse(input: EnrichmentInput): Promise<void> {
    if (!input.sqlFinal || !input.datasourceId) return;

    await Promise.allSettled([
      this.discoverMeasures(input),
      this.discoverBusinessRules(input),
    ]);
  }

  private async discoverMeasures(input: EnrichmentInput): Promise<void> {
    const aggregates = extractAggregates(input.sqlFinal);
    const uncovered = aggregates.filter(
      (expr) => !isCoveredByFields(expr, input.fieldsUsed),
    );
    if (!uncovered.length) return;

    const candidates = await readCandidates(this.storageDir, input.datasourceId);
    let changed = false;

    for (const expr of uncovered) {
      const normalized = normalizeExpr(expr);
      const existing = candidates.find(
        (c) => normalizeExpr(c.expression) === normalized,
      );

      if (existing) {
        existing.seenCount = (existing.seenCount ?? 1) + 1;
        if (existing.seenCount >= AUTO_ENRICH_THRESHOLD && !existing.label) {
          const enriched = await enrichCandidate(expr, input.question);
          if (enriched) {
            existing.label = enriched.label;
            existing.description = enriched.description;
            existing.format = enriched.format;
            existing.synonyms = enriched.synonyms;
            existing.labeledAt = new Date().toISOString();
            if (!existing.table) existing.table = extractTable(input.sqlFinal);
          }
        }
        changed = true;
      } else {
        // Enrich eagerly on first capture so the label is ready before promotion
        const enriched = await enrichCandidate(expr, input.question);
        const newCandidate: MeasureCandidate = {
          id: crypto.randomUUID(),
          expression: expr,
          question: input.question,
          proposedAt: new Date().toISOString(),
          seenCount: 1,
          validated: false,
          table: extractTable(input.sqlFinal),
          ...(enriched
            ? {
                label: enriched.label,
                description: enriched.description,
                format: enriched.format,
                synonyms: enriched.synonyms,
                labeledAt: new Date().toISOString(),
              }
            : {}),
        };
        candidates.push(newCandidate);
        changed = true;
      }
    }

    if (changed) {
      await writeCandidates(this.storageDir, input.datasourceId, candidates);
      console.info(
        `[enrichment-agent] updated ${uncovered.length} measure candidate(s) for ${input.datasourceId}`,
      );
    }
  }

  private async discoverBusinessRules(input: EnrichmentInput): Promise<void> {
    const conditions = extractWhereConditions(input.sqlFinal);
    if (!conditions.length) return;

    const knownSQLs = new Set(
      input.fieldsUsed.map((f) => normalizeExpr(f.sql ?? '')),
    );
    const novel = conditions.filter((c) => !knownSQLs.has(normalizeExpr(c)));
    if (!novel.length) return;

    const table = extractTable(input.sqlFinal);
    const proposals = await readProposals(this.storageDir, input.datasourceId);
    let changed = false;

    for (const cond of novel) {
      const normalized = normalizeExpr(cond);
      const existing = proposals.find((p) => normalizeExpr(p.sql) === normalized);

      if (existing) {
        existing.seenCount = (existing.seenCount ?? 1) + 1;
        if (existing.seenCount >= AUTO_ENRICH_THRESHOLD && !existing.label) {
          const enriched = await enrichProposal(cond, table, input.question);
          if (enriched) {
            existing.label = enriched.label;
            existing.description = enriched.description;
          }
        }
        changed = true;
      } else {
        // Enrich eagerly on first capture
        const enriched = await enrichProposal(cond, table, input.question);
        const newProposal: ArtifactProposal = {
          id: crypto.randomUUID(),
          type: 'business_rule',
          datasourceId: input.datasourceId,
          sql: cond,
          question: input.question,
          table,
          proposedAt: new Date().toISOString(),
          seenCount: 1,
          promoted: false,
          ...(enriched
            ? { label: enriched.label, description: enriched.description }
            : {}),
        };
        proposals.push(newProposal);
        changed = true;
      }
    }

    if (changed) {
      await writeProposals(this.storageDir, input.datasourceId, proposals);
      console.info(
        `[enrichment-agent] updated ${novel.length} rule proposal(s) for ${input.datasourceId}`,
      );
    }
  }
}
