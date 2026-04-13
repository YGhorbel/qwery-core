import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { Repositories } from '@qwery/domain/repositories';
import { dataAgentService } from '@qwery/semantic-layer/data-agent';
import { handleDomainException } from '../lib/http-utils';

export function createDataChatsRoutes(
  getRepositories: () => Promise<Repositories>,
) {
  const app = new Hono();

  // POST /api/datasources/:id/query — run the data agent for a natural language question
  app.post('/:id/query', async (c) => {
    const datasourceId = c.req.param('id');

    let body: {
      question: string;
      conversationContext?: string;
      clarificationRound?: number;
    };
    try {
      body = await c.req.json<typeof body>();
    } catch {
      return c.json(
        { error: 'Request body must be JSON with a "question" field' },
        400,
      );
    }

    if (!body.question?.trim()) {
      return c.json({ error: '"question" is required' }, 400);
    }

    try {
      const repos = await getRepositories();

      return streamSSE(c, async (stream) => {
        try {
          await dataAgentService.executeAgent(
            {
              datasourceId,
              userQuestion: body.question,
              conversationContext: body.conversationContext,
              clarificationRound: body.clarificationRound,
              onEvent: (event) => {
                stream
                  .writeSSE({ data: JSON.stringify(event) })
                  .catch(() => {});
              },
            },
            repos.datasource,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await stream.writeSSE({
            data: JSON.stringify({ type: 'message_error', message }),
          });
        }
      });
    } catch (error) {
      return handleDomainException(error);
    }
  });

  return app;
}
