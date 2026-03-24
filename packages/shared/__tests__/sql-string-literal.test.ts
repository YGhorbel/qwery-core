import { describe, expect, it } from 'vitest';

import { escapeSqlStringLiteral } from '../src/sql-string-literal';

describe('escapeSqlStringLiteral', () => {
  it('doubles single quotes', () => {
    expect(escapeSqlStringLiteral("a'b")).toBe("a''b");
  });

  it('handles empty string', () => {
    expect(escapeSqlStringLiteral('')).toBe('');
  });

  it('handles multiple quotes', () => {
    expect(escapeSqlStringLiteral("''")).toBe("''''");
  });
});
