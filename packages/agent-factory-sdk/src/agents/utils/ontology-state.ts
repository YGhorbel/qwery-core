import { getLogger } from '@qwery/shared/logger';
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';
import { loadMappings } from '@qwery/semantic-layer/mapping/store';

export interface OntologyState {
  hasOntology(datasourceId: string): Promise<boolean>;
  hasMappings(datasourceId: string, ontologyVersion?: string): Promise<boolean>;
  getOntologyVersion(datasourceId: string): Promise<string | null>;
  shouldUseSemanticQuery(datasourceId: string): Promise<boolean>;
}

class OntologyStateManager implements OntologyState {
  private ontologyCache = new Map<string, { hasOntology: boolean; version: string | null; timestamp: number }>();
  private mappingsCache = new Map<string, { hasMappings: boolean; timestamp: number }>();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes

  async hasOntology(datasourceId: string): Promise<boolean> {
    const cached = this.ontologyCache.get(datasourceId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.hasOntology;
    }

    const logger = await getLogger();
    
    // Try datasource-specific ontology first
    const datasourceVersion = `datasource-${datasourceId}/1.0.0`;
    let ontology = await loadOntology(datasourceVersion);
    
    // Fallback to global ontology
    if (!ontology) {
      ontology = await loadOntology('1.0.0');
    }

    const hasOntology = ontology !== null;
    const version = ontology ? (datasourceVersion.includes('datasource-') ? datasourceVersion : '1.0.0') : null;

    this.ontologyCache.set(datasourceId, {
      hasOntology,
      version,
      timestamp: Date.now(),
    });

    logger.debug('[OntologyState] Ontology check', {
      datasourceId,
      hasOntology,
      version,
    });

    return hasOntology;
  }

  async hasMappings(datasourceId: string, ontologyVersion: string = '1.0.0'): Promise<boolean> {
    const cacheKey = `${datasourceId}:${ontologyVersion}`;
    const cached = this.mappingsCache.get(cacheKey);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.hasMappings;
    }

    const logger = await getLogger();
    
    try {
      const mappings = await loadMappings(datasourceId, ontologyVersion);
      const hasMappings = mappings.length > 0;

      this.mappingsCache.set(cacheKey, {
        hasMappings,
        timestamp: Date.now(),
      });

      logger.debug('[OntologyState] Mappings check', {
        datasourceId,
        ontologyVersion,
        hasMappings,
        mappingsCount: mappings.length,
      });

      return hasMappings;
    } catch (error) {
      logger.warn('[OntologyState] Error checking mappings', {
        datasourceId,
        ontologyVersion,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }

  async getOntologyVersion(datasourceId: string): Promise<string | null> {
    const cached = this.ontologyCache.get(datasourceId);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.version;
    }

    // Refresh cache
    await this.hasOntology(datasourceId);
    return this.ontologyCache.get(datasourceId)?.version ?? null;
  }

  async shouldUseSemanticQuery(datasourceId: string): Promise<boolean> {
    const hasOntology = await this.hasOntology(datasourceId);
    if (!hasOntology) {
      return false;
    }

    const version = await this.getOntologyVersion(datasourceId);
    if (!version) {
      return false;
    }

    // Try datasource-specific version first, then fallback to 1.0.0
    const versionsToTry = version.includes('datasource-') 
      ? [version, '1.0.0']
      : ['1.0.0'];

    for (const v of versionsToTry) {
      const hasMappings = await this.hasMappings(datasourceId, v);
      if (hasMappings) {
        return true;
      }
    }

    // If ontology exists but no mappings, we can still use semantic query
    // (mappings can be auto-generated)
    return true;
  }

  clearCache(datasourceId?: string): void {
    if (datasourceId) {
      this.ontologyCache.delete(datasourceId);
      // Clear all mappings cache entries for this datasource
      for (const key of this.mappingsCache.keys()) {
        if (key.startsWith(`${datasourceId}:`)) {
          this.mappingsCache.delete(key);
        }
      }
    } else {
      this.ontologyCache.clear();
      this.mappingsCache.clear();
    }
  }
}

let instance: OntologyStateManager | null = null;

export function getOntologyState(): OntologyState {
  if (!instance) {
    instance = new OntologyStateManager();
  }
  return instance;
}
