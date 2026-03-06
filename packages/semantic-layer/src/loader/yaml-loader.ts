import { parse } from 'yaml';
import { OntologySchema, type Ontology } from '../models/ontology.schema';

/**
 * Browser-safe YAML → Ontology validator.
 *
 * NOTE: This intentionally does NOT import any Node.js modules like `node:fs`
 * so it can be safely used in both Node and browser bundles. Reading files
 * from disk must be handled by the caller (e.g. via dynamic `node:fs` import
 * on the server) and the file contents passed in as a string.
 */
export function validateOntologyFromYAMLString(yamlContent: string): Ontology {
  const parsed = parse(yamlContent);
  return OntologySchema.parse(parsed);
}

export function validateOntology(ontology: unknown): Ontology {
  return OntologySchema.parse(ontology);
}
