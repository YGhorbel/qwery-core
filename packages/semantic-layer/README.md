# @qwery/semantic-layer

Semantic layer implementation for Qwery, providing ontology-based query abstraction with dual-storage architecture (MinIO + PostgreSQL).

## Overview

The semantic layer provides:
- **Ontology Model**: Structured business concepts and relationships stored in MinIO (with PostgreSQL fallback)
- **Mapping System**: Maps datasource tables/columns to ontology concepts (stored in MinIO, synced to PostgreSQL)
- **Semantic Compiler**: Translates natural language queries to SQL via semantic concepts
- **Query Plan Validation**: Validates semantic plans against ontology before compilation
- **Semantic Cache**: Caches compiled semantic queries with exact match (hash-based) + MinIO snapshots
- **Post-Processing**: Result explanation and validation using GPT-5.2
- **Query History**: Logs semantic queries to MinIO for audit and analysis
- **Reasoning Traces**: Stores detailed reasoning traces for explainability
- **Error Handling**: Comprehensive fallbacks and retry logic
- **YAML-based Configuration**: Version-controlled ontology definitions

## Architecture

### High-Level Architecture

```mermaid
flowchart TB
    User[User Query] --> Agent[Agent Loop]
    Agent --> GetContext[getContext]
    GetContext --> Tools[Registry.tools.forAgent]
    Tools --> SemanticTool[runSemanticQuery Tool]
    
    SemanticTool --> MinIOClient[MinIO Client]
    MinIOClient --> MinIO[(MinIO Storage)]
    
    SemanticTool --> PostgresClient[Postgres Client]
    PostgresClient --> Postgres[(Postgres DB)]
    
    MinIO -.loads.-> Ontology[Ontology YAML]
    MinIO -.loads.-> Mappings[Mappings JSON]
    MinIO -.loads.-> CacheSnapshots[Cache Snapshots]
    MinIO -.loads.-> QueryHistory[Query History]
    MinIO -.loads.-> Traces[Reasoning Traces]
    
    Ontology --> Compiler[Semantic Compiler]
    Mappings --> Compiler
    
    Compiler --> PlanValidator[Plan Validator]
    PlanValidator --> QueryRewriter[Query Rewriter]
    QueryRewriter --> SQLGen[SQL Generator]
    SQLGen --> RunQuery[runQuery Tool]
    RunQuery --> Postgres
    
    Postgres --> Results[Query Results]
    Results --> PostProcessor[Post Processor]
    PostProcessor --> TraceBuilder[Trace Builder]
    TraceBuilder --> MinIO
    PostProcessor --> Agent
```

### Storage Architecture

```mermaid
flowchart LR
    subgraph Storage[Storage Layer]
        MinIO[(MinIO<br/>Primary Storage)]
        Postgres[(PostgreSQL<br/>Fallback/Metadata)]
    end
    
    subgraph Artifacts[Semantic Artifacts]
        Ontology[Ontology YAML]
        Mappings[Mapping JSON]
        CacheSnapshots[Cache Snapshots]
        History[Query History]
        Traces[Reasoning Traces]
    end
    
    subgraph Metadata[Postgres Metadata]
        OntologyMeta[Ontology Metadata]
        MappingMeta[Mapping Metadata]
        CacheIndex[Cache Index]
    end
    
    Ontology --> MinIO
    Mappings --> MinIO
    CacheSnapshots --> MinIO
    History --> MinIO
    Traces --> MinIO
    
    OntologyMeta --> Postgres
    MappingMeta --> Postgres
    CacheIndex --> Postgres
    
    MinIO -.sync.-> Postgres
    Postgres -.fallback.-> MinIO
```

### Storage Strategy

**MinIO (Primary Storage)**:
- `semantic-layer/ontology/{version}/base.yaml` - Full ontology YAML files
- `semantic-layer/mappings/{datasourceId}/{version}/mappings.json` - Complete mapping definitions
- `semantic-layer/cache/snapshots/{datasourceId}/{cacheKey}.json` - Cache snapshots with full query + results
- `semantic-layer/history/queries/{YYYY-MM-DD}.jsonl` - Query history logs
- `semantic-layer/traces/{datasourceId}/{queryHash}/trace.json` - Reasoning traces

**PostgreSQL (Metadata & Fallback)**:
- `semantic_ontology` - Ontology metadata (version tracking, last loaded timestamp)
- `semantic_mappings` - Mapping metadata (datasource_id, version, last_updated, status)
- `semantic_column_mappings` - Column mapping details
- `semantic_cache` - Cache index with embeddings (for similarity search)
- `semantic_cache_config` - Cache TTL configuration

**Fallback Behavior**:
- If MinIO is not configured → All operations use PostgreSQL only
- If MinIO is configured but object not found → Falls back to PostgreSQL
- On initialization → Stores to both MinIO and PostgreSQL for redundancy

## Structure

```
packages/semantic-layer/
├── models/                    # YAML ontology files
│   └── default-ontology.yaml
├── src/
│   ├── cache/                # Semantic cache implementation
│   │   └── semantic-cache.ts
│   ├── cli/                  # CLI tools
│   │   └── migrate.ts        # Migration tool
│   ├── compiler/             # Semantic → SQL compiler
│   │   ├── intent-extractor.ts
│   │   ├── join-inference.ts
│   │   ├── plan-validator.ts  # NEW: Plan validation
│   │   ├── query-rewriter.ts
│   │   ├── semantic-compiler.ts
│   │   └── types.ts
│   ├── db/                   # Database client
│   │   └── client.ts
│   ├── explainability/       # NEW: Reasoning traces
│   │   └── trace-builder.ts
│   ├── history/              # NEW: Query history
│   │   └── query-logger.ts
│   ├── loader/               # YAML loader
│   │   └── yaml-loader.ts
│   ├── mapping/              # Mapping generation & resolution
│   │   ├── generator.ts
│   │   ├── resolver.ts
│   │   └── store.ts
│   ├── models/               # TypeScript types & Zod schemas
│   │   └── ontology.schema.ts
│   ├── ontology/              # Ontology loading
│   │   └── loader.ts
│   ├── post-processor/        # Result explanation & validation
│   │   └── explainer.ts
│   ├── schema/               # Database migrations
│   │   └── migrations/
│   │       └── 001_initial.sql
│   ├── storage/              # NEW: MinIO storage layer
│   │   ├── minio-client.ts
│   │   ├── ontology-storage.ts
│   │   └── mapping-storage.ts
│   └── initialization/       # Auto-initialization
│       └── auto-initialize.ts
```

## Complete Query Workflow

### Semantic Query Execution Flow

```mermaid
sequenceDiagram
    participant User
    participant Agent
    participant SemanticTool[runSemanticQuery Tool]
    participant MinIO
    participant Cache[Semantic Cache]
    participant IntentExtractor[Intent Extractor]
    participant PlanValidator[Plan Validator]
    participant Compiler[Semantic Compiler]
    participant MappingResolver[Mapping Resolver]
    participant QueryRewriter[Query Rewriter]
    participant RunQuery[runQuery Tool]
    participant Postgres
    participant PostProcessor[Post Processor]
    participant TraceBuilder[Trace Builder]
    participant HistoryLogger[History Logger]
    
    User->>Agent: Natural Language Query
    Agent->>SemanticTool: Execute semantic query
    
    SemanticTool->>Cache: Check cache (exact match)
    alt Cache Hit
        Cache-->>SemanticTool: Cached SQL + Result Summary
    else Cache Miss
        SemanticTool->>IntentExtractor: Extract semantic intent
        IntentExtractor->>MinIO: Load ontology (or Postgres fallback)
        MinIO-->>IntentExtractor: Ontology
        IntentExtractor-->>SemanticTool: Semantic Plan
        
        SemanticTool->>PlanValidator: Validate plan
        PlanValidator-->>SemanticTool: Validation Result
        
        SemanticTool->>Compiler: Compile semantic plan
        Compiler->>MappingResolver: Resolve concepts to tables
        MappingResolver->>MinIO: Load mappings (or Postgres fallback)
        MinIO-->>MappingResolver: Mappings
        MappingResolver-->>Compiler: Table mappings
        
        Compiler->>QueryRewriter: Rewrite plan to SQL
        QueryRewriter-->>Compiler: Compiled SQL
        Compiler-->>SemanticTool: Compiled Query
        
        SemanticTool->>Cache: Store in cache + MinIO snapshot
    end
    
    SemanticTool->>RunQuery: Execute SQL
    RunQuery->>Postgres: Execute query
    Postgres-->>RunQuery: Query Results
    RunQuery-->>SemanticTool: Results
    
    SemanticTool->>PostProcessor: Post-process results
    PostProcessor-->>SemanticTool: Explanation + Validation
    
    SemanticTool->>TraceBuilder: Build reasoning trace
    TraceBuilder->>MinIO: Store trace
    
    SemanticTool->>HistoryLogger: Log query
    HistoryLogger->>MinIO: Append to history log
    
    SemanticTool-->>Agent: Final Result + Semantic Info
    Agent-->>User: Summarized Answer
```

### Initialization Workflow

```mermaid
flowchart TB
    Start[Datasource Attached] --> CheckMinIO{MinIO<br/>Configured?}
    
    CheckMinIO -->|Yes| InitMinIO[Initialize MinIO Client]
    CheckMinIO -->|No| UsePostgres[Use PostgreSQL Only]
    
    InitMinIO --> CheckTables{Tables<br/>Exist?}
    UsePostgres --> CheckTables
    
    CheckTables -->|No| RunMigrations[Run Migrations]
    CheckTables -->|Yes| CheckOntology{Ontology<br/>Exists?}
    
    RunMigrations --> CheckOntology
    
    CheckOntology -->|No| LoadDefault[Load Default Ontology]
    CheckOntology -->|Yes| CheckMappings{Mappings<br/>Exist?}
    
    LoadDefault --> StoreMinIO[Store to MinIO]
    StoreMinIO --> StorePostgres[Store to Postgres]
    StorePostgres --> CheckMappings
    
    CheckMappings -->|No| GenerateMappings[Generate Mappings<br/>Claude/GPT]
    CheckMappings -->|Yes| Complete[Initialization Complete]
    
    GenerateMappings --> StoreMappingsMinIO[Store to MinIO]
    StoreMappingsMinIO --> StoreMappingsPostgres[Store to Postgres]
    StoreMappingsPostgres --> Complete
```

## Configuration

### Environment Variables

**Required for MinIO** (optional - falls back to PostgreSQL if not set):
```bash
MINIO_ENDPOINT=localhost:9000          # MinIO server endpoint
MINIO_ACCESS_KEY_ID=minioadmin         # MinIO access key
MINIO_SECRET_ACCESS_KEY=minioadmin     # MinIO secret key
MINIO_BUCKET=qwery-semantic-layer      # Bucket name (default)
MINIO_REGION=us-east-1                 # Region (optional)
MINIO_USE_SSL=false                    # Use SSL (default: true)
MINIO_PATH_STYLE=true                  # Path-style URLs (default: true)
```

**Required for LLM Operations**:
```bash
ANTHROPIC_API_KEY=your-key             # For mapping generation (Claude)
# OR
AZURE_API_KEY=your-key                 # For mapping generation (Azure)
AZURE_RESOURCE_NAME=your-resource      # Required with AZURE_API_KEY
```

**Required for Database**:
```bash
DATABASE_URL=postgresql://user:pass@localhost:5432/db
```

### Docker Compose Setup

The project includes MinIO in `docker-compose.yml`:

```yaml
services:
  minio:
    image: minio/minio:latest
    ports:
      - "9000:9000"  # API
      - "9001:9001"  # Console
    environment:
      - MINIO_ROOT_USER=minioadmin
      - MINIO_ROOT_PASSWORD=minioadmin
    volumes:
      - minio-data:/data
    command: server /data --console-address ":9001"
  
  server:
    environment:
      - MINIO_ENDPOINT=minio:9000
      - MINIO_ACCESS_KEY_ID=minioadmin
      - MINIO_SECRET_ACCESS_KEY=minioadmin
      - MINIO_BUCKET=qwery-semantic-layer
    depends_on:
      minio:
        condition: service_healthy
```

**Start with Docker**:
```bash
docker-compose up -d
```

Access MinIO Console at `http://localhost:9001` (login: `minioadmin`/`minioadmin`)

## Features

### 1. Dual-Storage Architecture

**MinIO (Primary)**:
- Stores full ontology YAML files
- Stores complete mapping JSON files
- Stores cache snapshots for cold cache recovery
- Stores query history logs
- Stores reasoning traces for explainability

**PostgreSQL (Metadata & Fallback)**:
- Stores ontology metadata (version tracking)
- Stores mapping metadata (queryable)
- Stores cache index with embeddings
- Provides fallback when MinIO unavailable

**Benefits**:
- Version control for ontology files
- Audit trail via query history
- Explainability via reasoning traces
- Performance via cache snapshots
- Reliability via dual storage

### 2. Semantic Cache

The semantic cache uses exact match (hash-based) with MinIO snapshots:

- **Cache Key**: SHA-256 hash of `{datasourceId, ontologyVersion, semanticPlan}`
- **TTL**: Configurable per datasource (default: 24 hours)
- **Storage**: 
  - PostgreSQL: Cache index with metadata
  - MinIO: Full snapshots (query + result summary)
- **Hit Tracking**: Increments hit count on cache hits
- **Automatic Cleanup**: Expired entries are cleaned up on access

**Usage**:

```typescript
import { getCachedQuery, storeCachedQuery } from '@qwery/semantic-layer/cache/semantic-cache';

// Check cache before compilation
const cached = await getCachedQuery(dbClient, {
  datasourceId: '...',
  ontologyVersion: '1.0.0',
  semanticPlan: extractedPlan,
});

if (cached) {
  // Use cached SQL
  const sql = cached.compiled_sql;
} else {
  // Compile and store (automatically stores to MinIO too)
  await storeCachedQuery(dbClient, key, compiledQuery, resultSummary);
}
```

**Configuration**:

```typescript
import { setCacheConfig } from '@qwery/semantic-layer/cache/semantic-cache';

// Set TTL for a datasource (in hours)
await setCacheConfig(dbClient, datasourceId, 48); // 48 hours
```

### 3. Query Plan Validation

Validates semantic plans before compilation:

- **Concept Validation**: Ensures all concepts exist in ontology
- **Property Validation**: Checks property references
- **Filter Validation**: Validates filter properties
- **Aggregation Validation**: Validates aggregation properties
- **Constraint Checking**: Prevents invalid SQL generation

**Usage**:

```typescript
import { validateSemanticPlan } from '@qwery/semantic-layer/compiler/plan-validator';

const validation = await validateSemanticPlan(
  semanticPlan,
  ontology,
  metadata
);

if (!validation.valid) {
  throw new Error(`Validation failed: ${validation.errors.join('; ')}`);
}
```

### 4. Query History Logging

Logs all semantic queries to MinIO for audit and analysis:

- **Format**: JSONL (one query per line)
- **Storage**: `semantic-layer/history/queries/{YYYY-MM-DD}.jsonl`
- **Content**: Query, semantic plan, compiled SQL, execution time, results summary

**Usage**:

```typescript
import { getQueryHistoryLogger } from '@qwery/semantic-layer/history/query-logger';

const logger = getQueryHistoryLogger();
if (logger) {
  await logger.logQuery({
    query: "Show me top customers",
    datasourceId: "...",
    ontologyVersion: "1.0.0",
    semanticPlan: plan,
    compiledSQL: sql,
    timestamp: new Date().toISOString(),
    executionTimeMs: 150,
    resultRowCount: 10,
  });
}
```

### 5. Reasoning Traces

Stores detailed reasoning traces for explainability:

- **Join Inferences**: Why joins were inferred
- **Measure Selections**: Why aggregations were chosen
- **Mapping Selections**: How terms were mapped to concepts/properties
- **Step-by-Step**: Complete compilation steps

**Usage**:

```typescript
import { getReasoningTraceBuilder } from '@qwery/semantic-layer/explainability/trace-builder';

const traceBuilder = getReasoningTraceBuilder();
if (traceBuilder) {
  traceBuilder.initialize(query, datasourceId, ontologyVersion, semanticPlan);
  traceBuilder.addJoinInference("customers", "orders", "Foreign key relationship", 0.95);
  traceBuilder.addMeasureSelection("total", "sum", "Aggregate order totals");
  await traceBuilder.save(); // Stores to MinIO
}
```

### 6. Post-Processing

Post-processing provides result explanation and validation:

- **Explanation Generation**: Uses GPT-5.2 to generate user-friendly summaries
- **Result Validation**: Validates results match semantic intent
- **Related Queries**: Suggests follow-up queries
- **Insights**: Extracts key insights from the data

**Usage**:

```typescript
import {
  explainQueryResult,
  validateResultAgainstIntent,
} from '@qwery/semantic-layer/post-processor/explainer';

const explanation = await explainQueryResult(
  query,
  semanticPlan,
  { columns, rows },
  gptLanguageModel,
);

const validation = await validateResultAgainstIntent(
  query,
  semanticPlan,
  { columns, rows },
  gptLanguageModel,
);
```

**Output Structure**:

```typescript
{
  summary: "Brief summary of results",
  insights: ["insight 1", "insight 2"],
  relatedQueries: ["query 1", "query 2"],
  validation: {
    matchesIntent: true,
    issues: []
  }
}
```

### 7. Error Handling

The semantic layer includes comprehensive error handling:

- **Cache Failures**: Gracefully falls back to compilation if cache lookup fails
- **Compilation Errors**: Provides detailed error messages
- **Query Execution Errors**: Invalidates stale cache entries and retries
- **Post-Processing Errors**: Continues execution even if explanation fails
- **Connection Errors**: Properly closes database connections
- **MinIO Failures**: Falls back to PostgreSQL storage

**Error Recovery**:

1. If cached query execution fails, the cache entry is invalidated and compilation is retried
2. If post-processing fails, the query result is still returned without explanation
3. If MinIO is unavailable, all operations fall back to PostgreSQL
4. All errors are logged with context for debugging

## Usage

### Migration

Run migrations and load ontology:

```bash
pnpm semantic:migrate --connection-url postgresql://user:pass@localhost:5432/db
```

Options:
- `--connection-url <url>`: PostgreSQL connection URL (or set `DATABASE_URL` env var)
- `--ontology <path>`: Path to ontology YAML file (default: `models/default-ontology.yaml`)
- `--version <version>`: Ontology version (default: `1.0.0`)

### Loading Ontology

**From MinIO** (automatic if configured):
```typescript
import { loadOntology } from '@qwery/semantic-layer/ontology/loader';

const ontology = await loadOntology(dbClient, '1.0.0');
// Automatically tries MinIO first, falls back to Postgres
```

**From YAML File**:
```typescript
import { loadOntologyFromYAML } from '@qwery/semantic-layer/loader';

const ontology = loadOntologyFromYAML('./models/default-ontology.yaml');
```

**Storing to MinIO**:
```typescript
import { getOntologyStorage } from '@qwery/semantic-layer/storage/ontology-storage';

const storage = getOntologyStorage();
if (storage) {
  await storage.storeOntology('1.0.0', ontology);
}
```

### Validating Ontology

```typescript
import { validateOntology } from '@qwery/semantic-layer/loader';

const ontology = validateOntology(parsedYAML);
```

## Ontology YAML Structure

```yaml
ontology:
  concepts:
    - id: Customer
      label: Customer
      description: A customer entity
      properties:
        - id: name
          label: Name
          type: string
          description: Customer name
      relationships:
        - target: Order
          type: has_many
          label: Orders
          description: Orders placed by customer
  inheritance:
    - base: Person
      extends: [Customer, Employee]
```

## Query Flow Example

**User Query**: "Show me top customers by revenue"

**Step-by-Step**:

1. **Intent Extraction** → `{ concepts: ["Customer", "Order"], aggregations: [{ property: "total", function: "sum" }], ... }`
2. **Cache Lookup** → Miss (first time)
3. **Plan Validation** → Valid (concepts exist, properties valid)
4. **Compilation** → 
   - Resolve "Customer" → `customers` table
   - Resolve "Order" → `orders` table
   - Infer join: `customers.id = orders.customer_id`
   - Generate: `SELECT customers.name, SUM(orders.total) AS revenue FROM customers JOIN orders ... GROUP BY customers.name ORDER BY revenue DESC LIMIT 10`
5. **Execution** → Returns results
6. **Post-Processing** → "Top 10 customers by total order revenue"
7. **Cache Storage** → Store to PostgreSQL + MinIO snapshot
8. **Trace Storage** → Store reasoning trace to MinIO
9. **History Logging** → Append to query history log

## Performance

- **Cache Hit Rate**: Expected >30% for repeated queries
- **Cache Overhead**: <5ms for cache lookup
- **Post-Processing**: ~200-500ms for explanation generation
- **MinIO Operations**: <50ms for object retrieval
- **Total Overhead**: <200ms vs direct SQL (when cache hits)

## Development

```bash
# Type check
pnpm --filter @qwery/semantic-layer typecheck

# Lint
pnpm --filter @qwery/semantic-layer lint

# Test
pnpm --filter @qwery/semantic-layer test
```

## Examples

### Using the Semantic Query Tool

```typescript
// The runSemanticQuery tool automatically handles:
// - Cache lookup
// - Compilation
// - Execution
// - Post-processing
// - Error handling
// - Trace building
// - History logging

const result = await RunSemanticQueryTool.execute({
  query: "Show me top customers by revenue",
  datasourceId: "...",
  ontologyVersion: "1.0.0",
  exportFilename: "top-customers-by-revenue",
}, context);

// Result includes:
// - result.result: Query results (columns, rows)
// - result.semantic.plan: Semantic plan
// - result.semantic.compiled_sql: Generated SQL
// - result.semantic.cached: Whether cache was used
// - result.semantic.explanation: Post-processing explanation
// - result.semantic.validation: Result validation
```

### Manual Cache Management

```typescript
import {
  getCachedQuery,
  storeCachedQuery,
  invalidateCache,
  cleanupExpiredCache,
} from '@qwery/semantic-layer/cache/semantic-cache';

// Invalidate all cache for a datasource
await invalidateCache(dbClient, datasourceId);

// Clean up expired entries
const deletedCount = await cleanupExpiredCache(dbClient);
```

### Accessing MinIO Storage Directly

```typescript
import { getMinIOClient } from '@qwery/semantic-layer/storage/minio-client';

const client = getMinIOClient();
if (client) {
  // Load ontology from MinIO
  const ontology = await client.getObject('ontology/1.0.0/base.yaml');
  
  // List all mappings for a datasource
  const mappings = await client.listObjects(`mappings/${datasourceId}/`);
  
  // Get query history
  const history = await client.getObject('history/queries/2024-01-15.jsonl');
}
```

## Troubleshooting

### MinIO Not Connecting

1. Check environment variables are set correctly
2. Verify MinIO is running: `docker ps | grep minio`
3. Check MinIO logs: `docker-compose logs minio`
4. Verify network connectivity (use `minio:9000` in Docker, `localhost:9000` locally)

### Fallback to PostgreSQL

If MinIO is not configured or unavailable, the system automatically falls back to PostgreSQL storage. Check logs for:
```
[SemanticLayerInit] MinIO not configured, using Postgres storage
```

### Cache Not Working

1. Verify cache tables exist in PostgreSQL
2. Check cache TTL configuration
3. Verify MinIO snapshots are being stored (if MinIO configured)
4. Check cache logs for errors

### Ontology Not Loading

1. Verify ontology exists in MinIO: `semantic-layer/ontology/{version}/base.yaml`
2. Check PostgreSQL fallback: `SELECT * FROM semantic_ontology WHERE version = '1.0.0'`
3. Run migrations: `pnpm semantic:migrate`
4. Check initialization logs
