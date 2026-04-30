/**
 * Agent 01 — Schema Scanner
 * Wraps the existing driver instance.metadata() call and persists the result to
 * QWERY_STORAGE_DIR/datasources/{id}/schema.json (same location as Phase 1 cache).
 */
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Datasource } from '@qwery/domain/entities';
import { ExtensionsRegistry, type DatasourceExtension } from '@qwery/extensions-sdk';
import { getDriverInstance } from '@qwery/extensions-loader';
import { paths, writeJson } from '../storage.js';

export async function scanSchema(datasource: Datasource): Promise<DatasourceMetadata> {
  const extension = ExtensionsRegistry.get(datasource.datasource_provider) as
    | DatasourceExtension
    | undefined;

  if (!extension?.drivers?.length) {
    throw new Error(`No driver for provider: ${datasource.datasource_provider}`);
  }

  const nodeDriver =
    extension.drivers.find((d) => d.runtime === 'node') ?? extension.drivers[0];

  if (!nodeDriver) {
    throw new Error(`No node driver for provider: ${datasource.datasource_provider}`);
  }

  const instance = await getDriverInstance(nodeDriver, { config: datasource.config });

  try {
    const metadata = await instance.metadata();

    // Persist in the same cache format as Phase 1 get-schema.ts
    await writeJson(paths.schema(datasource.id), {
      metadata,
      cachedAt: Date.now(),
    });

    return metadata;
  } finally {
    if (typeof instance.close === 'function') {
      await instance.close();
    }
  }
}
