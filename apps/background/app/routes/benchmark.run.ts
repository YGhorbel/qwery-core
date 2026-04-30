import type { ActionFunctionArgs } from 'react-router';

export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const file = formData.get('questions') as File | null;
  if (!file) return new Response('Missing questions file', { status: 400 });

  const text = await file.text();
  let questions: unknown[];
  try {
    questions = JSON.parse(text) as unknown[];
  } catch {
    return new Response('Invalid JSON in questions file', { status: 400 });
  }

  const datasourceMapRaw = (formData.get('datasource_map') as string) || '{}';
  const workers = parseInt((formData.get('workers') as string) || '5', 10);
  const model = (formData.get('model') as string) || undefined;

  let datasourceMap: Record<string, string>;
  try {
    datasourceMap = JSON.parse(datasourceMapRaw) as Record<string, string>;
  } catch {
    datasourceMap = {};
  }

  const serverUrl =
    process.env.QWERY_SERVER_URL ?? 'http://localhost:4096';

  let upstream: Response;
  try {
    upstream = await fetch(`${serverUrl}/api/benchmark`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        questions,
        datasource_map: datasourceMap,
        workers,
        metrics: ['ex', 'f1'],
        ...(model ? { model } : {}),
      }),
    });
  } catch (err) {
    return new Response(
      `Could not reach qwery server at ${serverUrl}: ${String(err)}`,
      { status: 502 },
    );
  }

  if (!upstream.ok || !upstream.body) {
    const body = await upstream.text();
    return new Response(`Upstream error ${upstream.status}: ${body}`, {
      status: 502,
    });
  }

  // Pass through the SSE stream unchanged — the client handles saving.
  return new Response(upstream.body, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
