import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import { loadMappings } from '../mapping/store';
import { OntologyGraph } from '../graph/ontology-graph';
import type { JoinPath } from '../compiler/types';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface OntologySchemaView {
  concepts: Array<{
    id: string;
    label: string;
    description?: string;
    properties: Array<{
      id: string;
      label: string;
      type: string;
      description?: string;
      mappedTo: {
        table: string;
        column: string;
      };
    }>;
    relationships: Array<{
      target: string;
      targetLabel: string;
      type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
      label: string;
      description?: string;
      joinPath?: JoinPath;
      confidence?: number;
    }>;
  }>;
}

/**
 * Build ontology-based schema view from ontology and mappings.
 * Provides semantic schema representation instead of raw metadata.
 */
export async function buildOntologySchemaView(
  ontology: Ontology,
  datasourceId: string,
  ontologyVersion: string,
): Promise<OntologySchemaView> {
  const logger = await getLogger();

  logger.info('[OntologySchemaView] Building ontology schema view', {
    datasourceId,
    ontologyVersion,
    conceptsCount: ontology.ontology.concepts.length,
  });

  const mappings = await loadMappings(datasourceId, ontologyVersion);
  const graph = new OntologyGraph(ontology);

  const concepts = ontology.ontology.concepts.map((concept) => {
    // Get properties with mappings
    const properties = concept.properties.map((property) => {
      // Find column mapping for this property
      const conceptMapping = mappings.find((m) => m.concept_id === concept.id);
      const columnMapping = conceptMapping?.column_mappings.find(
        (cm) => cm.property_id === property.id || cm.property_id === `${concept.id}.${property.id}`,
      );

      return {
        id: property.id,
        label: property.label,
        type: property.type,
        description: property.description,
        mappedTo: columnMapping
          ? {
              table: `${conceptMapping!.table_schema}.${conceptMapping!.table_name}`,
              column: columnMapping.column_name,
            }
          : {
              table: 'unknown',
              column: 'unknown',
            },
      };
    });

    // Get relationships with join paths
    const relationships = (concept.relationships || []).map((rel) => {
      const targetConcept = ontology.ontology.concepts.find((c) => c.id === rel.target);
      const targetMapping = mappings.find((m) => m.concept_id === rel.target);
      const sourceMapping = mappings.find((m) => m.concept_id === concept.id);

      // Try to infer join path
      let joinPath: JoinPath | undefined;
      if (sourceMapping && targetMapping) {
        // Simple join path inference
        joinPath = {
          from_table: {
            schema: sourceMapping.table_schema,
            name: sourceMapping.table_name,
          },
          to_table: {
            schema: targetMapping.table_schema,
            name: targetMapping.table_name,
          },
          from_column: 'id', // Would be resolved from actual foreign keys
          to_column: 'id',
          relationship_type: rel.type,
        };
      }

      return {
        target: rel.target,
        targetLabel: targetConcept?.label || rel.target,
        type: rel.type,
        label: rel.label,
        description: rel.description,
        joinPath,
        confidence: 1.0, // Explicit relationships have full confidence
      };
    });

    return {
      id: concept.id,
      label: concept.label,
      description: concept.description,
      properties,
      relationships,
    };
  });

  logger.info('[OntologySchemaView] Schema view built', {
    conceptsCount: concepts.length,
    totalProperties: concepts.reduce((sum, c) => sum + c.properties.length, 0),
    totalRelationships: concepts.reduce((sum, c) => sum + c.relationships.length, 0),
  });

  return { concepts };
}

/**
 * Get schema view for a specific concept
 */
export async function getConceptSchemaView(
  conceptId: string,
  ontology: Ontology,
  datasourceId: string,
  ontologyVersion: string,
): Promise<OntologySchemaView['concepts'][0] | null> {
  const view = await buildOntologySchemaView(ontology, datasourceId, ontologyVersion);
  return view.concepts.find((c) => c.id === conceptId) || null;
}
