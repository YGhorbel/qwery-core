import type { LoaderFunctionArgs } from 'react-router';

const serverUrl = () => process.env.QWERY_SERVER_URL ?? 'http://localhost:4096';

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const slug = url.searchParams.get('slug');
  if (!slug) return new Response('Missing slug', { status: 400 });

  try {
    const res = await fetch(
      `${serverUrl()}/api/messages?conversationSlug=${encodeURIComponent(slug)}`,
    );
    const body = await res.text();
    return new Response(body, {
      status: res.status,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 502,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
