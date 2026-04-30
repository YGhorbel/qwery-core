import { type RouteConfig, index, route } from '@react-router/dev/routes';

export default [
  route('/', './routes/_layout.tsx', [
    index('./routes/index.tsx'),
    route('datasources/:id', './routes/datasources.$id.tsx'),
    route('datasources/:id/traces', './routes/datasources.$id.traces.tsx'),
    route('benchmark', './routes/benchmark.tsx'),
    route('benchmark/:runId', './routes/benchmark.$runId.tsx'),
    route('tokens', './routes/tokens.tsx'),
  ]),
  route('benchmark/run', './routes/benchmark.run.ts'),
  route('benchmark/save', './routes/benchmark.save.ts'),
  route('api/trace', './routes/api.trace.ts'),
] satisfies RouteConfig;
