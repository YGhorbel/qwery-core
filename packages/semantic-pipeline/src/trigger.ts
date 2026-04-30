/**
 * Phase 5 — Schema change detection trigger.
 * Called from apps/server/src/routes/datasources.ts after datasource save.
 */
import type { Datasource } from '@qwery/domain/entities';
import { getLogger } from '@qwery/shared/logger';
import { run, detectSchemaChanges } from './pipeline.js';

export async function triggerIfNeeded(datasource: Datasource): Promise<void> {
  const logger = await getLogger();
  const tag = `[SemanticPipeline:${datasource.name}]`;

  const changed = await detectSchemaChanges(datasource);
  if (!changed) {
    logger.info(`${tag} Schema unchanged — pipeline skipped`);
    return;
  }

  const mode = process.env.QWERY_PIPELINE_MODE ?? 'background';
  logger.info(`${tag} Schema change detected — starting pipeline (mode: ${mode})`);

  if (mode === 'inline') {
    await run(datasource);
  } else {
    void run(datasource).catch(async (err: unknown) => {
      const l = await getLogger();
      l.error(
        { err },
        `${tag} Background pipeline failed for datasource ${datasource.id}`,
      );
    });
  }
}
