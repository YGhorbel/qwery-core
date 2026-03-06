# Semantic Layer MinIO-First Deployment Runbook

## Overview

This runbook provides step-by-step instructions for deploying the MinIO-first semantic layer architecture, which removes PostgreSQL dependency for semantic metadata storage.

## Pre-Deployment Checklist

- [ ] MinIO is running and accessible
- [ ] Redis is running and accessible
- [ ] NATS is running and accessible
- [ ] Environment variables are configured (see Configuration section)
- [ ] Backup of existing semantic metadata (if any) has been taken
- [ ] All services are healthy

## Configuration

### Required Environment Variables

```bash
# MinIO Configuration
MINIO_ENDPOINT=minio:9000
MINIO_ACCESS_KEY_ID=minioadmin
MINIO_SECRET_ACCESS_KEY=minioadmin
MINIO_BUCKET=qwery-semantic-layer
MINIO_REGION=us-east-1
MINIO_USE_SSL=false
MINIO_PATH_STYLE=true

# Redis Configuration
REDIS_URL=redis://redis:6379

# NATS Configuration
NATS_URL=nats://nats:4222
SEMANTIC_EVENTS_TOPIC=semantic-events

# Semantic Layer Configuration
MINIO_ONLY=true
LINK_PREDICTION_CONFIDENCE_THRESHOLD=0.6
LINK_PREDICTION_RATE_LIMIT=1000
```

### Optional Environment Variables

- `SEMANTIC_MANIFEST_PATH` - Custom manifest path (default: `ontology/{datasourceId}/latest.json`)

## Deployment Steps

### 1. Start Infrastructure Services

```bash
docker-compose up -d redis nats minio
```

Verify services are healthy:

```bash
docker-compose ps
```

### 2. Verify MinIO Access

```bash
# Check MinIO is accessible
curl http://localhost:9000/minio/health/live
```

Access MinIO Console at `http://localhost:9001` to verify bucket exists.

### 3. Verify Redis Access

```bash
# Test Redis connection
redis-cli -u redis://localhost:6379 ping
```

Should return `PONG`.

### 4. Verify NATS Access

```bash
# Test NATS connection
nats server check
```

### 5. Update Application Configuration

Ensure all environment variables are set in your application configuration (e.g., `.env` file or deployment config).

### 6. Deploy Application

```bash
# Restart application services
docker-compose restart server
```

Or if deploying to production:

```bash
# Deploy new version with updated configuration
# (follow your standard deployment process)
```

### 7. Verify Deployment

Check application logs for successful initialization:

```bash
docker-compose logs server | grep SemanticLayerInit
```

Expected log messages:
- `[SemanticLayerInit] MinIO client and store initialized from environment`
- `[SemanticLayerInit] Redis index initialized`
- `[SemanticLayerInit] NATS publisher initialized`

### 8. Test Semantic Operations

1. Upload an ontology to MinIO:
   ```bash
   # Upload to incoming/{datasourceId}/ontology/test.yaml
   # The event listener will process it automatically
   ```

2. Verify ontology is stored:
   ```bash
   # Check MinIO bucket for ontology/{datasourceId}/v{version}/base.yaml
   ```

3. Test cache operations:
   ```bash
   # Run a semantic query and verify cache is working
   ```

## Monitoring Checklist (24-48 hours post-deployment)

### Hour 1-6

- [ ] Monitor application logs for errors
- [ ] Check Redis memory usage
- [ ] Verify MinIO bucket size
- [ ] Monitor NATS message throughput
- [ ] Check cache hit rates
- [ ] Verify ontology/mapping loads are successful

### Hour 6-24

- [ ] Review error logs for patterns
- [ ] Check cache performance metrics
- [ ] Verify event processing latency
- [ ] Monitor Redis connection stability
- [ ] Check MinIO storage growth

### Hour 24-48

- [ ] Review overall system performance
- [ ] Verify no data loss occurred
- [ ] Check all semantic queries are working
- [ ] Review cache hit rates (target: ≥70%)
- [ ] Verify cache hot-path latency (target: ≤50ms)

## Rollback Procedure

If issues are detected, rollback to previous version:

### Option 1: Feature Flag Rollback

Set environment variable:

```bash
MINIO_ONLY=false
```

**Note**: This requires the old code that supports PostgreSQL fallback. If you've already removed PostgreSQL code, use Option 2.

### Option 2: Code Rollback

1. Revert to previous git commit:
   ```bash
   git revert <commit-hash>
   ```

2. Rebuild and redeploy:
   ```bash
   docker-compose build server
   docker-compose up -d server
   ```

3. Verify rollback:
   ```bash
   docker-compose logs server | grep SemanticLayerInit
   ```

## Troubleshooting

### MinIO Connection Issues

- Verify `MINIO_ENDPOINT` is correct
- Check MinIO service is running: `docker-compose ps minio`
- Verify credentials: `MINIO_ACCESS_KEY_ID` and `MINIO_SECRET_ACCESS_KEY`
- Check network connectivity between services

### Redis Connection Issues

- Verify `REDIS_URL` is correct
- Check Redis service is running: `docker-compose ps redis`
- Test connection: `redis-cli -u $REDIS_URL ping`
- Check Redis memory limits

### NATS Connection Issues

- Verify `NATS_URL` is correct
- Check NATS service is running: `docker-compose ps nats`
- Verify NATS is accessible from application

### Cache Performance Issues

- Check Redis memory usage
- Verify cache TTL configuration
- Review cache hit rates in logs
- Check for cache key collisions

### Event Processing Issues

- Verify MinIO bucket notifications are configured
- Check NATS message queue for backlog
- Review event listener logs
- Verify event handler is registered

## Post-Deployment Validation

Run validation checks:

```bash
# Run benchmarks
pnpm --filter @qwery/semantic-layer benchmark

# Run tests
pnpm --filter @qwery/semantic-layer test

# Check type safety
pnpm --filter @qwery/semantic-layer typecheck
```

## Success Criteria

- [ ] All semantic queries execute successfully
- [ ] Cache hit rate ≥ 70%
- [ ] Cache hot-path latency ≤ 50ms (p95)
- [ ] No errors in application logs
- [ ] Ontology/mapping uploads are processed automatically
- [ ] Events are published to NATS successfully
- [ ] Redis index is populated correctly
- [ ] MinIO storage is growing as expected

## Support

For issues or questions:
1. Check application logs
2. Review MinIO/Redis/NATS service logs
3. Verify environment variables
4. Check network connectivity between services
