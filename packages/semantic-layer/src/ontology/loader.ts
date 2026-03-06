import type { Ontology, DualLayerOntology } from '../models/ontology.schema';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export async function loadOntology(
  version: string = '1.0.0',
): Promise<Ontology | null> {
  const logger = await getLogger();

  const { getMinIOStore } = await import('../storage/minio-store');
  const minIOStore = getMinIOStore();

  if (!minIOStore) {
    logger.warn('[OntologyLoader] MinIO store not available');
    return null;
  }

  logger.debug('[OntologyLoader] Loading ontology from MinIO', { version });

  const ontologyStore = minIOStore.createOntologyStore();
  // For datasource-specific versions (datasource-{id}/1.0.0), use the version directly
  // For legacy versions (1.0.0), try 'latest' first
  const targetVersion = version.includes('datasource-') ? version : (version === '1.0.0' ? 'latest' : version);
  const ontology = await ontologyStore.get(targetVersion);

  if (!ontology) {
    logger.warn('[OntologyLoader] Ontology not found', {
      version,
      suggestion: 'Upload ontology to MinIO',
    });
    return null;
  }

  logger.info('[OntologyLoader] Ontology loaded', {
    version,
    conceptsCount: ontology.ontology.concepts.length,
    relationshipsCount: ontology.ontology.concepts.reduce(
      (sum, c) => sum + (c.relationships?.length || 0),
      0,
    ),
    inheritanceRules: ontology.ontology.inheritance?.length || 0,
  });

  return ontology;
}

/**
 * Load dual-layer ontology (abstract + concrete layers).
 */
export async function loadDualLayerOntology(
  version: string = '1.0.0',
): Promise<DualLayerOntology | null> {
  const logger = await getLogger();

  const { getMinIOStore } = await import('../storage/minio-store');
  const minIOStore = getMinIOStore();

  if (!minIOStore) {
    logger.warn('[OntologyLoader] MinIO store not available');
    return null;
  }

  logger.debug('[OntologyLoader] Loading dual-layer ontology from MinIO', { version });

  const ontologyStore = minIOStore.createOntologyStore();
  const targetVersion = version.includes('datasource-') ? version : (version === '1.0.0' ? 'latest' : version);
  
  // Try to load as dual-layer first, fallback to regular ontology
  try {
    // For now, dual-layer ontologies would be stored with a different key pattern
    // This is a placeholder for future implementation
    const ontology = await ontologyStore.get(targetVersion);
    if (!ontology) {
      return null;
    }

    // Convert regular ontology to dual-layer format (simplified)
    // In full implementation, dual-layer would be stored separately
    return {
      abstract: {
        concepts: ontology.ontology.concepts.map((c) => ({
          ...c,
          domain: undefined,
          synonyms: [],
        })),
        relationships: ontology.ontology.concepts.flatMap((c) =>
          (c.relationships || []).map((r) => ({
            ...r,
            cardinality: r.type === 'has_one' || r.type === 'belongs_to' ? 'one' : 'many',
          })),
        ),
      },
      concrete: {},
      mappings: {
        abstractToConcrete: {},
        concreteToAbstract: {},
      },
      version,
    };
  } catch (error) {
    logger.warn('[OntologyLoader] Failed to load dual-layer ontology', {
      version,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
