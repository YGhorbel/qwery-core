import { Hono } from 'hono';
import { ontologyService } from '@qwery/semantic-layer/ontology';
import { semanticModelService } from '@qwery/semantic-layer/semantic-model';
import { getDiscoveryStatus } from '@qwery/semantic-layer/on-attach';
import { handleDomainException } from '../lib/http-utils';
import type { Repositories } from '@qwery/domain/repositories';

export function createOntologyRoutes(
  getRepositories: () => Promise<Repositories>,
) {
  const app = new Hono();

  // GET /api/datasources/:id/semantic-model — get stored OSI semantic model
  app.get('/:id/semantic-model', async (c) => {
    try {
      const id = c.req.param('id');
      const model = await semanticModelService.getModel(id);
      if (!model)
        return c.json(
          { error: 'No semantic model found for this datasource' },
          404,
        );
      return c.json(model);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // POST /api/datasources/:id/ontology — trigger Stage 3
  app.post('/:id/ontology', async (c) => {
    try {
      const id = c.req.param('id');

      // Trigger non-blocking
      ontologyService.buildOntology(id).catch(() => {});

      return c.json({ status: 'indexing', datasourceId: id }, 202);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // GET /api/datasources/:id/ontology — get status
  app.get('/:id/ontology', async (c) => {
    try {
      const id = c.req.param('id');
      const record = await ontologyService.getOntologyStatus(id);
      if (!record) return c.json({ status: 'not_started' }, 200);
      return c.json(record);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // GET /api/datasources/:id/ontology/datasets — list all datasets
  app.get('/:id/ontology/datasets', async (c) => {
    try {
      const id = c.req.param('id');
      const datasets = await ontologyService.listDatasets(id);
      return c.json(datasets);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // GET /api/datasources/:id/ontology/relationships — list all relationships
  app.get('/:id/ontology/relationships', async (c) => {
    try {
      const id = c.req.param('id');
      const relationships = await ontologyService.getRelationships(id);
      return c.json(relationships);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // POST /api/datasources/:id/ontology/search — vector similarity search
  app.post('/:id/ontology/search', async (c) => {
    try {
      const id = c.req.param('id');
      const { query, topK = 5 } = await c.req.json<{
        query: string;
        topK?: number;
      }>();
      if (!query) return c.json({ error: 'query is required' }, 400);
      const results = await ontologyService.searchDatasets(id, query, topK);
      return c.json(results);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // GET /api/datasources/:id/discovery/status — Stage 1 status (lightweight, no schema field)
  app.get('/:id/discovery/status', async (c) => {
    try {
      const id = c.req.param('id');
      const record = await getDiscoveryStatus(id);
      if (!record) return c.json({ status: 'not_started' }, 200);
      return c.json({
        datasourceId: record.datasourceId,
        status: record.status,
        updatedAt: record.updatedAt,
        error: record.error,
      });
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // GET /api/datasources/:id/semantic-model/status — Stage 2 status
  app.get('/:id/semantic-model/status', async (c) => {
    try {
      const id = c.req.param('id');
      const record = await semanticModelService.getStatus(id);
      if (!record) return c.json({ status: 'not_started' }, 200);
      return c.json(record);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  // POST /api/datasources/:id/semantic-model — manually trigger Stage 2 (+ Stage 3)
  app.post('/:id/semantic-model', async (c) => {
    try {
      const id = c.req.param('id');

      // Guard: already running
      const currentStatus = await semanticModelService.getStatus(id);
      if (currentStatus?.status === 'running') {
        return c.json(
          { error: 'Semantic model generation already in progress' },
          409,
        );
      }

      const repos = await getRepositories();
      const datasource = await repos.datasource.findById(id);
      if (!datasource) return c.json({ error: 'Datasource not found' }, 404);
      const revealedConfig = await repos.datasource.revealSecrets(
        datasource.config,
      );

      // Fire-and-forget: Stage 2 → Stage 3
      semanticModelService
        .generateModel(
          id,
          datasource.name ?? datasource.datasource_driver,
          datasource.datasource_driver,
          revealedConfig,
        )
        .then(() => ontologyService.buildOntology(id).catch(() => {}))
        .catch(() => {});

      return c.json({ status: 'running', datasourceId: id }, 202);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  return app;
}
