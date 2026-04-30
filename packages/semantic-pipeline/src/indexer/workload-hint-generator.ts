export type JoinPattern = {
  tables: string[];
  condition: string;
  count: number;
};

export type FilterPattern = {
  clause: string;
  count: number;
};

/** Extract JOIN ... ON ... clauses appearing 3+ times across traces. */
export function extractJoinPatterns(sqlStatements: string[]): JoinPattern[] {
  const counts = new Map<string, { tables: string[]; condition: string; count: number }>();

  for (const sql of sqlStatements) {
    const joinMatches = sql.matchAll(
      /(?:INNER|LEFT|RIGHT|FULL|CROSS)?\s*JOIN\s+(\w+)\s+(?:\w+\s+)?ON\s+([^\n]+?)(?=\s+(?:WHERE|GROUP|ORDER|HAVING|LIMIT|JOIN|$))/gi,
    );
    for (const m of joinMatches) {
      const table = (m[1] ?? '').toLowerCase();
      const condition = (m[2] ?? '').trim().replace(/\s+/g, ' ');
      const key = `${table}::${condition}`;
      const existing = counts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        counts.set(key, { tables: [table], condition, count: 1 });
      }
    }
  }

  return [...counts.values()].filter((p) => p.count >= 3);
}

/** Extract WHERE clauses appearing 3+ times across traces. */
export function extractFilterPatterns(sqlStatements: string[]): FilterPattern[] {
  const counts = new Map<string, number>();

  for (const sql of sqlStatements) {
    const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+GROUP|\s+ORDER|\s+HAVING|\s+LIMIT|$)/i);
    if (!whereMatch?.[1]) continue;

    const clauses = whereMatch[1]
      .split(/\s+AND\s+/i)
      .map((c) => c.trim().replace(/\s+/g, ' '));

    for (const clause of clauses) {
      if (clause.length < 5 || clause.length > 200) continue;
      const normalized = clause.replace(/'\w+'/, "'?'").replace(/\d+/, '?');
      counts.set(normalized, (counts.get(normalized) ?? 0) + 1);
    }
  }

  return [...counts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([clause, count]) => ({ clause, count }));
}

/** Convert a pattern into a natural language hint document. */
export function generateHintText(pattern: JoinPattern | FilterPattern): string {
  if ('condition' in pattern) {
    const { tables, condition, count } = pattern;
    return `When joining ${tables.join(', ')}, use the condition: ${condition} (seen ${count} times in past queries).`;
  }
  const { clause, count } = pattern;
  return `A commonly applied filter in past queries (${count} times): ${clause}`;
}
