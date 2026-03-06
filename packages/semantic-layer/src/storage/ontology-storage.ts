import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import { validateOntology } from '../loader/yaml-loader';
import { parse, stringify } from 'yaml';
import { MinIOClient, getMinIOClient } from './minio-client';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface OntologyStorage {
  loadOntology(version: string): Promise<Ontology | null>;
  storeOntology(version: string, ontology: Ontology): Promise<void>;
  ontologyExists(version: string): Promise<boolean>;
  listVersions(): Promise<string[]>;
  getOntologyMetadata(version: string): Promise<{ lastModified?: Date; size?: number } | null>;
}

export class MinIOOntologyStorage implements OntologyStorage {
  private client: MinIOClient;

  constructor(client: MinIOClient) {
    this.client = client;
  }

  async loadOntology(version: string): Promise<Ontology | null> {
    const logger = await getLogger();
    const path = `ontology/${version}/base.yaml`;

    logger.debug('[OntologyStorage] Loading ontology from MinIO', {
      version,
      path,
    });

    const object = await this.client.getObject(path);
    if (!object) {
      logger.debug('[OntologyStorage] Ontology not found in MinIO', {
        version,
        path,
      });
      return null;
    }

    try {
      const parsed = parse(object.content);
      const ontology = validateOntology(parsed);

      logger.info('[OntologyStorage] Ontology loaded from MinIO', {
        version,
        conceptsCount: ontology.ontology.concepts.length,
      });

      return ontology;
    } catch (error) {
      logger.error('[OntologyStorage] Failed to parse ontology from MinIO', {
        version,
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  async storeOntology(version: string, ontology: Ontology): Promise<void> {
    const logger = await getLogger();
    const path = `ontology/${version}/base.yaml`;

    logger.debug('[OntologyStorage] Storing ontology to MinIO', {
      version,
      path,
    });

    const yamlContent = this.ontologyToYAML(ontology);
    await this.client.putObject(path, yamlContent, 'application/x-yaml');

    logger.info('[OntologyStorage] Ontology stored to MinIO', {
      version,
      conceptsCount: ontology.ontology.concepts.length,
    });
  }

  async ontologyExists(version: string): Promise<boolean> {
    const path = `ontology/${version}/base.yaml`;
    return this.client.objectExists(path);
  }

  async listVersions(): Promise<string[]> {
    const logger = await getLogger();

    logger.debug('[OntologyStorage] Listing ontology versions');

    const objects = await this.client.listObjects('ontology/');
    const versions = new Set<string>();

    for (const obj of objects) {
      const match = obj.match(/^ontology\/([^/]+)\/base\.yaml$/);
      if (match && match[1]) {
        versions.add(match[1]);
      }
    }

    return Array.from(versions).sort();
  }

  async getOntologyMetadata(version: string): Promise<{ lastModified?: Date; size?: number } | null> {
    const path = `ontology/${version}/base.yaml`;
    return this.client.getObjectMetadata(path);
  }

  private ontologyToYAML(ontology: Ontology): string {
    const yamlObj = {
      ontology: {
        concepts: ontology.ontology.concepts,
        inheritance: ontology.ontology.inheritance || [],
      },
    };
    return stringify(yamlObj, { indent: 2 });
  }
}

export function getOntologyStorage(): OntologyStorage | null {
  const client = getMinIOClient();
  if (!client) {
    return null;
  }
  return new MinIOOntologyStorage(client);
}
