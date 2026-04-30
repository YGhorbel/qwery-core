import fs from 'node:fs/promises';
import path from 'node:path';
import nodeSqlParser from 'node-sql-parser';
const { Parser } = nodeSqlParser;

// ─── In-memory cache ────────────────────────────────────────────────────────

type SchemaCache = {
  columns: Map<string, Set<string>>;  // tableName → Set<columnName>
};

type SynonymCache = {
  // tableName → Map<lowerCasedToken → realColumnName>
  byTable: Map<string, Map<string, string>>;
};

const _schemaCache = new Map<string, SchemaCache>();
const _synonymCache = new Map<string, SynonymCache>();

// ─── Loaders ────────────────────────────────────────────────────────────────

async function loadSchemaCache(datasourceId: string, storageDir: string): Promise<SchemaCache> {
  const cached = _schemaCache.get(datasourceId);
  if (cached) return cached;

  const schemaPath = path.join(storageDir, 'datasources', datasourceId, 'schema.json');
  const raw = await fs.readFile(schemaPath, 'utf-8');
  const { metadata } = JSON.parse(raw) as {
    metadata: { columns: Array<{ table: string; name: string }> };
  };

  const columns = new Map<string, Set<string>>();
  for (const col of metadata.columns ?? []) {
    const tbl = col.table.toLowerCase();
    if (!columns.has(tbl)) columns.set(tbl, new Set());
    columns.get(tbl)!.add(col.name.toLowerCase());
  }

  const result: SchemaCache = { columns };
  _schemaCache.set(datasourceId, result);
  return result;
}

async function loadSynonymCache(datasourceId: string, storageDir: string): Promise<SynonymCache> {
  const cached = _synonymCache.get(datasourceId);
  if (cached) return cached;

  const labelPath = path.join(storageDir, 'datasources', datasourceId, 'label_map.json');
  const raw = await fs.readFile(labelPath, 'utf-8');
  const labelMap = JSON.parse(raw) as Record<string, { label: string; synonyms: string[] }>;

  const byTable = new Map<string, Map<string, string>>();

  for (const [key, entry] of Object.entries(labelMap)) {
    const dotIdx = key.indexOf('.');
    if (dotIdx === -1) continue;
    const tableName = key.slice(0, dotIdx).toLowerCase();
    const realColumn = key.slice(dotIdx + 1).toLowerCase();

    if (!byTable.has(tableName)) byTable.set(tableName, new Map());
    const tblMap = byTable.get(tableName)!;

    // Label as lookup token (e.g. "Latitude" → "lat")
    tblMap.set(entry.label.toLowerCase(), realColumn);

    // Each synonym
    for (const syn of entry.synonyms ?? []) {
      tblMap.set(syn.toLowerCase(), realColumn);
    }
  }

  const result: SynonymCache = { byTable };
  _synonymCache.set(datasourceId, result);
  return result;
}

// ─── Levenshtein ────────────────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const m = a.length, n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      // All indices are in-bounds by construction
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      dp[i]![j] = a[i - 1] === b[j - 1]
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        ? dp[i - 1]![j - 1]!
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
  return dp[m]![n]!;
}

// ─── Match finder ────────────────────────────────────────────────────────────

type MatchResult = { realColumn: string; method: string; confidence: number };

function findBestMatch(
  tableName: string,
  wrongColumn: string,
  schema: SchemaCache,
  synonyms: SynonymCache,
): MatchResult | null {
  const tblCols = schema.columns.get(tableName.toLowerCase());
  if (!tblCols) return null;

  const lower = wrongColumn.toLowerCase();

  // 1. Exact match (column is actually correct — should have been caught before calling)
  if (tblCols.has(lower)) return { realColumn: lower, method: 'exact', confidence: 1.0 };

  // 2. Synonym / label match from label_map.json
  const tblSynMap = synonyms.byTable.get(tableName.toLowerCase());
  if (tblSynMap) {
    const synMatch = tblSynMap.get(lower);
    if (synMatch && tblCols.has(synMatch)) {
      return { realColumn: synMatch, method: 'synonym', confidence: 0.95 };
    }
  }

  // 3. Levenshtein ≤ 2
  let bestLev: { col: string; dist: number } | null = null;
  for (const col of tblCols) {
    const dist = levenshtein(lower, col);
    if (dist <= 2 && (!bestLev || dist < bestLev.dist)) {
      bestLev = { col, dist };
    }
  }
  if (bestLev) {
    return {
      realColumn: bestLev.col,
      method: `levenshtein(${bestLev.dist})`,
      confidence: bestLev.dist === 1 ? 0.85 : 0.75,
    };
  }

  // 4. Prefix / camelCase normalisation — strip underscores, lowercase
  const normalise = (s: string) => s.toLowerCase().replace(/[_\s-]/g, '');
  const normWrong = normalise(lower);
  for (const col of tblCols) {
    if (normalise(col) === normWrong) {
      return { realColumn: col, method: 'normalised', confidence: 0.8 };
    }
  }

  return null;
}

// ─── AST utilities ───────────────────────────────────────────────────────────

type ASTNode = Record<string, unknown>;

function collectFromTables(fromClause: unknown): Array<{ alias: string; table: string }> {
  if (!Array.isArray(fromClause)) return [];
  const result: Array<{ alias: string; table: string }> = [];
  for (const entry of fromClause as ASTNode[]) {
    if (typeof entry.table === 'string') {
      const table = entry.table.toLowerCase();
      const alias = (typeof entry.as === 'string' ? entry.as : entry.table).toLowerCase();
      result.push({ alias, table });
      // Always register the table name itself too
      if (alias !== table) result.push({ alias: table, table });
    }
  }
  return result;
}

type ColumnRef = { tableAlias: string; column: string };

function collectColumnRefs(node: unknown, refs: ColumnRef[]): void {
  if (!node || typeof node !== 'object') return;

  if ((node as ASTNode).type === 'column_ref') {
    const n = node as ASTNode;
    const tableAlias = typeof n.table === 'string' ? n.table.toLowerCase() : null;
    const colNode = n.column as ASTNode | undefined;
    const colVal =
      typeof colNode?.expr === 'object'
        ? ((colNode.expr as ASTNode).value as string | undefined)
        : typeof n.column === 'string'
          ? (n.column as string)
          : null;

    if (tableAlias && colVal) {
      refs.push({ tableAlias, column: colVal.toLowerCase() });
    }
    return;
  }

  for (const val of Object.values(node as ASTNode)) {
    if (Array.isArray(val)) {
      for (const item of val) collectColumnRefs(item, refs);
    } else if (val && typeof val === 'object') {
      collectColumnRefs(val, refs);
    }
  }
}

// ─── Main validator ──────────────────────────────────────────────────────────

export type ValidationResult = {
  fixedSQL: string;
  corrections: string[];
  unresolvableColumns: string[];
};

const parser = new Parser();

export async function validateAndFixSQL(
  sql: string,
  datasourceId: string,
  storageDir: string,
): Promise<ValidationResult> {
  // No datasource → pass through silently
  if (!datasourceId || !storageDir) {
    return { fixedSQL: sql, corrections: [], unresolvableColumns: [] };
  }

  let schema: SchemaCache;
  let synonyms: SynonymCache;

  try {
    [schema, synonyms] = await Promise.all([
      loadSchemaCache(datasourceId, storageDir),
      loadSynonymCache(datasourceId, storageDir).catch(() => ({ byTable: new Map() })),
    ]);
  } catch {
    // Schema file missing or unreadable → pass through
    return { fixedSQL: sql, corrections: [], unresolvableColumns: [] };
  }

  let ast: ASTNode | ASTNode[];
  try {
    ast = parser.astify(sql, { database: 'PostgreSQL' }) as unknown as ASTNode | ASTNode[];
  } catch {
    // Unparseable SQL (e.g. CTE or exotic syntax) → pass through
    return { fixedSQL: sql, corrections: [], unresolvableColumns: [] };
  }

  const stmts = Array.isArray(ast) ? ast : [ast];
  const allRefs: ColumnRef[] = [];
  const aliasMap = new Map<string, string>(); // alias → real table name

  for (const stmt of stmts) {
    // Collect alias map from FROM and JOIN clauses
    for (const { alias, table } of collectFromTables(stmt.from)) {
      aliasMap.set(alias, table);
    }
    // Also collect from CTEs
    if (Array.isArray(stmt.with)) {
      for (const cte of stmt.with as ASTNode[]) {
        const inner = (cte.stmt as ASTNode)?.ast;
        if (inner) {
          for (const { alias, table } of collectFromTables((inner as ASTNode).from)) {
            aliasMap.set(alias, table);
          }
          collectColumnRefs(inner, allRefs);
        }
      }
    }
    collectColumnRefs(stmt, allRefs);
  }

  // Deduplicate: only check each (alias, column) pair once
  const checked = new Set<string>();
  const corrections: string[] = [];
  const unresolvableColumns: string[] = [];
  // Map of "alias.wrong" → "alias.right" for string replacement
  const replacements = new Map<string, string>();

  for (const { tableAlias, column } of allRefs) {
    const key = `${tableAlias}.${column}`;
    if (checked.has(key)) continue;
    checked.add(key);

    // Resolve alias to real table name
    const realTable = aliasMap.get(tableAlias) ?? tableAlias;

    // Column is valid — skip
    const tblCols = schema.columns.get(realTable);
    if (!tblCols) continue; // unknown table — let DB handle it
    if (tblCols.has(column)) continue; // column exists

    // Try to find a correction
    const match = findBestMatch(realTable, column, schema, synonyms);

    if (match && match.confidence >= 0.75) {
      corrections.push(`${realTable}.${column} → ${realTable}.${match.realColumn} (${match.method})`);
      // Replace in SQL: keep alias, fix column name
      replacements.set(key, `${tableAlias}.${match.realColumn}`);
    } else {
      unresolvableColumns.push(`${realTable}.${column}`);
    }
  }

  if (replacements.size === 0) {
    return { fixedSQL: sql, corrections, unresolvableColumns };
  }

  // Apply replacements as word-boundary regex substitutions
  let fixedSQL = sql;
  for (const [wrong, right] of replacements) {
    // Escape dots for regex: alias.column → regex alias\.column
    const escaped = wrong.replace(/\./g, '\\.').replace(/[[\]{}()*+?^$|\\]/g, (c) =>
      c === '.' ? '\\.' : `\\${c}`,
    );
    fixedSQL = fixedSQL.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), right);
  }

  return { fixedSQL, corrections, unresolvableColumns };
}

/** Invalidate cached schema/synonyms for a datasource (e.g. after re-indexing). */
export function invalidateValidatorCache(datasourceId: string): void {
  _schemaCache.delete(datasourceId);
  _synonymCache.delete(datasourceId);
}
