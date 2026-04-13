/**
 * Builds a system-reminder text for attached datasources.
 * Used by the generic insertReminders flow; oriented toward the query agent.
 * Only takes the list of names/ids (no full orchestration result).
 */
export function buildDatasourceReminder(
  attachedDatasources: Array<{
    id: string;
    name: string;
    provider: string;
    driver: string;
  }>,
): string {
  const wrapped = (content: string) =>
    `<system-reminder>\n${content}\n</system-reminder>`;

  if (attachedDatasources.length > 0) {
    const list = attachedDatasources
      .map((d) => `${d.name} (datasourceId: ${d.id}, provider: ${d.provider})`)
      .join(', ');

    const rules = attachedDatasources
      .map((d) => formatSqlDialectReminder(d.provider))
      .filter((x) => x !== null);

    return wrapped(
      `The following datasources are currently attached: ${list}. ` +
        `To answer data questions: use search_ontology to find relevant datasets, ` +
        `get_relationships to discover joins, then write SQL and call runQuery. ` +
        `Use getSchema with detailLevel="simple" for a full dataset overview.` +
        (rules.length > 0
          ? `\n\nSQL DIALECT RULES (identifier quoting):\n${rules.join('\n')}`
          : ''),
    );
  }

  return wrapped(
    'No datasources are currently attached. If the user asks about data, direct them to attach a datasource first.',
  );
}

function formatSqlDialectReminder(provider: string): string | null {
  const p = provider.toLowerCase();

  // We key off datasource_provider (extension datasource id).
  if (
    p === 'postgresql' ||
    p === 'postgresql-supabase' ||
    p === 'postgresql-neon'
  ) {
    return `- PostgreSQL (${provider}): identifiers use ", strings use ', schema.table like public."TableName" (unquoted folds to lowercase)`;
  }
  if (p === 'pglite') {
    return `- PGlite (${provider}): PostgreSQL-compatible quoting - identifiers use ", strings use ', schema.table like public."TableName"`;
  }
  if (p === 'mysql') {
    return `- MySQL (${provider}): identifiers use \`, strings use ', schema.table like \`schema\`.\`TableName\``;
  }
  if (p === 'duckdb' || p === 'duckdb-wasm') {
    return `- DuckDB (${provider}): identifiers use ", strings use ', schema.table like schema."TableName" (unquoted folds to lowercase)`;
  }
  if (p === 'clickhouse-node' || p === 'clickhouse-web') {
    return `- ClickHouse (${provider}): prefer \`identifier\` quoting for safety, strings use ', db.table like \`db\`.\`table\``;
  }

  // Non-SQL / unknown providers: omit so we don't mislead.
  return null;
}
