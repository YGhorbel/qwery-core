import { z } from 'zod';

export const PropertySchema = z.object({
  id: z.string(),
  label: z.string(),
  type: z.string(),
  description: z.string().optional(),
});

export const RelationshipSchema = z.object({
  target: z.string(),
  type: z.enum(['has_one', 'has_many', 'belongs_to', 'many_to_many']),
  label: z.string(),
  description: z.string().optional(),
});

export const ConceptSchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string().optional(),
  properties: z.array(PropertySchema).default([]),
  relationships: z.array(RelationshipSchema).default([]),
});

export const InheritanceSchema = z.object({
  base: z.string(),
  extends: z.array(z.string()),
});

export const OntologySchema = z.object({
  ontology: z.object({
    concepts: z.array(ConceptSchema),
    inheritance: z.array(InheritanceSchema).default([]),
  }),
});

export type Property = z.infer<typeof PropertySchema>;
export type Relationship = z.infer<typeof RelationshipSchema>;
export type Concept = z.infer<typeof ConceptSchema>;
export type Inheritance = z.infer<typeof InheritanceSchema>;
export type Ontology = z.infer<typeof OntologySchema>;

// Dual-Layer Ontology Support
export const AbstractConceptSchema = ConceptSchema.extend({
  domain: z.string().optional(),
  synonyms: z.array(z.string()).default([]),
});

export const AbstractRelationshipSchema = RelationshipSchema.extend({
  cardinality: z.enum(['one', 'many']).optional(),
});

export const ConcreteTableMappingSchema = z.object({
  datasourceId: z.string(),
  schema: z.string(),
  table: z.string(),
  conceptId: z.string(),
});

export const ConcreteColumnMappingSchema = z.object({
  datasourceId: z.string(),
  schema: z.string(),
  table: z.string(),
  column: z.string(),
  conceptId: z.string(),
  propertyId: z.string(),
});

export const DualLayerOntologySchema = z.object({
  abstract: z.object({
    concepts: z.array(AbstractConceptSchema),
    relationships: z.array(AbstractRelationshipSchema),
    domain: z.string().optional(),
  }),
  concrete: z.record(
    z.string(), // datasourceId
    z.object({
      tableMappings: z.array(ConcreteTableMappingSchema),
      columnMappings: z.array(ConcreteColumnMappingSchema),
      relationships: z.array(RelationshipSchema),
    }),
  ),
  mappings: z.object({
    abstractToConcrete: z.record(z.string(), z.array(z.string())), // conceptId -> [datasourceId:table]
    concreteToAbstract: z.record(z.string(), z.string()), // datasourceId:table -> conceptId
  }),
  version: z.string(),
});

export type AbstractConcept = z.infer<typeof AbstractConceptSchema>;
export type AbstractRelationship = z.infer<typeof AbstractRelationshipSchema>;
export type ConcreteTableMapping = z.infer<typeof ConcreteTableMappingSchema>;
export type ConcreteColumnMapping = z.infer<typeof ConcreteColumnMappingSchema>;
export type DualLayerOntology = z.infer<typeof DualLayerOntologySchema>;
