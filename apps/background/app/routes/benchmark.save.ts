import type { ActionFunctionArgs } from 'react-router';
import { saveRun } from '~/lib/benchmark.server';
import type { BenchmarkRun } from '~/lib/benchmark.server';

export async function action({ request }: ActionFunctionArgs) {
  const run = (await request.json()) as BenchmarkRun;
  await saveRun(run);
  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
