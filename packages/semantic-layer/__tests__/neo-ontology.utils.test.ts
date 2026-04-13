import { describe, expect, it } from 'vitest';

import { neoOntologyService } from '../src/ontology/neo-ontology.service';

describe('neo ontology utils', () => {
  it('sanitizes relationship types', () => {
    const sanitize = (
      neoOntologyService as unknown as {
        sanitizeRelationType: (rel: string) => string;
      }
    ).sanitizeRelationType;

    expect(sanitize('belongs_to')).toBe('BELONGS_TO');
    expect(sanitize('Contains items')).toBe('CONTAINS_ITEMS');
    expect(sanitize('weird-çhär$')).toBe('WEIRD__H_R_');
    expect(sanitize('a'.repeat(200))).toHaveLength(50);
  });
});
