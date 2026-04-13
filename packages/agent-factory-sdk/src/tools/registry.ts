import { tool, jsonSchema } from 'ai';
import { z } from 'zod';
import type { Tool } from 'ai';
import type {
  ToolInfo,
  ToolContext,
  Model,
  ToolExecute,
  ToolResult,
} from './tool';
import type { AgentInfoWithId } from '../agents/agent';
import { AskAgent, QueryAgent, CompactionAgent, SummaryAgent } from '../agents';
import { TodoWriteTool, TodoReadTool } from './todo';
import { WebFetchTool } from './webfetch';
import { GetSchemaTool } from './get-schema';
import { RunQueryTool } from './run-query';
import { RunQueriesTool } from './run-queries';
import { SelectChartTypeTool } from './select-chart-type-tool';
import { GenerateChartTool } from './generate-chart-tool';
import { GetSkillTool } from './get-skill';
import { TaskTool } from './task';
import { SearchOntologyTool } from './search-ontology.tool';
import { GetRelationshipsTool } from './get-relationships.tool';
import { getLogger } from '@qwery/shared/logger';
import { getMcpTools } from '../mcp/client.js';
import { GetTodoByConversationService } from '@qwery/domain/services';
import type { Repositories } from '@qwery/domain/repositories';

const TASK_COMPLETING_TOOL_IDS = new Set([
  'runQuery',
  'runQueries',
  'getSchema',
  'generateChart',
  'selectChartType',
]);

const TODO_REMINDER =
  '\n\n<system-reminder>You completed a task. Call todowrite to set that todo to completed and continue with the next one.</system-reminder>';

const todowriteInputSchema = jsonSchema<{
  todos: Array<{
    id: string;
    content: string;
    status: string;
    priority: string;
  }>;
}>({
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      description: 'The updated todo list',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          content: { type: 'string' },
          status: {
            type: 'string',
            enum: ['pending', 'in_progress', 'completed', 'cancelled'],
          },
          priority: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'content', 'status', 'priority'],
      },
    },
  },
  required: ['todos'],
});

const tools = new Map<string, ToolInfo>();
const agents = new Map<string, AgentInfoWithId>();

function registerTools() {
  tools.set(TodoWriteTool.id, TodoWriteTool as unknown as ToolInfo);
  tools.set(TodoReadTool.id, TodoReadTool as unknown as ToolInfo);
  tools.set(WebFetchTool.id, WebFetchTool as unknown as ToolInfo);
  //tools.set(TestConnectionTool.id, TestConnectionTool as unknown as ToolInfo);
  tools.set(GetSchemaTool.id, GetSchemaTool as unknown as ToolInfo);
  tools.set(RunQueryTool.id, RunQueryTool as unknown as ToolInfo);
  tools.set(RunQueriesTool.id, RunQueriesTool as unknown as ToolInfo);
  tools.set(SelectChartTypeTool.id, SelectChartTypeTool as unknown as ToolInfo);
  tools.set(GenerateChartTool.id, GenerateChartTool as unknown as ToolInfo);
  tools.set(GetSkillTool.id, GetSkillTool as unknown as ToolInfo);
  tools.set(TaskTool.id, TaskTool as unknown as ToolInfo);
  tools.set(SearchOntologyTool.id, SearchOntologyTool as unknown as ToolInfo);
  tools.set(
    GetRelationshipsTool.id,
    GetRelationshipsTool as unknown as ToolInfo,
  );
}

function registerAgents() {
  agents.set(AskAgent.id, AskAgent);
  agents.set(QueryAgent.id, QueryAgent);
  agents.set(CompactionAgent.id, CompactionAgent);
  agents.set(SummaryAgent.id, SummaryAgent);
}

registerTools();
registerAgents();

export type GetContextOptions = {
  toolCallId?: string;
  abortSignal?: AbortSignal;
};

export type ForAgentOptions = {
  mcpServerUrl?: string;
  mcpNamePrefix?: string;
  webSearch?: boolean;
};

export type ForAgentResult = {
  tools: Record<string, Tool>;
  close?: () => Promise<void>;
};

// ── Tool Resolution ─────────────────────────────────────────────────

type ResolvedTool = {
  id: string;
  description: string;
  parameters: z.ZodType;
  execute: ToolExecute<z.ZodType>;
};

async function resolveTool(
  info: ToolInfo,
  initCtx?: { agent?: { id: string } },
): Promise<ResolvedTool> {
  if ('init' in info && typeof info.init === 'function') {
    const result = await info.init(initCtx);
    return { id: info.id, ...result };
  }
  const syncInfo = info as ToolInfo & {
    description: string;
    parameters: z.ZodType;
    execute: ToolExecute<z.ZodType>;
  };
  return {
    id: syncInfo.id,
    description: syncInfo.description,
    parameters: syncInfo.parameters,
    execute: syncInfo.execute,
  };
}

// ── Tool Filtering ──────────────────────────────────────────────────

function whenModelMatches(info: ToolInfo, model: Model): boolean {
  const predicate = 'whenModel' in info ? info.whenModel : undefined;
  if (!predicate) return true;
  return predicate(model);
}

function filterToolsForAgent(agent: AgentInfoWithId, model: Model): ToolInfo[] {
  const allTools = Array.from(tools.values());
  const options = agent.options ?? {};
  const toolsMap = options.tools as Record<string, boolean> | undefined;
  const toolIds = options.toolIds as string[] | undefined;
  const toolDenylist = options.toolDenylist as string[] | undefined;

  let allowlist: string[] | undefined;
  if (toolsMap && toolsMap['*'] === false) {
    allowlist = Object.entries(toolsMap)
      .filter(([k, v]) => k !== '*' && v === true)
      .map(([k]) => k);
  } else if (toolIds?.length) {
    allowlist = toolIds;
  }

  let byAgent =
    allowlist != null
      ? allTools.filter((t) => allowlist!.includes(t.id))
      : allTools;
  if (toolDenylist?.length) {
    byAgent = byAgent.filter((t) => !toolDenylist.includes(t.id));
  }
  return byAgent.filter((t) => whenModelMatches(t, model));
}

// ── Execution Tracking ──────────────────────────────────────────────

function trackExecution(
  resolved: ResolvedTool,
  args: unknown,
  context: ToolContext,
  toolCallId: string,
  executeFn: () => Promise<ToolResult>,
): Promise<ToolResult> {
  context.onToolStart?.(resolved.id, args, toolCallId);
  const startedAt = performance.now();
  let isError = false;

  return executeFn()
    .catch((error) => {
      isError = true;
      throw error;
    })
    .finally(() => {
      const executionTimeMs = Number(
        (performance.now() - startedAt).toFixed(2),
      );
      context.onToolComplete?.(resolved.id, toolCallId, {
        executionTimeMs,
        isError,
      });
    });
}

// ── Output Post-Processing ──────────────────────────────────────────

function extractOutputString(raw: ToolResult): {
  text: string | null;
  isWrapped: boolean;
} {
  if (typeof raw === 'string') {
    return { text: raw, isWrapped: false };
  }
  if (
    typeof raw === 'object' &&
    raw !== null &&
    'output' in raw &&
    Object.keys(raw).length === 1
  ) {
    return { text: (raw as { output: string }).output, isWrapped: true };
  }
  return { text: null, isWrapped: false };
}

async function truncateIfNeeded(text: string): Promise<string> {
  try {
    const { truncateOutput } = await import('./truncation');
    const truncated = await truncateOutput(text);
    if (truncated.truncated) {
      return truncated.content;
    }
  } catch {
    // truncation not available; fall through
  }
  return text;
}

async function appendTodoReminderIfNeeded(
  text: string,
  toolId: string,
  context: ToolContext,
): Promise<string> {
  if (
    !TASK_COMPLETING_TOOL_IDS.has(toolId) ||
    !context.extra?.repositories ||
    !context.conversationId
  ) {
    return text;
  }
  const repos = context.extra.repositories as Repositories;
  const todoService = new GetTodoByConversationService(
    repos.todo,
    repos.conversation,
  );
  const todos = await todoService.execute({
    conversationId: context.conversationId,
  });
  if (todos.some((t) => t.status === 'in_progress')) {
    return text + TODO_REMINDER;
  }
  return text;
}

async function postProcessOutput(
  raw: ToolResult,
  toolId: string,
  context: ToolContext,
): Promise<ToolResult> {
  const { text, isWrapped } = extractOutputString(raw);
  if (text === null) {
    return raw as Record<string, unknown>;
  }

  let finalStr = await truncateIfNeeded(text);
  finalStr = await appendTodoReminderIfNeeded(finalStr, toolId, context);
  return isWrapped ? { output: finalStr } : finalStr;
}

// ── AI SDK Tool Builder ─────────────────────────────────────────────

function buildAiTool(
  resolved: ResolvedTool,
  getContext: (options: GetContextOptions) => ToolContext,
): Tool {
  const inputSchema =
    resolved.id === 'todowrite' ? todowriteInputSchema : resolved.parameters;

  return tool({
    description: resolved.description,
    inputSchema,
    execute: async (args, options) => {
      resolved.parameters.parse(args);
      const context = getContext({
        toolCallId: options.toolCallId,
        abortSignal: options.abortSignal,
      });
      const toolCallId = options.toolCallId ?? '';

      const raw = await trackExecution(
        resolved,
        args,
        context,
        toolCallId,
        () => resolved.execute(args, context),
      );

      return postProcessOutput(raw, resolved.id, context);
    },
  });
}

// ── MCP Integration ─────────────────────────────────────────────────

async function mergeMcpTools(
  result: Record<string, Tool>,
  forAgentOptions?: ForAgentOptions,
): Promise<ForAgentResult> {
  const mcpServerUrl = forAgentOptions?.mcpServerUrl;
  if (!mcpServerUrl) {
    return { tools: result };
  }

  try {
    const { tools: mcpTools, close } = await getMcpTools(mcpServerUrl, {
      namePrefix: forAgentOptions?.mcpNamePrefix,
    });
    return {
      tools: { ...result, ...mcpTools },
      close,
    };
  } catch (mcpError) {
    const logger = await getLogger();
    logger.warn(
      {
        err: mcpError,
        mcpServerUrl,
        message:
          mcpError instanceof Error ? mcpError.message : String(mcpError),
      },
      'MCP server unavailable, continuing without MCP tools',
    );
    return { tools: result };
  }
}

// ── Public Registry ─────────────────────────────────────────────────

export const Registry = {
  tools: {
    register(t: ToolInfo) {
      tools.set(t.id, t);
    },
    list(): ToolInfo[] {
      return Array.from(tools.values());
    },
    get(id: string): ToolInfo | undefined {
      return tools.get(id);
    },
    async forAgent(
      agentId: string,
      model: Model,
      getContext: (options: GetContextOptions) => ToolContext,
      forAgentOptions?: ForAgentOptions,
    ): Promise<ForAgentResult> {
      const agent = agents.get(agentId);
      if (!agent) {
        throw new Error(`Agent not found: ${agentId}`);
      }

      let filtered = filterToolsForAgent(agent, model);
      if (forAgentOptions?.webSearch === false) {
        filtered = filtered.filter((t) => t.id !== 'webfetch');
      }
      const initCtx = { agent: { id: agentId } };

      const result: Record<string, Tool> = {};
      for (const info of filtered) {
        const resolved = await resolveTool(info, initCtx);
        result[resolved.id] = buildAiTool(resolved, getContext);
      }

      return mergeMcpTools(result, forAgentOptions);
    },
  },
  agents: {
    register(a: AgentInfoWithId) {
      agents.set(a.id, a);
    },
    list(): AgentInfoWithId[] {
      return Array.from(agents.values());
    },
    get(id: string): AgentInfoWithId | undefined {
      return agents.get(id);
    },
  },
};
