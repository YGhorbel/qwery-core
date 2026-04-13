import { Annotation, messagesStateReducer } from '@langchain/langgraph';
import type { BaseMessage } from '@langchain/core/messages';
import type {
  PlanArtifact,
  JoinPlanArtifact,
  QuerySpec,
  StepResult,
  VerificationReport,
  ExplainerOutput,
  CannotAnswerArtifact,
  DataAgentPhase,
} from './types';

export const DataAgentState = Annotation.Root({
  // ── Inputs (set once at graph.invoke) ──────────────────────────────────────
  userQuestion: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  datasourceId: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  driverId: Annotation<string>({ reducer: (_, b) => b, default: () => '' }),
  driverConfig: Annotation<Record<string, unknown>>({
    reducer: (_, b) => b,
    default: () => ({}),
  }),
  databaseType: Annotation<string>({
    reducer: (_, b) => b,
    default: () => 'postgresql',
  }),
  conversationContext: Annotation<string>({
    reducer: (_, b) => b,
    default: () => '',
  }),
  clarificationRound: Annotation<number>({
    reducer: (_, b) => b,
    default: () => 0,
  }),

  // ── Pre-graph vector search results ────────────────────────────────────────
  relevantDatasets: Annotation<string[]>({
    reducer: (_, b) => b,
    default: () => [],
  }),
  relevantDatasetDetails: Annotation<
    Array<{ name: string; description: string; source: string; yaml: string }>
  >({
    reducer: (_, b) => b,
    default: () => [],
  }),

  // ── Phase artifacts ────────────────────────────────────────────────────────
  plan: Annotation<PlanArtifact | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  joinPlan: Annotation<JoinPlanArtifact | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  querySpecs: Annotation<QuerySpec[] | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  stepResults: Annotation<StepResult[] | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  verificationReport: Annotation<VerificationReport | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  explainerOutput: Annotation<ExplainerOutput | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  cannotAnswer: Annotation<CannotAnswerArtifact | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // ── Control flow ───────────────────────────────────────────────────────────
  currentPhase: Annotation<DataAgentPhase | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  revisionCount: Annotation<number>({ reducer: (_, b) => b, default: () => 0 }),
  revisionDiagnosis: Annotation<string | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
  revisionTarget: Annotation<'navigator' | 'sql_builder' | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),

  // ── Navigator ReAct message history (append) ───────────────────────────────
  messages: Annotation<BaseMessage[]>({
    reducer: messagesStateReducer,
    default: () => [],
  }),

  // ── Token tracking (sum) ───────────────────────────────────────────────────
  tokensUsed: Annotation<{ prompt: number; completion: number; total: number }>(
    {
      reducer: (prev, next) => ({
        prompt: prev.prompt + next.prompt,
        completion: prev.completion + next.completion,
        total: prev.total + next.total,
      }),
      default: () => ({ prompt: 0, completion: 0, total: 0 }),
    },
  ),

  error: Annotation<string | null>({
    reducer: (_, b) => b,
    default: () => null,
  }),
});

export type DataAgentStateType = typeof DataAgentState.State;
