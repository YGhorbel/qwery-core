import '@qwery/extensions-loader';
import { ExtensionsRegistry, ExtensionScope } from '@qwery/extensions-sdk';
import { getLogger } from '@qwery/shared/logger';
import { createApp } from './server';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const serverRoot = join(__dirname, '..');
const envPath = join(serverRoot, '.env');
if (existsSync(envPath)) {
  const content = readFileSync(envPath, 'utf-8');
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#')) {
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const value = trimmed
          .slice(eq + 1)
          .trim()
          .replace(/^["']|["']$/g, '');
        if (process.env[key] === undefined) process.env[key] = value;
      }
    }
  }
}

const storageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
process.env.QWERY_STORAGE_DIR = isAbsolute(storageDir)
  ? storageDir
  : resolve(serverRoot, storageDir);

const raw =
  process.env.WORKSPACE?.trim() ||
  process.env.VITE_WORKING_DIR?.trim() ||
  process.env.WORKING_DIR?.trim() ||
  'workspace';
process.env.WORKSPACE = isAbsolute(raw) ? raw : resolve(serverRoot, raw);

const PORT = Number(process.env.PORT ?? 4096);
const HOSTNAME = process.env.HOSTNAME ?? '0.0.0.0';

const logger = await getLogger();
const extensionsCount = ExtensionsRegistry.list(
  ExtensionScope.DATASOURCE,
).length;
logger.info(`Discovered ${extensionsCount} datasource extensions`);

async function checkOllama(): Promise<void> {
  const base = process.env['OLLAMA_BASE_URL'] ?? 'https://ollama.com/v1';
  const apiKey = process.env['OLLAMA_API_KEY'] ?? '';
  try {
    const res = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.warn(
        `[ollama-cloud] Auth failed (${res.status}) — check OLLAMA_API_KEY`,
      );
      return;
    }
    const { data } = (await res.json()) as { data: { id: string }[] };
    const ids = data.map((m) => m.id);
    const sqlModel = process.env['OLLAMA_SQL_MODEL'] ?? 'qwen3-coder:480b';
    const reasonModel =
      process.env['OLLAMA_REASONING_MODEL'] ?? 'nemotron-3-nano:30b-cloud';
    if (!ids.some((id) => id.startsWith(sqlModel.split(':')[0]!))) {
      console.warn(
        `[ollama-cloud] SQL model "${sqlModel}" not found in available models`,
      );
    }
    if (!ids.some((id) => id.startsWith(reasonModel.split(':')[0]!))) {
      console.warn(
        `[ollama-cloud] Reasoning model "${reasonModel}" not found in available models`,
      );
    }
    console.log(`[ollama-cloud] Connected — ${ids.length} models available`);
  } catch {
    console.warn('[ollama-cloud] Could not reach ollama.com');
  }
}
await checkOllama();

const internalDbUrl = process.env.QWERY_INTERNAL_DATABASE_URL;
if (internalDbUrl) {
  try {
    const { VectorStore } = await import('@qwery/vector-store');
    const vectorStore = new VectorStore(internalDbUrl);
    await vectorStore.ensureSchema();
    await vectorStore.end();
    logger.info('Vector store schema ensured');
  } catch (err) {
    logger.warn({ err }, 'Vector store init failed — semantic search disabled');
  }

  // Wire artifact self-update: patch semantic layer from successful corrections
  try {
    const { ArtifactPatcher } = await import(
      '@qwery/semantic-pipeline/updater/artifact-patcher'
    );
    const { processSuccessfulQuery } = await import(
      '@qwery/semantic-pipeline/updater/update-orchestrator'
    );
    const { validateAndPromoteCandidates } = await import(
      '@qwery/semantic-pipeline/updater/candidate-validator'
    );
    const { EnrichmentAgent } = await import(
      '@qwery/semantic-pipeline/agents/enrichment-agent'
    );
    const { VectorStore, Embedder } = await import('@qwery/vector-store');
    const { setPostQueryHook, setEnrichmentAgent } = await import('@qwery/agent-factory-sdk');
    const resolvedStorageDir = process.env.QWERY_STORAGE_DIR ?? 'qwery.db';
    const patcher = new ArtifactPatcher(
      resolvedStorageDir,
      new VectorStore(internalDbUrl),
      new Embedder(),
    );
    setPostQueryHook((datasourceId, correctionTrace, fieldsUsed) => {
      processSuccessfulQuery(
        { datasourceId, fieldsUsed },
        correctionTrace as Parameters<typeof processSuccessfulQuery>[1],
        patcher,
      ).catch((err: unknown) =>
        logger.error({ err }, '[artifact-self-update] patch failed'),
      );
    });
    logger.info('Artifact self-update hook registered');

    // Wire enrichment agent: discovers missing measures/rules after every query
    const enrichmentAgent = new EnrichmentAgent(resolvedStorageDir);
    let enrichQueryCount = 0;
    setEnrichmentAgent({
      analyse: (input) => {
        // Fire enrichment (non-blocking)
        const enrichPromise = enrichmentAgent.analyse(input).catch((err: unknown) =>
          logger.error({ err }, '[enrichment-agent] analyse failed'),
        );

        // Trigger candidate promotion every 20 enriched queries
        enrichQueryCount++;
        if (enrichQueryCount % 20 === 0) {
          validateAndPromoteCandidates(input.datasourceId, patcher, resolvedStorageDir)
            .then(({ promoted, skipped }) => {
              if (promoted > 0 || skipped > 0) {
                logger.info(
                  { promoted, skipped, datasourceId: input.datasourceId },
                  '[candidate-validator] promotion run completed',
                );
              }
            })
            .catch((err: unknown) =>
              logger.warn({ err }, '[candidate-validator] promotion run failed'),
            );
        }

        return enrichPromise;
      },
    });
    logger.info('Enrichment agent registered');
  } catch (err) {
    logger.warn(
      { err },
      'Artifact self-update init failed — patching disabled',
    );
  }
}

const app = createApp();

const server = Bun.serve({
  port: PORT,
  hostname: HOSTNAME,
  fetch: app.fetch,
  idleTimeout: 120,
});

logger.info(
  { hostname: server.hostname, port: server.port },
  `Listening on http://${server.hostname}:${server.port}`,
);
