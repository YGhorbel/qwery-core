import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { MinIOClient } from '../../src/storage/minio-client';
import { MinIOStore } from '../../src/storage/minio-store';
import type { Ontology } from '../../src/models/ontology.schema';
import type { MappingResult } from '../../src/mapping/generator';

describe('MinIOStore', () => {
  let minIOClient: MinIOClient;
  let minIOStore: MinIOStore;

  beforeAll(async () => {
    const endpoint = process.env.MINIO_ENDPOINT || 'localhost:9000';
    const accessKeyId = process.env.MINIO_ACCESS_KEY_ID || 'minioadmin';
    const secretAccessKey = process.env.MINIO_SECRET_ACCESS_KEY || 'minioadmin';
    const bucket = process.env.MINIO_BUCKET || 'test-semantic-layer';

    minIOClient = new MinIOClient({
      endpoint,
      accessKeyId,
      secretAccessKey,
      bucket,
      useSSL: false,
      pathStyle: true,
    });

    minIOStore = new MinIOStore(minIOClient);
  });

  describe('OntologyStore', () => {
    it('should store and retrieve ontology', async () => {
      const ontologyStore = minIOStore.createOntologyStore();
      const testOntology: Ontology = {
        ontology: {
          concepts: [
            {
              id: 'TestConcept',
              label: 'Test Concept',
              description: 'A test concept',
              properties: [],
              relationships: [],
            },
          ],
          inheritance: [],
        },
      };

      await ontologyStore.put('1.0.0', testOntology);
      const retrieved = await ontologyStore.get('1.0.0');

      expect(retrieved).toBeDefined();
      expect(retrieved?.ontology.concepts).toHaveLength(1);
      expect(retrieved?.ontology.concepts[0]?.id).toBe('TestConcept');
    });

    it('should support latest version resolution', async () => {
      const ontologyStore = minIOStore.createOntologyStore();
      const testOntology: Ontology = {
        ontology: {
          concepts: [
            {
              id: 'TestConcept',
              label: 'Test Concept',
              properties: [],
              relationships: [],
            },
          ],
          inheritance: [],
        },
      };

      await ontologyStore.put('1.0.0', testOntology);
      const latest = await ontologyStore.get('latest');

      expect(latest).toBeDefined();
      expect(latest?.ontology.concepts[0]?.id).toBe('TestConcept');
    });

    it('should list versions', async () => {
      const ontologyStore = minIOStore.createOntologyStore();
      const versions = await ontologyStore.listVersions();

      expect(Array.isArray(versions)).toBe(true);
    });
  });

  describe('MappingStore', () => {
    it('should store and retrieve mappings', async () => {
      const mappingStore = minIOStore.createMappingStore();
      const testMappings: MappingResult = {
        table_mappings: [
          {
            table_schema: 'public',
            table_name: 'test_table',
            concept_id: 'TestConcept',
            confidence: 0.9,
            synonyms: ['test'],
            column_mappings: [],
          },
        ],
      };

      const datasourceId = 'test-datasource-1';
      await mappingStore.put(datasourceId, '1.0.0', testMappings);
      const retrieved = await mappingStore.get(datasourceId, '1.0.0');

      expect(retrieved).toBeDefined();
      expect(retrieved?.table_mappings).toHaveLength(1);
      expect(retrieved?.table_mappings[0]?.concept_id).toBe('TestConcept');
    });
  });

  describe('CacheStore', () => {
    it('should store and retrieve cache snapshots', async () => {
      const cacheStore = minIOStore.createCacheStore();
      const testSnapshot = {
        cacheKey: 'test-cache-key',
        datasourceId: 'test-datasource-1',
        semanticPlan: { concepts: ['TestConcept'] },
        compiledSQL: 'SELECT * FROM test_table',
        resultSummary: { row_count: 10 },
        timestamp: new Date().toISOString(),
      };

      await cacheStore.put('test-cache-key', testSnapshot);
      const retrieved = await cacheStore.get('test-cache-key');

      expect(retrieved).toBeDefined();
      expect(retrieved?.cacheKey).toBe('test-cache-key');
      expect(retrieved?.compiledSQL).toBe('SELECT * FROM test_table');
    });
  });
});
