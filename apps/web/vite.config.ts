import { reactRouter } from '@react-router/dev/vite';
import { defineConfig, type Plugin } from 'vite';
import devtoolsJson from 'vite-plugin-devtools-json';
import tsconfigPaths from 'vite-tsconfig-paths';
import fs from 'node:fs';
import path from 'node:path';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

import tailwindCssVitePlugin from '@qwery/tailwind-config/vite';

// #region agent log
function debugOptimizeDepsPlugin(): Plugin {
  return {
    name: 'debug-optimize-deps',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';
        if (url.includes('/node_modules/.vite/deps/')) {
          fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              location: 'vite.config.ts:debugOptimizeDepsPlugin',
              message: 'Dependency request',
              data: { url, method: req.method, status: res.statusCode },
              timestamp: Date.now(),
              runId: 'run1',
              hypothesisId: 'B',
            }),
          }).catch(() => {});
        }
        next();
      });
    },
    buildStart() {
      fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          location: 'vite.config.ts:debugOptimizeDepsPlugin:buildStart',
          message: 'Vite build started',
          data: { optimizeDepsForce: true },
          timestamp: Date.now(),
          runId: 'run1',
          hypothesisId: 'C',
        }),
      }).catch(() => {});
    },
  };
}
// #endregion agent log

// Plugin to set correct MIME type for WASM files and extension drivers
function wasmMimeTypePlugin(): Plugin {
  return {
    name: 'wasm-mime-type',
    enforce: 'pre', // Run before other plugins to set headers early
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url || '';

        if (url.startsWith('/extensions/')) {
          try {
            // Resolve public directory relative to the vite config file location
            const publicDir = path.resolve(process.cwd(), 'apps/web/public');
            const filePath = path.join(publicDir, url);

            if (url.endsWith('.js')) {
              res.setHeader('Content-Type', 'application/javascript');
            } else if (url.endsWith('.wasm')) {
              res.setHeader('Content-Type', 'application/wasm');
            } else if (url.endsWith('.data')) {
              res.setHeader('Content-Type', 'application/octet-stream');
            } else if (url.endsWith('.json')) {
              res.setHeader('Content-Type', 'application/json');
            }

            const fileContent = fs.readFileSync(filePath);
            res.end(fileContent);
            return;
          } catch {
            // File doesn't exist, was removed, or path resolution failed - continue to next middleware
          }
        }

        // Handle WASM files with correct MIME type
        if (url.endsWith('.wasm')) {
          res.setHeader('Content-Type', 'application/wasm');
        }

        // Handle worker files with correct MIME type
        if (url.endsWith('.worker.js') || url.includes('.worker.')) {
          res.setHeader('Content-Type', 'application/javascript');
        }

        // Handle source map files
        if (url.endsWith('.map')) {
          res.setHeader('Content-Type', 'application/json');
        }

        next();
      });
    },
  };
}

const ALLOWED_HOSTS =
  process.env.NODE_ENV === 'development' ? ['host.docker.internal'] : [];

// Polyfill require() in ESM for deps that use it (e.g. turndown -> @mixmark-io/domino)
function requirePolyfillPlugin(): Plugin {
  return {
    name: 'replace-domino-require',
    enforce: 'pre',
    transform(code, id) {
      if (!id || !id.includes('node_modules/turndown')) return null;
      const pattern = /require\(['"]@mixmark-io\/domino['"]\)/g;
      if (pattern.test(code)) {
        const replaced = code.replace(pattern, 'undefined');
        return { code: replaced, map: null };
      }
      return null;
    },
  };
}

// Prevent pg from being bundled in client code
function pgStubPlugin(): Plugin {
  return {
    name: 'stub-pg',
    enforce: 'pre',
    resolveId(id, importer) {
      // Only stub pg in client code, not SSR (SSR imports have ?ssr query param or are in entry.server)
      if (id === 'pg' || id.startsWith('pg/')) {
        const isSSR = importer?.includes('?ssr') || importer?.includes('entry.server');
        if (!isSSR) {
          return { id: '\0pg-stub', moduleSideEffects: false };
        }
      }
      return null;
    },
    load(id) {
      if (id === '\0pg-stub') {
        return 'export default {}; export const Pool = class {}; export const Client = class {};';
      }
      return null;
    },
  };
}

// Prevent redis from being bundled in client code
function redisStubPlugin(): Plugin {
  return {
    name: 'stub-redis',
    enforce: 'pre',
    resolveId(id, importer) {
      // Only stub redis in client code, not SSR (SSR imports have ?ssr query param or are in entry.server)
      if (id === 'redis' || id.startsWith('redis/')) {
        const isSSR = importer?.includes('?ssr') || importer?.includes('entry.server');
        if (!isSSR) {
          return { id: '\0redis-stub', moduleSideEffects: false };
        }
      }
      return null;
    },
    load(id) {
      if (id === '\0redis-stub') {
        return 'export const createClient = () => ({ connect: async () => {}, disconnect: async () => {}, on: () => {}, get: async () => null, set: async () => {}, del: async () => {}, exists: async () => 0, incr: async () => 0, expire: async () => {}, keys: async () => [], mGet: async () => [], mSet: async () => {} }); export default {};';
      }
      return null;
    },
  };
}

// Prevent @qwery/semantic-layer from being bundled in client code
function semanticLayerStubPlugin(): Plugin {
  const getStubExports = (subpath: string): string => {
    const baseExports = `
export const loadOntology = async () => null;
export const loadMappings = async () => ({});
export const autoInitializeSemanticLayer = async () => {};
export const generateMappings = async () => ({});
export const storeMappings = async () => {};
export const compileSemanticQuery = async () => ({ sql: "", reasoning: [] });
export const extractSemanticIntent = async () => ({ intent: "", entities: [] });
export const buildOntologySchemaView = async () => ({});
export const explainQueryResult = async () => ({ 
  summary: "", 
  insights: [], 
  relatedQueries: [], 
  validation: { matchesIntent: true, issues: [] } 
});
export const validateResultAgainstIntent = async () => ({ matches: true, issues: [] });
export const reasonOverOntology = async () => ({ steps: [], finalPlan: null });
export const formatReasoningChain = () => "";
export const getCachedQuery = async () => null;
export const storeCachedQuery = async () => {};
export const invalidateCache = async () => {};
export default {};
`;

    if (subpath === 'post-processor/explainer') {
      return `export const explainQueryResult = async () => ({ 
  summary: "", 
  insights: [], 
  relatedQueries: [], 
  validation: { matchesIntent: true, issues: [] } 
});
export const validateResultAgainstIntent = async () => ({ matches: true, issues: [] });`;
    }
    if (subpath === 'reasoning/cot-reasoner') {
      return `export const reasonOverOntology = async () => ({ steps: [], finalPlan: null });`;
    }
    if (subpath === 'reasoning/format-reasoning') {
      return `export const formatReasoningChain = () => "";`;
    }
    if (subpath === 'cache/semantic-cache') {
      return `export const getCachedQuery = async () => null;
export const storeCachedQuery = async () => {};
export const invalidateCache = async () => {};`;
    }
    if (subpath === 'compiler/semantic-compiler') {
      return `export const compileSemanticQuery = async () => ({ sql: "", reasoning: [] });`;
    }
    if (subpath === 'compiler/intent-extractor') {
      return `export const extractSemanticIntent = async () => ({ intent: "", entities: [] });`;
    }
    if (subpath === 'ontology/loader') {
      return `export const loadOntology = async () => null;`;
    }
    if (subpath === 'mapping/store') {
      return `export const loadMappings = async () => ({});
export const storeMappings = async () => ({ tableMappingsCreated: 0, columnMappingsCreated: 0 });`;
    }
    if (subpath === 'mapping/generator') {
      return `export const generateMappings = async () => ({});`;
    }
    if (subpath === 'initialization/auto-initialize') {
      return `export const autoInitializeSemanticLayer = async () => {};`;
    }
    if (subpath === 'schema/ontology-schema-view') {
      return `export const buildOntologySchemaView = async () => ({});`;
    }
    if (subpath === 'compiler/types') {
      return `export type SemanticPlan = any;
export type MappingResult = any;`;
    }
    
    return baseExports;
  };

  return {
    name: 'stub-semantic-layer',
    enforce: 'pre',
    resolveId(id, importer) {
      // Only stub semantic-layer in client code, not SSR
      if (id === '@qwery/semantic-layer' || id.startsWith('@qwery/semantic-layer/')) {
        const isSSR = importer?.includes('?ssr') || importer?.includes('entry.server');
        if (!isSSR) {
          const subpath = id === '@qwery/semantic-layer' ? 'default' : id.replace('@qwery/semantic-layer/', '');
          return { id: `\0semantic-layer-stub:${subpath}`, moduleSideEffects: false };
        }
      }
      // Also catch internal semantic-layer file paths
      if (id.includes('semantic-layer') && (id.includes('storage') || id.includes('minio'))) {
        const isSSR = importer?.includes('?ssr') || importer?.includes('entry.server');
        if (!isSSR) {
          return { id: '\0semantic-layer-stub:storage', moduleSideEffects: false };
        }
      }
      return null;
    },
    load(id) {
      if (id.startsWith('\0semantic-layer-stub:')) {
        const subpath = id.replace('\0semantic-layer-stub:', '');
        return getStubExports(subpath);
      }
      // Block loading of minio-store files directly
      if (id.includes('minio-store') && !id.includes('entry.server') && !id.includes('?ssr')) {
        return 'export default {};';
      }
      return null;
    },
    transform(code, id) {
      // Block any semantic-layer storage imports in client code
      const isSSR = id?.includes('?ssr') || id?.includes('entry.server');
      if (!isSSR && (code.includes('semantic-layer/storage') || code.includes('semantic-layer/storage/minio-store') || code.includes('minio-store'))) {
        return {
          code: 'export default {};',
          map: null,
        };
      }
      return null;
    },
  };
}

// Stub node:crypto for client code (use Web Crypto API instead)
function nodeCryptoStubPlugin(): Plugin {
  return {
    name: 'stub-node-crypto',
    enforce: 'pre',
    resolveId(id, importer) {
      if (id === 'node:crypto' || id === 'crypto') {
        const isSSR = importer?.includes('?ssr') || importer?.includes('entry.server');
        if (!isSSR) {
          return { id: '\0node-crypto-stub', moduleSideEffects: false };
        }
      }
      return null;
    },
    load(id) {
      if (id === '\0node-crypto-stub') {
        return 'export const randomUUID = () => crypto.randomUUID(); export default { randomUUID };';
      }
      return null;
    },
    transform(code, id) {
      // Transform node:crypto imports in client code
      const isSSR = id?.includes('?ssr') || id?.includes('entry.server');
      if (!isSSR && (code.includes("from 'node:crypto'") || code.includes('from "node:crypto"') || code.includes("require('node:crypto'") || code.includes('require("node:crypto"'))) {
        return {
          code: code
            .replace(/from ['"]node:crypto['"]/g, "from '\0node-crypto-stub'")
            .replace(/require\(['"]node:crypto['"]\)/g, "require('\0node-crypto-stub')"),
          map: null,
        };
      }
      return null;
    },
  };
}

export default defineConfig(({ command }) => ({
  resolve: {
    // Dedupe i18next and react-i18next to ensure single instance across all packages
    // This is critical for monorepo setups where multiple packages use these libraries
    dedupe: ['i18next', 'react-i18next', 'react', 'react-dom'],
  },
  ssr: {
    noExternal:
      command === 'build'
        ? true
        : ['posthog-js', '@posthog/react', 'streamdown'],
    external: [
      '@duckdb/node-api',
      '@duckdb/node-bindings-linux-arm64',
      '@duckdb/node-bindings-linux-x64',
      '@duckdb/node-bindings-darwin-arm64',
      '@duckdb/node-bindings-darwin-x64',
      '@duckdb/node-bindings-win32-x64',
      'pg',
      'redis',
      '@qwery/semantic-layer',
    ],
  },
  plugins: [
    debugOptimizeDepsPlugin(),
    wasmMimeTypePlugin(),
    devtoolsJson(),
    reactRouter(),
    tsconfigPaths({ ignoreConfigErrors: true }),
    wasm(),
    topLevelAwait(),
    requirePolyfillPlugin(),
    pgStubPlugin(),
    redisStubPlugin(),
    semanticLayerStubPlugin(),
    nodeCryptoStubPlugin(),
    ...tailwindCssVitePlugin.plugins,
  ],
  server: {
    host: '0.0.0.0',
    port: 3000,
    allowedHosts: ALLOWED_HOSTS,
    watch: {
      usePolling: true,
      interval: 1000,
    },
    hmr: {
      overlay: true,
    },
    proxy: {
      // Proxy /api to apps/server when client uses relative URLs (VITE_API_URL unset)
      // Enables breadcrumb, orgs, projects, datasources etc. to load from server
      '/api': {
        target: 'http://localhost:4096',
        changeOrigin: true,
      },
    },
  },
  build: {
    sourcemap: false, // Disable sourcemaps to avoid resolution errors in monorepo
    manifest: true, // Enable manifest generation for React Router
    rollupOptions: {
      external: (id: string) => {
        if (id === 'fsevents') return true;
        if (id === '@duckdb/node-api') return true;
        if (id.startsWith('@duckdb/node-bindings')) return true;
        if (id.includes('@duckdb/node-bindings') && id.endsWith('.node')) {
          return true;
        }
        if (id.startsWith('node:')) return true;
        if (id === 'pg' || id.startsWith('pg/')) return true;
        if (id === 'redis' || id.startsWith('redis/')) return true;
        if (id === '@qwery/semantic-layer' || id.startsWith('@qwery/semantic-layer/')) return true;
        return false;
      },
      output: {
        manualChunks: (id) => {
          // Bundle ai and @ai-sdk/react together so Chat class loads before agent-ui
          if (
            id.includes('node_modules/ai/') ||
            id.includes('node_modules/@ai-sdk/react')
          ) {
            return 'ai-sdk';
          }
        },
      },
    },
  },
  optimizeDeps: {
    force: true,
    exclude: [
      'fsevents',
      '@electric-sql/pglite',
      '@duckdb/node-api',
      '@duckdb/duckdb-wasm',
      '@qwery/agent-factory-sdk',
      '@qwery/semantic-layer',
      'pg',
      'redis',
      '@dqbd/tiktoken',
      '@qwery/extension-s3',
      '@qwery/extension-clickhouse-node',
      '@qwery/extension-duckdb',
      '@qwery/extension-mysql',
      '@qwery/extension-postgresql',
      '@qwery/extension-parquet-online',
      '@qwery/extension-gsheet-csv',
      '@qwery/extension-json-online',
      '@qwery/extension-youtube-data-api-v3',
      '@ai-sdk/mcp',
      '@ai-sdk/openai',
      '@ai-sdk/amazon-bedrock',
      '@ai-sdk/anthropic',
      '@ai-sdk/azure',
      '@ai-sdk/openai-compatible',
      '@opentelemetry/api',
      'nats',
    ],
    include: [
      'i18next',
      'react-i18next',
      'react',
      'react-dom',
      'react-router',
      'posthog-js',
    ],
    esbuildOptions: {
      target: 'esnext',
    },
    entries: [
      './app/root.tsx',
      './app/entry.server.tsx',
      './app/routes/**/*.tsx',
    ],
    worker: {
      format: 'es',
    },
  },
}));
