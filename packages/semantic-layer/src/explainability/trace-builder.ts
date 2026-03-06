import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import { MinIOClient, getMinIOClient } from '../storage/minio-client';
import type { SemanticPlan } from '../compiler/types';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ReasoningTrace {
  query: string;
  datasourceId: string;
  ontologyVersion: string;
  semanticPlan: SemanticPlan;
  steps: TraceStep[];
  joinInferences: JoinInference[];
  measureSelections: MeasureSelection[];
  mappingSelections: MappingSelection[];
  timestamp: string;
}

export interface TraceStep {
  step: string;
  description: string;
  input?: unknown;
  output?: unknown;
  durationMs?: number;
}

export interface JoinInference {
  fromTable: string;
  toTable: string;
  reason: string;
  confidence: number;
}

export interface MeasureSelection {
  property: string;
  aggregation?: string;
  reason: string;
}

export interface MappingSelection {
  term: string;
  mappedTo: string;
  type: 'concept' | 'property';
  confidence: number;
  reason: string;
}

export class ReasoningTraceBuilder {
  private client: MinIOClient | null;
  private enabled: boolean;
  private trace: Partial<ReasoningTrace>;

  constructor(client: MinIOClient | null, enabled = true) {
    this.client = client;
    this.enabled = enabled;
    this.trace = {
      steps: [],
      joinInferences: [],
      measureSelections: [],
      mappingSelections: [],
    };
  }

  initialize(query: string, datasourceId: string, ontologyVersion: string, semanticPlan: SemanticPlan): void {
    this.trace = {
      query,
      datasourceId,
      ontologyVersion,
      semanticPlan,
      steps: [],
      joinInferences: [],
      measureSelections: [],
      mappingSelections: [],
      timestamp: new Date().toISOString(),
    };
  }

  addStep(step: string, description: string, input?: unknown, output?: unknown, durationMs?: number): void {
    if (!this.enabled) return;
    this.trace.steps?.push({
      step,
      description,
      input,
      output,
      durationMs,
    });
  }

  addJoinInference(fromTable: string, toTable: string, reason: string, confidence: number): void {
    if (!this.enabled) return;
    this.trace.joinInferences?.push({
      fromTable,
      toTable,
      reason,
      confidence,
    });
  }

  addMeasureSelection(property: string, aggregation: string | undefined, reason: string): void {
    if (!this.enabled) return;
    this.trace.measureSelections?.push({
      property,
      aggregation,
      reason,
    });
  }

  addMappingSelection(term: string, mappedTo: string, type: 'concept' | 'property', confidence: number, reason: string): void {
    if (!this.enabled) return;
    this.trace.mappingSelections?.push({
      term,
      mappedTo,
      type,
      confidence,
      reason,
    });
  }

  async save(): Promise<void> {
    if (!this.enabled || !this.client || !this.trace.datasourceId) {
      return;
    }

    const logger = await getLogger();
    const queryHash = await this.hashQuery(this.trace.query || '');
    const path = `traces/${this.trace.datasourceId}/${queryHash}/trace.json`;

    try {
      const traceJson = JSON.stringify(this.trace as ReasoningTrace, null, 2);
      await this.client.putObject(path, traceJson, 'application/json');
      
      logger.debug('[ReasoningTraceBuilder] Trace saved', {
        datasourceId: this.trace.datasourceId,
        queryHash: queryHash.substring(0, 16),
      });
    } catch (error) {
      logger.warn('[ReasoningTraceBuilder] Failed to save trace', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async hashQuery(query: string): Promise<string> {
    const encoder = new TextEncoder();
    const data = encoder.encode(query);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  getTrace(): Partial<ReasoningTrace> {
    return { ...this.trace };
  }
}

let defaultTraceBuilder: ReasoningTraceBuilder | null = null;

export function getReasoningTraceBuilder(): ReasoningTraceBuilder | null {
  if (!defaultTraceBuilder) {
    const client = getMinIOClient();
    defaultTraceBuilder = new ReasoningTraceBuilder(client, true);
  }
  return defaultTraceBuilder;
}
