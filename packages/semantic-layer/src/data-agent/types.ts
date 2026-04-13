import { z } from 'zod';

// ─── Plan ─────────────────────────────────────────────────────────────────────

export const PlanStepSchema = z.object({
  id: z.number(),
  description: z.string(),
  strategy: z.enum(['sql', 'python', 'sql_then_python']),
  dependsOn: z.array(z.number()),
  datasets: z.array(z.string()),
  expectedOutput: z.string(),
  chartType: z.enum(['bar', 'line', 'pie', 'scatter']).nullable().optional(),
});

export const PlanArtifactSchema = z.object({
  complexity: z.enum(['simple', 'analytical', 'conversational']),
  intent: z.string(),
  metrics: z.array(z.string()),
  dimensions: z.array(z.string()),
  timeWindow: z.string().nullable(),
  filters: z.array(z.string()),
  grain: z.string(),
  ambiguities: z.array(
    z.object({ question: z.string(), assumption: z.string() }),
  ),
  acceptanceChecks: z.array(z.string()),
  shouldClarify: z.boolean(),
  clarificationQuestions: z.array(
    z.object({ question: z.string(), assumption: z.string() }),
  ),
  confidenceLevel: z.enum(['high', 'medium', 'low']),
  steps: z.array(PlanStepSchema),
});

export type PlanStep = z.infer<typeof PlanStepSchema>;
export type PlanArtifact = z.infer<typeof PlanArtifactSchema>;

// ─── Navigator / Join Plan ────────────────────────────────────────────────────

export interface JoinEdge {
  fromDataset: string;
  toDataset: string;
  fromColumns: string[];
  toColumns: string[];
  relationshipName: string;
}

export interface DatasetDetail {
  name: string;
  description: string;
  source: string;
  yaml: string;
}

export interface JoinPlanArtifact {
  relevantDatasets: DatasetDetail[];
  joinPaths: Array<{ datasets: string[]; edges: JoinEdge[] }>;
  notes: string;
}

export interface CannotAnswerArtifact {
  reason: string;
  suggestions: string[];
}

// ─── SQL Builder ──────────────────────────────────────────────────────────────

export interface QuerySpec {
  stepId: number;
  description: string;
  pilotSql: string;
  fullSql: string;
  expectedColumns: string[];
  notes: string;
}

export const QuerySpecListSchema = z.object({
  queries: z.array(
    z.object({
      stepId: z.number(),
      description: z.string(),
      pilotSql: z.string(),
      fullSql: z.string(),
      expectedColumns: z.array(z.string()),
      notes: z.string(),
    }),
  ),
});

// ─── Executor ─────────────────────────────────────────────────────────────────

export interface SqlResult {
  stepId: number;
  pilotRows: Record<string, unknown>[];
  data: string; // pipe-delimited table (max 100 rows shown)
  columns: string[];
  rowCount: number;
  error?: string;
}

export interface PythonResult {
  stdout: string;
  stderr: string;
  charts: string[]; // base64 data-URLs
  error?: string;
}

export const ChartSpecSchema = z.object({
  type: z.enum(['bar', 'line', 'pie', 'scatter']),
  title: z.string(),
  xKey: z.string(),
  yKey: z.string(),
  data: z.array(z.record(z.string(), z.unknown())),
  xLabel: z.string().optional(),
  yLabel: z.string().optional(),
});

export type ChartSpec = z.infer<typeof ChartSpecSchema>;

export interface StepResult {
  stepId: number;
  description: string;
  strategy: PlanStep['strategy'];
  sqlResult?: SqlResult;
  pythonResult?: PythonResult;
  chartSpec?: ChartSpec;
  error?: string;
}

// ─── Verifier ─────────────────────────────────────────────────────────────────

export interface VerificationCheck {
  name: string;
  passed: boolean;
  message: string;
}

export interface VerificationReport {
  passed: boolean;
  checks: VerificationCheck[];
  diagnosis?: string;
  recommendedTarget?: 'navigator' | 'sql_builder';
}

// ─── Explainer ────────────────────────────────────────────────────────────────

export interface DataLineage {
  datasetsUsed: string[];
  joins: Array<{ from: string; to: string; on: string }>;
}

export interface ExplainerOutput {
  narrative: string;
  charts: string[];
  lineage: DataLineage;
  caveats: string[];
}

// ─── SSE Events ───────────────────────────────────────────────────────────────

export type DataAgentPhase =
  | 'planner'
  | 'navigator'
  | 'sql_builder'
  | 'executor'
  | 'verifier'
  | 'explainer';

export type AgentStreamEvent =
  | { type: 'message_start'; startedAt: number }
  | { type: 'discovery_start' }
  | {
      type: 'discovery_complete';
      embeddingDurationMs: number;
      vectorSearchDurationMs: number;
      yamlFetchDurationMs: number;
      matchedDatasets: Array<{ name: string; score: number }>;
      datasetsWithYaml: number;
    }
  | { type: 'phase_start'; phase: DataAgentPhase; description: string }
  | { type: 'phase_complete'; phase: DataAgentPhase }
  | { type: 'phase_artifact'; phase: DataAgentPhase; artifact: unknown }
  | {
      type: 'llm_call_start';
      phase: DataAgentPhase;
      callIndex: number;
      stepId?: number;
      purpose: string;
      provider: string;
      model: string;
      structuredOutput: boolean;
    }
  | {
      type: 'llm_call_end';
      phase: DataAgentPhase;
      callIndex: number;
      stepId?: number;
      purpose: string;
      durationMs: number;
      promptTokens: number;
      completionTokens: number;
      totalTokens: number;
      responsePreview: string;
      toolCallCount: number;
    }
  | {
      type: 'token_update';
      phase: DataAgentPhase;
      tokensUsed: { prompt: number; completion: number; total: number };
    }
  | {
      type: 'tool_start';
      phase: DataAgentPhase;
      stepId?: number;
      name: string;
      args: Record<string, unknown>;
    }
  | {
      type: 'tool_end';
      phase: DataAgentPhase;
      stepId?: number;
      name: string;
      result: string;
    }
  | {
      type: 'tool_error';
      phase: DataAgentPhase;
      stepId?: number;
      name: string;
      error: string;
    }
  | {
      type: 'step_start';
      stepId: number;
      description: string;
      strategy: string;
    }
  | { type: 'step_complete'; stepId: number }
  | { type: 'text'; content: string }
  | {
      type: 'clarification_requested';
      questions: Array<{ question: string; assumption: string }>;
    }
  | {
      type: 'message_complete';
      content: string;
      metadata: Record<string, unknown>;
      status?: 'clarification_needed';
    }
  | { type: 'message_error'; message: string };

export type EmitFn = (event: AgentStreamEvent) => void;
