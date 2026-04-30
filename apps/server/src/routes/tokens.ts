import { Hono } from 'hono';
import { TokenStore } from '@qwery/vector-store';

let _store: TokenStore | null = null;
function getStore(): TokenStore | null {
  const url = process.env.QWERY_INTERNAL_DATABASE_URL;
  if (!url) return null;
  if (!_store) _store = new TokenStore(url);
  return _store;
}

export function createTokenRoutes() {
  const app = new Hono();

  app.get('/stats', async (c) => {
    const ts = getStore();
    const empty = {
      daily: [],
      models: [],
      totals: { totalInput: 0, totalOutput: 0, totalReasoning: 0, sessionCount: 0 },
    };
    if (!ts) return c.json(empty);
    try {
      await ts.ensureSchema();
      const [daily, models, totals] = await Promise.all([
        ts.getDailyStats(30),
        ts.getModelStats(),
        ts.getTotals(),
      ]);
      return c.json({ daily, models, totals });
    } catch {
      return c.json(empty);
    }
  });

  return app;
}
