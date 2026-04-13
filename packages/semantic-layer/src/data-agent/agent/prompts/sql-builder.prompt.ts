import type { PlanArtifact, JoinPlanArtifact } from '../../types';

export function buildSqlBuilderPrompt(
  plan: PlanArtifact,
  joinPlan: JoinPlanArtifact,
  databaseType: string,
  revisionDiagnosis: string | null,
): string {
  const schemas = joinPlan.relevantDatasets
    .map((d) => `### ${d.name} (${d.source})\n\`\`\`yaml\n${d.yaml}\n\`\`\``)
    .join('\n\n');

  const joinPaths =
    joinPlan.joinPaths.length > 0
      ? joinPlan.joinPaths
          .map(
            (p) =>
              `  ${p.datasets.join(' → ')}\n` +
              p.edges
                .map(
                  (e) =>
                    `    JOIN ${e.toDataset} ON ${e.fromDataset}.${e.fromColumns.join(',')} = ${e.toDataset}.${e.toColumns.join(',')} (${e.relationshipName})`,
                )
                .join('\n'),
          )
          .join('\n')
      : '  (no multi-dataset joins required)';

  const revisionSection = revisionDiagnosis
    ? `\n## ⚠️ Revision required\nThe previous SQL failed verification. Diagnosis:\n${revisionDiagnosis}\n\nFix the issues described above.\n`
    : '';

  const dialectRules: Record<string, string> = {
    postgresql:
      "- Use standard PostgreSQL syntax. Date arithmetic: NOW() - INTERVAL '30 days'.",
    mysql:
      '- Use MySQL syntax. Date arithmetic: DATE_SUB(NOW(), INTERVAL 30 DAY).',
    clickhouse: '- Use ClickHouse syntax. Use toDate(), toStartOfMonth(), etc.',
    duckdb:
      '- Use DuckDB syntax (compatible with PostgreSQL). Use CURRENT_DATE - INTERVAL 30 DAYS.',
    snowflake:
      '- Use Snowflake syntax. Date arithmetic: DATEADD(day, -30, CURRENT_DATE()).',
  };
  const dialectNote =
    dialectRules[databaseType.toLowerCase()] ??
    `- Target database: ${databaseType}.`;

  return `You are the SQL Builder node of a data analytics agent. Generate precise, executable SQL queries.

## Database type
${databaseType}
${dialectNote}

## Dataset schemas
${schemas || '(no schemas available — use best effort)'}

## Join paths
${joinPaths}

## Navigator notes
${joinPlan.notes || '(none)'}

## Execution plan
Intent: ${plan.intent}
Grain: ${plan.grain}
Acceptance checks: ${plan.acceptanceChecks.join('; ')}${revisionSection}

## Output format

Return a JSON object with a \`queries\` array. Each query:
- \`stepId\`: matches the plan step id
- \`description\`: what this query computes
- \`pilotSql\`: the query with LIMIT 10 for a quick probe
- \`fullSql\`: the complete query (no artificial row limit unless the user asked for top-N)
- \`expectedColumns\`: column names the result should have
- \`notes\`: any caveats or assumptions

## Rules
1. Only reference columns that exist in the YAML schemas above.
2. Only JOIN datasets using the join paths listed above — never invent joins.
3. Always alias ambiguous columns (e.g. two tables both have \`id\` → use \`table.id AS table_id\`).
4. For time-series, group by the smallest relevant time grain (day/week/month).
5. Never add LIMIT to \`fullSql\` unless the user asked for top-N results.
6. If a step uses python or sql_then_python strategy, the SQL is the data-fetching step only.`;
}
