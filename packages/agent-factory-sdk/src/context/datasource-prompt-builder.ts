import fs from 'node:fs/promises';
import path from 'node:path';

type SchemaTable = {
  name: string;
  primary_keys: Array<{ name: string }>;
};

type SchemaColumn = {
  table: string;
  name: string;
  data_type?: string;
  format?: string;
};

type SchemaJson = {
  metadata: {
    tables: SchemaTable[];
    columns: SchemaColumn[];
  };
};

type SemanticField = {
  label?: string;
  description?: string;
  when_to_use?: string;
  hidden?: boolean;
  sql?: string;
  table?: string;
};

type SemanticLayer = {
  measures?: Record<string, SemanticField>;
  dimensions?: Record<string, SemanticField>;
  business_rules?: Record<string, SemanticField>;
};

type LabelMapEntry = {
  label?: string;
  synonyms?: string[];
  raw_column?: string;
};

type LabelMap = Record<string, LabelMapEntry>;

/**
 * Builds a compact datasource-aware context block injected once per agent session.
 * Covers: table names + PKs, column data types, measures (with when_to_use),
 * hidden business rules (auto-applied filters), and column synonyms.
 *
 * Never throws — returns '' if no artifacts are available.
 */
export async function buildDatasourceSystemContext(
  datasourceId: string,
  datasourceName: string,
  storageDir: string,
): Promise<string> {
  const baseDir = path.join(storageDir, 'datasources', datasourceId);
  const parts: string[] = [];

  // ── Schema: table names, PKs, column types ────────────────────────────────
  try {
    const raw = await fs.readFile(path.join(baseDir, 'schema.json'), 'utf-8');
    const schema = JSON.parse(raw) as SchemaJson;
    const tables = schema.metadata?.tables ?? [];
    const columns = schema.metadata?.columns ?? [];

    if (tables.length > 0) {
      parts.push(`Tables (${tables.length}): ${tables.map((t) => t.name).join(', ')}`);

      const pkEntries = tables
        .flatMap((t) => t.primary_keys.map((pk) => `${t.name}.${pk.name}`))
        .join(', ');
      if (pkEntries) parts.push(`Primary keys: ${pkEntries}`);

      // Column types per table — prevents LIKE on BIGINT, wrong casts, etc.
      const typesByTable = new Map<string, string[]>();
      for (const col of columns) {
        if (!typesByTable.has(col.table)) typesByTable.set(col.table, []);
        const dt = col.data_type ?? col.format ?? '';
        if (dt) typesByTable.get(col.table)!.push(`${col.name}:${dt}`);
      }
      const typeLines = tables
        .map((t) => {
          const cols = typesByTable.get(t.name);
          if (!cols || cols.length === 0) return null;
          return `  ${t.name}: ${cols.join(', ')}`;
        })
        .filter(Boolean);
      if (typeLines.length > 0) {
        parts.push(`Column types:\n${typeLines.join('\n')}`);
      }
    }
  } catch {
    // schema.json not available — skip section
  }

  // ── Semantic layer: measures + hidden business rules ──────────────────────
  try {
    const { parse: yamlParse } = await import('yaml');
    const raw = await fs.readFile(path.join(baseDir, 'semantic_layer.yaml'), 'utf-8');
    const sl = yamlParse(raw) as SemanticLayer;

    // Measures with label + when_to_use (up to 20)
    const measures = Object.entries(sl.measures ?? {}).slice(0, 20);
    if (measures.length > 0) {
      const lines = measures.map(([, f]) => {
        const label = f.label ?? '';
        const hint = f.when_to_use ?? f.description ?? '';
        return hint ? `- ${label}: ${hint}` : `- ${label}`;
      });
      parts.push(`MEASURES (${measures.length}):\n${lines.join('\n')}`);
    }

    // Hidden business rules that must always be applied (up to 10)
    const hiddenRules = Object.entries(sl.business_rules ?? {})
      .filter(([, r]) => r.hidden === true)
      .slice(0, 10);
    if (hiddenRules.length > 0) {
      const lines = hiddenRules.map(([, r]) => {
        const sql = (r.sql ?? '').slice(0, 120);
        const table = r.table ?? '';
        const reason = (r.label ?? r.description ?? '').slice(0, 80);
        return `- ALWAYS apply: ${sql} to ${table} (${reason})`;
      });
      parts.push(`HIDDEN BUSINESS RULES — always include these in SQL:\n${lines.join('\n')}`);
    }
  } catch {
    // semantic_layer.yaml not available — skip section
  }

  // ── Label map: column synonyms ────────────────────────────────────────────
  try {
    const raw = await fs.readFile(path.join(baseDir, 'label_map.json'), 'utf-8');
    const labelMap = JSON.parse(raw) as LabelMap;
    const withSynonyms = Object.entries(labelMap)
      .filter(([, v]) => Array.isArray(v.synonyms) && v.synonyms.length > 0)
      .slice(0, 30);
    if (withSynonyms.length > 0) {
      const lines = withSynonyms.map(([key, v]) => {
        const col = v.raw_column ?? key.split('.').pop() ?? key;
        return `${col}: also called ${v.synonyms!.join(', ')}`;
      });
      parts.push(`COLUMN SYNONYMS — use actual column name in SQL:\n${lines.join('\n')}`);
    }
  } catch {
    // label_map.json not available — skip section
  }

  if (parts.length === 0) return '';

  return [
    `DATABASE CONTEXT FOR ${datasourceName}:`,
    ...parts,
    '/no_think',
  ].join('\n');
}
