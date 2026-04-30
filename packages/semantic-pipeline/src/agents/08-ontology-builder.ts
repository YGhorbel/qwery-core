/**
 * Agent 08 — Ontology Builder
 * Assembles the full ontology.json from classified concepts and join graph.
 */
import type { ConceptDefinition, JoinDefinition, Ontology, OntologyRelationship, InferenceRule } from '../types.js';

const RELATIONSHIP_MAP: Record<string, Record<string, string>> = {
  Transaction: { Person: 'placed_by', Product: 'contains' },
  Event: { Person: 'performed_by', Product: 'involves' },
};

const COMMON_INFERENCE_RULES: InferenceRule[] = [
  {
    id: 'revenue_concept',
    if: 'user asks about revenue, sales, income, earnings, turnover',
    then: 'anchor on Transaction concept',
  },
  {
    id: 'churn_concept',
    if: 'user asks about churn, lost customers, inactive users',
    then: 'anchor on Person concept',
    derive: 'NOT is_active_customer business rule',
  },
  {
    id: 'count_people_concept',
    if: 'user asks how many customers, users, or people',
    then: 'anchor on Person concept',
  },
  {
    id: 'product_performance_concept',
    if: 'user asks about top products, best sellers, product revenue',
    then: 'anchor on Product concept',
  },
];

function getConceptClass(concept: ConceptDefinition): string {
  return concept.is_a[0] ?? 'Other';
}

function getTableName(concept: ConceptDefinition): string {
  return concept.maps_to.split('.').pop() ?? concept.maps_to;
}

export function runOntologyBuilder(
  concepts: Record<string, ConceptDefinition>,
  joins: Record<string, JoinDefinition>,
): Ontology {
  const relationships: OntologyRelationship[] = [];

  // Build table → concept name map for join resolution
  const tableToConceptName = new Map<string, string>();
  for (const [name, concept] of Object.entries(concepts)) {
    tableToConceptName.set(getTableName(concept), name);
  }

  for (const [joinId, join] of Object.entries(joins)) {
    const fromConcept = tableToConceptName.get(join.from);
    const toConcept = tableToConceptName.get(join.to);
    if (!fromConcept || !toConcept) continue;

    const fromClass = getConceptClass(concepts[fromConcept]!);
    const toClass = getConceptClass(concepts[toConcept]!);

    const relationshipType =
      RELATIONSHIP_MAP[fromClass]?.[toClass] ?? 'relates_to';

    relationships.push({
      from: fromConcept,
      to: toConcept,
      type: relationshipType,
      cardinality: join.relationship,
      join_ref: joinId,
    });
  }

  return {
    concepts,
    relationships,
    inference_rules: COMMON_INFERENCE_RULES,
  };
}
