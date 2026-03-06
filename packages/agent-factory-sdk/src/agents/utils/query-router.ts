import { getLogger } from '@qwery/shared/logger';
import { getOntologyState } from './ontology-state';
import { loadMappings } from '@qwery/semantic-layer/mapping/store';
import { autoInitializeSemanticLayer } from '@qwery/semantic-layer/initialization/auto-initialize';
import type { Repositories } from '@qwery/domain/repositories';
import type { Datasource } from '@qwery/domain/entities';

export type QueryTool = 'runSemanticQuery' | 'runQuery';

export interface QueryRouter {
  selectTool(datasourceId: string, autoGenerateMappings?: boolean): Promise<QueryTool>;
  shouldUseSemanticQuery(datasourceId: string): Promise<boolean>;
}

class QueryRouterImpl implements QueryRouter {
  private ontologyState = getOntologyState();
  private repositories: Repositories | null = null;

  setRepositories(repositories: Repositories): void {
    this.repositories = repositories;
  }

  async shouldUseSemanticQuery(datasourceId: string): Promise<boolean> {
    return this.ontologyState.shouldUseSemanticQuery(datasourceId);
  }

  async selectTool(
    datasourceId: string,
    autoGenerateMappings: boolean = true,
  ): Promise<QueryTool> {
    const logger = await getLogger();

    const hasOntology = await this.ontologyState.hasOntology(datasourceId);
    if (!hasOntology) {
      logger.debug('[QueryRouter] No ontology found, using runQuery', {
        datasourceId,
      });
      return 'runQuery';
    }

    const version = await this.ontologyState.getOntologyVersion(datasourceId);
    if (!version) {
      logger.debug('[QueryRouter] No ontology version found, using runQuery', {
        datasourceId,
      });
      return 'runQuery';
    }

    // Try datasource-specific version first, then fallback to 1.0.0
    const versionsToTry = version.includes('datasource-')
      ? [version, '1.0.0']
      : ['1.0.0'];

    for (const v of versionsToTry) {
      const hasMappings = await this.ontologyState.hasMappings(datasourceId, v);
      if (hasMappings) {
        logger.debug('[QueryRouter] Ontology and mappings found, using runSemanticQuery', {
          datasourceId,
          ontologyVersion: v,
        });
        return 'runSemanticQuery';
      }
    }

    // If ontology exists but no mappings, try to auto-generate if enabled
    if (autoGenerateMappings && this.repositories) {
      logger.info('[QueryRouter] Ontology found but no mappings, attempting auto-generation', {
        datasourceId,
        ontologyVersion: version,
      });

      try {
        const datasource = await this.repositories.datasource.findById(datasourceId);
        if (!datasource) {
          logger.warn('[QueryRouter] Datasource not found for mapping generation', {
            datasourceId,
          });
          return 'runQuery';
        }

        const datasources: Datasource[] = [datasource];
        await autoInitializeSemanticLayer({
          datasources,
          repositories: this.repositories,
          ontologyVersion: version.includes('datasource-') ? '1.0.0' : version,
        });

        // Check again after generation
        const hasMappingsNow = await this.ontologyState.hasMappings(datasourceId, version);
        if (hasMappingsNow) {
          logger.info('[QueryRouter] Mappings auto-generated successfully, using runSemanticQuery', {
            datasourceId,
          });
          // Clear cache to reflect new mappings
          (this.ontologyState as { clearCache?: (id?: string) => void }).clearCache?.(datasourceId);
          return 'runSemanticQuery';
        }
      } catch (error) {
        logger.warn('[QueryRouter] Auto-generation of mappings failed', {
          datasourceId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    // Fallback to regular query if mappings don't exist
    logger.debug('[QueryRouter] Ontology exists but no mappings, using runQuery', {
      datasourceId,
    });
    return 'runQuery';
  }
}

let instance: QueryRouterImpl | null = null;

export function getQueryRouter(): QueryRouter {
  if (!instance) {
    instance = new QueryRouterImpl();
  }
  return instance;
}
