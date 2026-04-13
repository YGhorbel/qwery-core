/**
 * Shared orchestration helpers used by both agent-session (SSE streaming)
 * and run-agent-to-completion (batch mode).
 *
 * Eliminates ~120 lines of duplication between the two entry points.
 */
import type { UIMessage } from 'ai';
import type { Repositories } from '@qwery/domain/repositories';
import type { Datasource } from '@qwery/domain/entities';
import { Provider } from '../llm/provider';
import { Registry } from '../tools/registry';
import {
  MessagePersistenceService,
  type PersistMessageOptions,
} from '../services/message-persistence.service';
import { UsagePersistenceService } from '../services/usage-persistence.service';
import { loadDatasources } from '../tools/datasource-loader';
import { getLogger } from '@qwery/shared/logger';
import type { AgentInfoWithId } from './agent';

// ── Model Resolution ────────────────────────────────────────────────

export type ResolvedModel = {
  providerModel: ReturnType<typeof Provider.getModelFromString>;
  modelForRegistry: { providerId: string; modelId: string };
};

export function resolveModel(modelInput?: string): ResolvedModel {
  const providerModel =
    typeof modelInput === 'string' && modelInput
      ? Provider.getModelFromString(modelInput)
      : Provider.getDefaultModel();
  return {
    providerModel,
    modelForRegistry: {
      providerId: providerModel.providerID,
      modelId: providerModel.id,
    },
  };
}

// ── Agent Resolution ────────────────────────────────────────────────

export function resolveAgent(agentId: string): AgentInfoWithId {
  const agentInfo = Registry.agents.get(agentId);
  if (!agentInfo) {
    throw new Error(`Agent not found: ${agentId}`);
  }
  return agentInfo;
}

// ── Datasource Loading ──────────────────────────────────────────────

export async function loadAndFormatDatasources(
  datasourceIds: string[],
  datasourceRepo: Repositories['datasource'],
): Promise<{
  datasources: Datasource[];
  reminderContext: {
    attachedDatasources: Array<{
      id: string;
      name: string;
      provider: string;
      driver: string;
    }>;
  };
}> {
  const datasources = await loadDatasources(datasourceIds, datasourceRepo);
  return {
    datasources,
    reminderContext: {
      attachedDatasources: datasources.map((d: Datasource) => ({
        id: d.id,
        name: d.name,
        provider: d.datasource_provider,
        driver: d.datasource_driver,
      })),
    },
  };
}

// ── Usage Persistence ───────────────────────────────────────────────

export async function persistUsageResult(opts: {
  usage: import('ai').LanguageModelUsage | null | undefined;
  model: string;
  userId: string;
  repositories: Repositories;
  conversationSlug: string;
  label: string;
}): Promise<void> {
  if (!opts.usage) return;
  const service = new UsagePersistenceService(
    opts.repositories.usage,
    opts.repositories.conversation,
    opts.repositories.project,
    opts.conversationSlug,
  );
  try {
    await service.persistUsage(opts.usage, opts.model, opts.userId);
  } catch (error) {
    const log = await getLogger();
    log.error(`[${opts.label}] Failed to persist usage:`, error);
  }
}

// ── Message Persistence ─────────────────────────────────────────────

export async function persistMessageResult(opts: {
  messages: UIMessage[];
  agentId: string;
  model: { modelID: string; providerID: string };
  repositories: Repositories;
  conversationSlug: string;
  label: string;
}): Promise<void> {
  const persistence = new MessagePersistenceService(
    opts.repositories.message,
    opts.repositories.conversation,
    opts.conversationSlug,
  );
  try {
    const options: PersistMessageOptions = {
      defaultMetadata: {
        agent: opts.agentId,
        model: opts.model,
      },
    };
    const result = await persistence.persistMessages(
      opts.messages,
      undefined,
      options,
    );
    if (result.errors.length > 0) {
      const log = await getLogger();
      log.warn(
        `[${opts.label}] Message persistence had errors:`,
        result.errors.map((e) => e.message).join(', '),
      );
    }
  } catch (error) {
    const log = await getLogger();
    log.warn(
      `[${opts.label}] Message persistence threw:`,
      error instanceof Error ? error.message : String(error),
    );
  }
}
