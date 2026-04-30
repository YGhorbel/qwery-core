/**
 * Agent 05 — Business Rules Inferencer
 * Detects soft-delete, status filters, activity recency, and PII columns.
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import { routeModel, extractR1Response } from '@qwery/agent-factory-sdk';
import { chatComplete } from '../llm-client.js';
import type { BusinessRuleDefinition } from '../types.js';

const SOFT_DELETE_PATTERNS = /\b(del|delete|deleted|remove|removed|archived?|inactive)\b/i;
const STATUS_PATTERNS = /\b(status|state|type)\b/i;
const ACTIVITY_PATTERNS = /\b(last_login|last_seen|last_active|last_activity|logged_in_at)\b/i;
const PII_PATTERNS = /\b(email|phone|ssn|passport|credit_card|card_number|dob|birth_date|national_id)\b/i;

type ColumnInfo = {
  table: string;
  column: string;
  type: string;
};

type LlmRuleResult = {
  rule_type: 'soft_delete' | 'status_filter' | 'activity_recency' | 'pii' | null;
  sql: string | null;
  hidden: boolean;
  explanation: string;
};

async function inferRule(col: ColumnInfo): Promise<LlmRuleResult | null> {
  const prompt = `Given this database column:
Table: ${col.table}
Column: ${col.column} (${col.type})

Identify if this column encodes any of these business rules:
1. Soft-delete (records marked as deleted but not physically removed) — common values: 0/1, true/false, 'deleted', 'archived'
2. Status filter (only certain values represent valid/active/complete records)
3. Activity recency (timestamp indicating last user activity — defines "active user")
4. PII (personally identifiable information — do not expose by default)

Respond as JSON: { "rule_type": "soft_delete" | "status_filter" | "activity_recency" | "pii" | null, "sql": string | null, "hidden": boolean, "explanation": string }

If none apply, return { "rule_type": null, "sql": null, "hidden": false, "explanation": "No rule detected." }

Return only valid JSON.`;

  try {
    const raw = await chatComplete(
      [{ role: 'user', content: prompt }],
      undefined,
      routeModel('semantic_inference'),
    );
    const { thinking, answer } = extractR1Response(raw);
    if (thinking) console.debug('[r1-thinking]', thinking);
    return JSON.parse(answer.trim()) as LlmRuleResult;
  } catch {
    return null;
  }
}

export async function runBusinessRulesInferencer(
  metadata: DatasourceMetadata,
): Promise<Record<string, BusinessRuleDefinition>> {
  const rules: Record<string, BusinessRuleDefinition> = {};

  const tableNames = new Map<number, string>();
  for (const t of metadata.tables ?? []) {
    tableNames.set(t.id, t.name);
  }

  const candidates: ColumnInfo[] = [];
  for (const col of metadata.columns ?? []) {
    const table = tableNames.get(col.table_id);
    if (!table) continue;
    const name = col.name.toLowerCase();
    if (
      SOFT_DELETE_PATTERNS.test(name) ||
      STATUS_PATTERNS.test(name) ||
      ACTIVITY_PATTERNS.test(name) ||
      PII_PATTERNS.test(name)
    ) {
      candidates.push({ table, column: col.name, type: col.data_type ?? 'unknown' });
    }
  }

  for (const col of candidates) {
    const result = await inferRule(col);
    if (!result?.rule_type || !result.sql) continue;

    const key = `${col.table}.${col.column}_rule`;
    rules[key] = {
      label: result.explanation.split('.')[0] ?? col.column,
      description: result.explanation,
      sql: result.sql,
      type: true,
      hidden: result.hidden,
      table: col.table,
      synonyms: [],
    };
  }

  return rules;
}
