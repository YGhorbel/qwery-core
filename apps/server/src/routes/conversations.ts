import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import { z } from 'zod';
import {
  CreateConversationService,
  DeleteConversationService,
  GetConversationBySlugService,
  GetConversationService,
  GetConversationsByProjectIdService,
  UpdateConversationService,
} from '@qwery/domain/services';
import type { Repositories } from '@qwery/domain/repositories';
import { createRepositories } from '../lib/repositories';
import { handleDomainException, isUUID } from '../lib/http-utils';

const TUI_PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000';
const TUI_TASK_ID = '550e8400-e29b-41d4-a716-446655440001';

const createBodySchema = z.object({
  title: z.string().optional().default('New Conversation'),
  seedMessage: z.string().optional().default(''),
  projectId: z.uuid().optional(),
  taskId: z.uuid().optional(),
  datasources: z.array(z.string()).optional().default([]),
  createdBy: z.uuid().optional().default('tui'),
});

let repositoriesPromise: Promise<Repositories> | undefined;

async function getRepositories(): Promise<Repositories> {
  if (!repositoriesPromise) {
    repositoriesPromise = createRepositories();
  }
  return repositoriesPromise;
}

export function createConversationsRoutes() {
  const app = new Hono();

  app.get('/', async (c) => {
    try {
      const repos = await getRepositories();
      const conversations = await repos.conversation.findAll();
      return c.json(conversations);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  app.post('/', zValidator('json', createBodySchema), async (c) => {
    try {
      // #region agent log
      const rawBody = await c.req.json().catch(() => ({}));
      fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'conversations.ts:50','message':'POST /conversations - raw request body',data:{rawBody},timestamp:Date.now(),runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      const body = c.req.valid('json');
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'conversations.ts:52','message':'POST /conversations - validated body',data:{body,createdBy:body.createdBy,createdByType:typeof body.createdBy},timestamp:Date.now(),runId:'run1',hypothesisId:'B'})}).catch(()=>{});
      // #endregion
      const repositories = await getRepositories();

      const input = {
        title: body.title,
        seedMessage: body.seedMessage,
        projectId: body.projectId ?? TUI_PROJECT_ID,
        taskId: body.taskId ?? TUI_TASK_ID,
        datasources: body.datasources ?? [],
        createdBy: body.createdBy ?? 'tui',
      };
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'conversations.ts:62','message':'POST /conversations - service input',data:{input,createdBy:input.createdBy,createdByType:typeof input.createdBy},timestamp:Date.now(),runId:'run1',hypothesisId:'A,C,D'})}).catch(()=>{});
      // #endregion
      const useCase = new CreateConversationService(repositories.conversation);
      const conversation = await useCase.execute(input);

      return c.json(conversation, 201);
    } catch (error) {
      // #region agent log
      fetch('http://127.0.0.1:7246/ingest/eeeb0834-4ce3-4f73-8dd1-0acde8263000',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'conversations.ts:67','message':'POST /conversations - error caught',data:{error:error instanceof Error?error.message:String(error),errorStack:error instanceof Error?error.stack:undefined},timestamp:Date.now(),runId:'run1',hypothesisId:'A,B,C,D,E'})}).catch(()=>{});
      // #endregion
      return handleDomainException(error);
    }
  });

  app.get('/project/:projectId', async (c) => {
    try {
      const projectId = c.req.param('projectId');
      if (!projectId) {
        return c.json({ error: 'Project ID is required' }, 400);
      }

      const repos = await getRepositories();
      const useCase = new GetConversationsByProjectIdService(
        repos.conversation,
      );
      const conversations = await useCase.execute(projectId);
      return c.json(conversations);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  app.get('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      if (!id) return c.json({ error: 'Not found' }, 404);

      const repos = await getRepositories();
      const useCase = isUUID(id)
        ? new GetConversationService(repos.conversation)
        : new GetConversationBySlugService(repos.conversation);
      const conversation = await useCase.execute(id);
      return c.json(conversation);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  app.put('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      if (!id) return c.json({ error: 'Method not allowed' }, 405);

      const repos = await getRepositories();
      const body = await c.req.json();
      const useCase = new UpdateConversationService(repos.conversation);
      const conversation = await useCase.execute({
        ...body,
        id,
        updatedBy: (body as { updatedBy?: string }).updatedBy ?? 'tui',
      });
      return c.json(conversation);
    } catch (error) {
      return handleDomainException(error);
    }
  });

  app.delete('/:id', async (c) => {
    try {
      const id = c.req.param('id');
      if (!id) return c.json({ error: 'Method not allowed' }, 405);

      const repos = await getRepositories();
      const useCase = new DeleteConversationService(repos.conversation);
      await useCase.execute(id);
      return c.json({ success: true });
    } catch (error) {
      return handleDomainException(error);
    }
  });

  return app;
}
