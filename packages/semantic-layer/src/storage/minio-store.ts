import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import type { MappingResult } from '../mapping/generator';
import { MinIOClient } from './minio-client';
import { parse, stringify } from 'yaml';
import { validateOntology } from '../loader/yaml-loader';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

function randomUUID(): string {
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto.randomUUID) {
    return globalThis.crypto.randomUUID();
  }
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  throw new Error('randomUUID is not available in this environment');
}

export interface VersionInfo {
  version: string;
  path: string;
  lastModified?: Date;
  size?: number;
}

export interface Manifest {
  latest: string;
  versions: VersionInfo[];
}

export interface OntologyStore {
  get(version?: string | 'latest'): Promise<Ontology | null>;
  put(version: string, ontology: Ontology, metadata?: Record<string, unknown>): Promise<void>;
  listVersions(): Promise<VersionInfo[]>;
  delete(version: string): Promise<void>;
  getManifest(): Promise<Manifest | null>;
}

export interface MappingStore {
  get(datasourceId: string, version?: string | 'latest'): Promise<MappingResult | null>;
  put(datasourceId: string, version: string, mappings: MappingResult, metadata?: Record<string, unknown>): Promise<void>;
  listVersions(datasourceId: string): Promise<VersionInfo[]>;
  delete(datasourceId: string, version: string): Promise<void>;
  getManifest(datasourceId: string): Promise<Manifest | null>;
}

export interface CacheStore {
  get(cacheKey: string): Promise<CacheSnapshot | null>;
  put(cacheKey: string, snapshot: CacheSnapshot): Promise<void>;
  delete(cacheKey: string): Promise<void>;
  list(datasourceId: string): Promise<string[]>;
}

export interface CacheSnapshot {
  cacheKey: string;
  datasourceId: string;
  semanticPlan: unknown;
  compiledSQL: string;
  resultSummary?: unknown;
  timestamp: string;
}

export class MinIOStore {
  private client: MinIOClient;

  constructor(client: MinIOClient) {
    this.client = client;
  }

  private async getManifest(path: string): Promise<Manifest | null> {
    const object = await this.client.getObject(path);
    if (!object) {
      return null;
    }

    try {
      return JSON.parse(object.content) as Manifest;
    } catch (error) {
      const logger = await getLogger();
      logger.error('[MinIOStore] Failed to parse manifest', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private async putManifest(path: string, manifest: Manifest): Promise<void> {
    const content = JSON.stringify(manifest, null, 2);
    const tempPath = `${path}.tmp-${randomUUID()}`;

    try {
      await this.client.putObject(tempPath, content, 'application/json');
      const existing = await this.client.objectExists(path);
      if (existing) {
        await this.client.deleteObject(path);
      }
      const tempContent = await this.client.getObject(tempPath);
      if (tempContent) {
        await this.client.putObject(path, tempContent.content, 'application/json');
        await this.client.deleteObject(tempPath);
      }
    } catch (error) {
      const logger = await getLogger();
      logger.error('[MinIOStore] Failed to update manifest atomically', {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      try {
        await this.client.deleteObject(tempPath);
      } catch {
      }
      throw error;
    }
  }

  createOntologyStore(): OntologyStore {
    return {
      get: async (version = 'latest') => {
        const logger = await getLogger();
        let targetVersion = version;

        if (version === 'latest') {
          const manifest = await this.getManifest('ontology/manifest.json');
          if (!manifest || !manifest.latest) {
            logger.debug('[OntologyStore] No latest version in manifest');
            return null;
          }
          targetVersion = manifest.latest;
        }

        const path = `ontology/${targetVersion}/base.yaml`;
        logger.debug('[OntologyStore] Loading ontology', { version: targetVersion, path });

        const object = await this.client.getObject(path);
        if (!object) {
          return null;
        }

        try {
          const parsed = parse(object.content);
          const ontology = validateOntology(parsed);
          logger.info('[OntologyStore] Ontology loaded', {
            version: targetVersion,
            conceptsCount: ontology.ontology.concepts.length,
          });
          return ontology;
        } catch (error) {
          logger.error('[OntologyStore] Failed to parse ontology', {
            version: targetVersion,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      put: async (version, ontology, metadata) => {
        const logger = await getLogger();
        const path = `ontology/${version}/base.yaml`;
        const tempPath = `ontology/${version}/tmp-${randomUUID()}.yaml`;

        logger.debug('[OntologyStore] Storing ontology', { version, path });

        const yamlObj = {
          ontology: {
            concepts: ontology.ontology.concepts,
            inheritance: ontology.ontology.inheritance || [],
          },
        };
        const yamlContent = stringify(yamlObj, { indent: 2 });

        try {
          await this.client.putObject(tempPath, yamlContent, 'application/x-yaml');
          const existing = await this.client.objectExists(path);
          if (existing) {
            await this.client.deleteObject(path);
          }
          await this.client.putObject(path, yamlContent, 'application/x-yaml');
          await this.client.deleteObject(tempPath);

          const manifest = await this.getManifest('ontology/manifest.json');
          const versionInfo: VersionInfo = {
            version,
            path,
            lastModified: new Date(),
            size: yamlContent.length,
          };

          if (manifest) {
            const existingVersionIndex = manifest.versions.findIndex((v) => v.version === version);
            if (existingVersionIndex >= 0) {
              manifest.versions[existingVersionIndex] = versionInfo;
            } else {
              manifest.versions.push(versionInfo);
            }
            manifest.latest = version;
            manifest.versions.sort((a, b) => b.version.localeCompare(a.version));
          } else {
            const newManifest: Manifest = {
              latest: version,
              versions: [versionInfo],
            };
            await this.putManifest('ontology/manifest.json', newManifest);
            return;
          }

          await this.putManifest('ontology/manifest.json', manifest);

          logger.info('[OntologyStore] Ontology stored', {
            version,
            conceptsCount: ontology.ontology.concepts.length,
          });
        } catch (error) {
          logger.error('[OntologyStore] Failed to store ontology', {
            version,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      listVersions: async () => {
        const logger = await getLogger();
        logger.debug('[OntologyStore] Listing versions');

        const manifest = await this.getManifest('ontology/manifest.json');
        if (manifest) {
          return manifest.versions;
        }

        const objects = await this.client.listObjects('ontology/');
        const versions: VersionInfo[] = [];

        for (const obj of objects) {
          const match = obj.match(/^ontology\/([^/]+)\/base\.yaml$/);
          if (match && match[1]) {
            const metadata = await this.client.getObjectMetadata(obj);
            versions.push({
              version: match[1],
              path: obj,
              lastModified: metadata?.lastModified,
              size: metadata?.size,
            });
          }
        }

        return versions.sort((a, b) => b.version.localeCompare(a.version));
      },

      delete: async (version) => {
        const logger = await getLogger();
        const path = `ontology/${version}/base.yaml`;

        logger.debug('[OntologyStore] Deleting ontology', { version, path });

        await this.client.deleteObject(path);

        const manifest = await this.getManifest('ontology/manifest.json');
        if (manifest && manifest.versions.length > 0) {
          manifest.versions = manifest.versions.filter((v) => v.version !== version);
          if (manifest.latest === version && manifest.versions.length > 0) {
            manifest.latest = manifest.versions[0]?.version || '';
          } else if (manifest.versions.length === 0) {
            manifest.latest = '';
          }
          await this.putManifest('ontology/manifest.json', manifest);
        }

        logger.info('[OntologyStore] Ontology deleted', { version });
      },

      getManifest: async () => {
        return this.getManifest('ontology/manifest.json');
      },
    };
  }

  createMappingStore(): MappingStore {
    return {
      get: async (datasourceId, version = 'latest') => {
        const logger = await getLogger();
        let targetVersion = version;

        if (version === 'latest') {
          const manifest = await this.getManifest(`mappings/${datasourceId}/manifest.json`);
          if (!manifest || !manifest.latest) {
            logger.debug('[MappingStore] No latest version in manifest', { datasourceId });
            return null;
          }
          targetVersion = manifest.latest;
        }

        const path = `mappings/${datasourceId}/${targetVersion}/mappings.json`;
        logger.debug('[MappingStore] Loading mappings', {
          datasourceId,
          version: targetVersion,
          path,
        });

        const object = await this.client.getObject(path);
        if (!object) {
          return null;
        }

        try {
          const mappings = JSON.parse(object.content) as MappingResult;
          logger.info('[MappingStore] Mappings loaded', {
            datasourceId,
            version: targetVersion,
            tableMappingsCount: mappings.table_mappings.length,
          });
          return mappings;
        } catch (error) {
          logger.error('[MappingStore] Failed to parse mappings', {
            datasourceId,
            version: targetVersion,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      put: async (datasourceId, version, mappings, metadata) => {
        const logger = await getLogger();
        const path = `mappings/${datasourceId}/${version}/mappings.json`;
        const tempPath = `mappings/${datasourceId}/${version}/tmp-${randomUUID()}.json`;

        logger.debug('[MappingStore] Storing mappings', {
          datasourceId,
          version,
          path,
        });

        const jsonContent = JSON.stringify(mappings, null, 2);

        try {
          await this.client.putObject(tempPath, jsonContent, 'application/json');
          const existing = await this.client.objectExists(path);
          if (existing) {
            await this.client.deleteObject(path);
          }
          await this.client.putObject(path, jsonContent, 'application/json');
          await this.client.deleteObject(tempPath);

          const manifestPath = `mappings/${datasourceId}/manifest.json`;
          const manifest = await this.getManifest(manifestPath);
          const versionInfo: VersionInfo = {
            version,
            path,
            lastModified: new Date(),
            size: jsonContent.length,
          };

          if (manifest) {
            const existingVersionIndex = manifest.versions.findIndex((v) => v.version === version);
            if (existingVersionIndex >= 0) {
              manifest.versions[existingVersionIndex] = versionInfo;
            } else {
              manifest.versions.push(versionInfo);
            }
            manifest.latest = version;
            manifest.versions.sort((a, b) => b.version.localeCompare(a.version));
          } else {
            const newManifest: Manifest = {
              latest: version,
              versions: [versionInfo],
            };
            await this.putManifest(manifestPath, newManifest);
            return;
          }

          await this.putManifest(manifestPath, manifest);

          logger.info('[MappingStore] Mappings stored', {
            datasourceId,
            version,
            tableMappingsCount: mappings.table_mappings.length,
          });
        } catch (error) {
          logger.error('[MappingStore] Failed to store mappings', {
            datasourceId,
            version,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      listVersions: async (datasourceId) => {
        const logger = await getLogger();
        logger.debug('[MappingStore] Listing versions', { datasourceId });

        const manifest = await this.getManifest(`mappings/${datasourceId}/manifest.json`);
        if (manifest) {
          return manifest.versions;
        }

        const objects = await this.client.listObjects(`mappings/${datasourceId}/`);
        const versions: VersionInfo[] = [];

        for (const obj of objects) {
          const match = obj.match(/^mappings\/[^/]+\/([^/]+)\/mappings\.json$/);
          if (match && match[1]) {
            const metadata = await this.client.getObjectMetadata(obj);
            versions.push({
              version: match[1],
              path: obj,
              lastModified: metadata?.lastModified,
              size: metadata?.size,
            });
          }
        }

        return versions.sort((a, b) => b.version.localeCompare(a.version));
      },

      delete: async (datasourceId, version) => {
        const logger = await getLogger();
        const path = `mappings/${datasourceId}/${version}/mappings.json`;

        logger.debug('[MappingStore] Deleting mappings', { datasourceId, version, path });

        await this.client.deleteObject(path);

        const manifestPath = `mappings/${datasourceId}/manifest.json`;
        const manifest = await this.getManifest(manifestPath);
        if (manifest && manifest.versions.length > 0) {
          manifest.versions = manifest.versions.filter((v) => v.version !== version);
          if (manifest.latest === version && manifest.versions.length > 0) {
            manifest.latest = manifest.versions[0]?.version || '';
          } else if (manifest.versions.length === 0) {
            manifest.latest = '';
          }
          await this.putManifest(manifestPath, manifest);
        }

        logger.info('[MappingStore] Mappings deleted', { datasourceId, version });
      },

      getManifest: async (datasourceId) => {
        return this.getManifest(`mappings/${datasourceId}/manifest.json`);
      },
    };
  }

  createCacheStore(): CacheStore {
    return {
      get: async (cacheKey) => {
        const logger = await getLogger();
        const datasourceId = cacheKey.split(':')[0] || '';
        const path = `cache/snapshots/${datasourceId}/${cacheKey}.json`;

        logger.debug('[CacheStore] Loading cache snapshot', { cacheKey, path });

        const object = await this.client.getObject(path);
        if (!object) {
          return null;
        }

        try {
          const snapshot = JSON.parse(object.content) as CacheSnapshot;
          logger.debug('[CacheStore] Cache snapshot loaded', { cacheKey });
          return snapshot;
        } catch (error) {
          logger.error('[CacheStore] Failed to parse cache snapshot', {
            cacheKey,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      put: async (cacheKey, snapshot) => {
        const logger = await getLogger();
        const path = `cache/snapshots/${snapshot.datasourceId}/${cacheKey}.json`;
        const tempPath = `cache/snapshots/${snapshot.datasourceId}/tmp-${randomUUID()}.json`;

        logger.debug('[CacheStore] Storing cache snapshot', { cacheKey, path });

        const jsonContent = JSON.stringify(snapshot, null, 2);

        try {
          await this.client.putObject(tempPath, jsonContent, 'application/json');
          const existing = await this.client.objectExists(path);
          if (existing) {
            await this.client.deleteObject(path);
          }
          await this.client.putObject(path, jsonContent, 'application/json');
          await this.client.deleteObject(tempPath);

          logger.debug('[CacheStore] Cache snapshot stored', { cacheKey });
        } catch (error) {
          logger.error('[CacheStore] Failed to store cache snapshot', {
            cacheKey,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }
      },

      delete: async (cacheKey) => {
        const logger = await getLogger();
        const datasourceId = cacheKey.split(':')[0] || '';
        const path = `cache/snapshots/${datasourceId}/${cacheKey}.json`;

        logger.debug('[CacheStore] Deleting cache snapshot', { cacheKey, path });

        await this.client.deleteObject(path);
        logger.debug('[CacheStore] Cache snapshot deleted', { cacheKey });
      },

      list: async (datasourceId) => {
        const logger = await getLogger();
        logger.debug('[CacheStore] Listing cache snapshots', { datasourceId });

        const objects = await this.client.listObjects(`cache/snapshots/${datasourceId}/`);
        const cacheKeys: string[] = [];

        for (const obj of objects) {
          const match = obj.match(/^cache\/snapshots\/[^/]+\/([^/]+)\.json$/);
          if (match && match[1] && !match[1].startsWith('tmp-')) {
            cacheKeys.push(match[1]);
          }
        }

        return cacheKeys;
      },
    };
  }
}

let defaultStore: MinIOStore | null = null;

export function getMinIOStore(): MinIOStore | null {
  return defaultStore;
}

export function setMinIOStore(store: MinIOStore | null): void {
  defaultStore = store;
}

export function createMinIOStoreFromClient(client: MinIOClient): MinIOStore {
  return new MinIOStore(client);
}
