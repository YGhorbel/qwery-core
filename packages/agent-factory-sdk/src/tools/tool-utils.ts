import type { Repositories } from '@qwery/domain/repositories';
import type { ToolContext } from './tool';

/**
 * Typed shape of `ctx.extra` as populated by agent-session and run-agent-to-completion.
 * Use this instead of ad-hoc `ctx.extra as { ... }` casts in every tool.
 */
export type ToolContextExtra = {
  repositories: Repositories;
  conversationId: string;
  attachedDatasources: string[];
  lastRunQueryResult?: {
    current: { columns: string[]; rows: unknown[] } | null;
  };
};

/**
 * Extract typed extra from a ToolContext.
 */
export function getExtra(ctx: ToolContext): ToolContextExtra {
  return ctx.extra as ToolContextExtra;
}

/**
 * Resolve the actual datasource UUID.
 *
 * The LLM may pass a slug, name, or stale ID instead of the real UUID.
 * This checks whether the provided ID is in the attached list; if not,
 * falls back to the first attached datasource.
 */
export function resolveDatasourceId(
  providedId: string,
  attachedDatasources: string[],
): string {
  if ((attachedDatasources ?? []).includes(providedId)) {
    return providedId;
  }
  return attachedDatasources?.[0] ?? providedId;
}
