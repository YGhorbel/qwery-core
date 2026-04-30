import fs from 'node:fs/promises';
import path from 'node:path';
import type { LabelMap, SemanticLayer } from '../types.js';
import { paths, getSkillsDir } from '../storage.js';

async function ensureSkillsDir(): Promise<void> {
  await fs.mkdir(getSkillsDir(), { recursive: true });
}

export async function writeGlossarySkill(
  datasourceSlug: string,
  labelMap: LabelMap,
): Promise<void> {
  await ensureSkillsDir();

  const tableGroups = new Map<string, Array<{ column: string; label: string; description: string }>>();
  for (const [key, entry] of Object.entries(labelMap)) {
    const [table, column] = key.split('.') as [string, string];
    if (!tableGroups.has(table)) tableGroups.set(table, []);
    tableGroups.get(table)!.push({ column, label: entry.label, description: entry.description });
  }

  const lines: string[] = [
    `# ${datasourceSlug} — Column Glossary`,
    '',
    `This file maps raw database column names to business-friendly labels.`,
    `Use this to understand what columns mean before writing queries.`,
    '',
  ];

  for (const [table, cols] of [...tableGroups.entries()].sort()) {
    lines.push(`## ${table}`);
    lines.push('');
    lines.push('| Column | Label | Description |');
    lines.push('|--------|-------|-------------|');
    for (const { column, label, description } of cols.sort((a, b) =>
      a.column.localeCompare(b.column),
    )) {
      lines.push(`| ${column} | ${label} | ${description} |`);
    }
    lines.push('');
  }

  const filePath = paths.glossarySkill(datasourceSlug);
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
}

export async function writeMetricsSkill(
  datasourceSlug: string,
  semanticLayer: SemanticLayer,
): Promise<void> {
  await ensureSkillsDir();

  const lines: string[] = [
    `# ${datasourceSlug} — Metrics & Business Rules`,
    '',
    `Pre-defined measures, dimensions, and business rules for this datasource.`,
    `Use the SQL expressions verbatim — they have been validated against the real database.`,
    '',
  ];

  // Measures section
  const measures = Object.entries(semanticLayer.measures ?? {});
  if (measures.length > 0) {
    lines.push('## Measures');
    lines.push('');
    for (const [fieldId, m] of measures.sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`### ${m.label} (\`${fieldId}\`)`);
      if (m.description) lines.push(m.description);
      lines.push('');
      lines.push('```sql');
      const filterClause =
        m.filters.length > 0 ? ` WHERE ${m.filters.join(' AND ')}` : '';
      lines.push(`SELECT ${m.sql} FROM ${m.table}${filterClause}`);
      lines.push('```');
      if (m.synonyms.length > 0) {
        lines.push(`*Also known as: ${m.synonyms.join(', ')}*`);
      }
      lines.push('');
    }
  }

  // Business rules section
  const rules = Object.entries(semanticLayer.business_rules ?? {});
  if (rules.length > 0) {
    lines.push('## Business Rules');
    lines.push('');
    for (const [ruleId, r] of rules.sort(([a], [b]) => a.localeCompare(b))) {
      const hiddenTag = r.hidden ? ' *(auto-applied)*' : '';
      lines.push(`### ${r.label}${hiddenTag} (\`${ruleId}\`)`);
      if (r.description) lines.push(r.description);
      lines.push('');
      lines.push(`**SQL filter:** \`${r.sql}\``);
      lines.push('');
    }
  }

  // Join paths section
  const joins = Object.entries(semanticLayer.joins ?? {});
  if (joins.length > 0) {
    lines.push('## Available Joins');
    lines.push('');
    lines.push('| Join | From | To | Type | Condition |');
    lines.push('|------|------|----|------|-----------|');
    for (const [joinId, j] of joins) {
      lines.push(`| ${joinId} | ${j.from} | ${j.to} | ${j.type} | \`${j.sql_on}\` |`);
    }
    lines.push('');
  }

  const filePath = paths.metricsSkill(datasourceSlug);
  await fs.writeFile(filePath, lines.join('\n'), 'utf-8');
}
