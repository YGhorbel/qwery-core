/** Convert the stored `fields` JSON string from a Neo4j Dataset node into a readable YAML schema. */
export function fieldsToYaml(
  name: string,
  source: string,
  fieldsJson: string,
): string {
  const lines: string[] = [`name: ${name}`, `source: ${source}`, 'fields:'];

  let fields: unknown[] = [];
  try {
    fields = JSON.parse(fieldsJson) as unknown[];
  } catch {
    return `name: ${name}\nsource: ${source}\n# (schema not available)`;
  }

  for (const f of fields) {
    if (!f || typeof f !== 'object') continue;
    const field = f as Record<string, unknown>;
    lines.push(`  - name: ${String(field['name'] ?? '')}`);
    if (field['label']) lines.push(`    label: ${String(field['label'])}`);
    if (field['description'])
      lines.push(`    description: ${String(field['description'])}`);
    if (field['dataType'])
      lines.push(`    dataType: ${String(field['dataType'])}`);
    if (field['isPrimaryKey']) lines.push(`    isPrimaryKey: true`);
    if (field['isTime']) lines.push(`    isTime: true`);
  }

  return lines.join('\n');
}

/** Produce a pipe-delimited table string from rows (max 100 rows shown). */
export function rowsToTable(
  columns: string[],
  rows: Record<string, unknown>[],
  maxRows = 100,
): string {
  const header = columns.join(' | ');
  const sep = columns.map(() => '---').join(' | ');
  const dataRows = rows
    .slice(0, maxRows)
    .map((row) => columns.map((c) => String(row[c] ?? '')).join(' | '));
  return [header, sep, ...dataRows].join('\n');
}

/** Map a qwery driverId to a SQL dialect name for the SQL builder prompt. */
export function getDialectFromDriverId(driverId: string): string {
  if (driverId.startsWith('postgresql') || driverId.startsWith('pglite'))
    return 'postgresql';
  if (driverId.startsWith('mysql')) return 'mysql';
  if (driverId.startsWith('clickhouse')) return 'clickhouse';
  if (
    driverId.startsWith('duckdb') ||
    driverId.startsWith('s3') ||
    driverId.startsWith('azure')
  )
    return 'duckdb';
  if (driverId.startsWith('snowflake')) return 'snowflake';
  return 'postgresql';
}
