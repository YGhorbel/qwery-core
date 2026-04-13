import { StateGraph, END } from '@langchain/langgraph';
import { DataAgentState, type DataAgentStateType } from '../state';
import { createPlannerNode } from './nodes/planner';
import { createNavigatorNode } from './nodes/navigator';
import { createSqlBuilderNode } from './nodes/sql-builder';
import { createExecutorNode } from './nodes/executor';
import { createVerifierNode } from './nodes/verifier';
import { createExplainerNode } from './nodes/explainer';
import type { NeoOntologyService } from '../../ontology/neo-ontology.service';
import type { DiscoveryService } from '../../discovery.service';
import type { SandboxService } from '../sandbox.service';
import type { EmitFn } from '../types';
import type { ChatModel } from '../../llm';
import { DataAgentTracer } from './tracer';

export interface DataAgentGraphDeps {
  llm: ChatModel;
  structuredLlm: ChatModel;
  neoOntologyService: NeoOntologyService;
  discoveryService: DiscoveryService;
  sandboxService: SandboxService;
  datasourceId: string;
  emit: EmitFn;
  tracer: DataAgentTracer;
}

const MAX_REVISIONS = 3;

export function buildDataAgentGraph(deps: DataAgentGraphDeps) {
  const {
    llm,
    structuredLlm,
    neoOntologyService,
    discoveryService,
    sandboxService,
    datasourceId,
    emit,
    tracer,
  } = deps;

  const graph = new StateGraph(DataAgentState)
    .addNode('planner', createPlannerNode(structuredLlm, emit, tracer))
    .addNode(
      'navigator',
      createNavigatorNode(llm, neoOntologyService, datasourceId, emit, tracer),
    )
    .addNode('sql_builder', createSqlBuilderNode(structuredLlm, emit, tracer))
    .addNode(
      'executor',
      createExecutorNode(
        llm,
        structuredLlm,
        discoveryService,
        sandboxService,
        emit,
        tracer,
      ),
    )
    .addNode('verifier', createVerifierNode(llm, sandboxService, emit, tracer))
    .addNode('explainer', createExplainerNode(llm, emit, tracer));

  // ── Entry ─────────────────────────────────────────────────────────────────
  graph.setEntryPoint('planner');

  // ── planner → ? ───────────────────────────────────────────────────────────
  graph.addConditionalEdges(
    'planner',
    (state: DataAgentStateType) => {
      const plan = state.plan;
      if (!plan) return 'explainer';
      if (plan.shouldClarify && plan.clarificationQuestions.length > 0)
        return '__end__';
      if (plan.complexity === 'conversational') return 'explainer';
      return 'navigator';
    },
    {
      navigator: 'navigator',
      explainer: 'explainer',
      __end__: END,
    },
  );

  // ── navigator → ? ─────────────────────────────────────────────────────────
  graph.addConditionalEdges(
    'navigator',
    (state: DataAgentStateType) => {
      if (state.cannotAnswer) return 'explainer';
      return 'sql_builder';
    },
    {
      sql_builder: 'sql_builder',
      explainer: 'explainer',
    },
  );

  // ── linear: sql_builder → executor → verifier ─────────────────────────────
  graph.addEdge('sql_builder', 'executor');
  graph.addEdge('executor', 'verifier');

  // ── verifier → ? ──────────────────────────────────────────────────────────
  graph.addConditionalEdges(
    'verifier',
    (state: DataAgentStateType) => {
      const report = state.verificationReport;
      if (!report || report.passed || state.revisionCount >= MAX_REVISIONS)
        return 'explainer';
      if (state.revisionTarget === 'navigator') return 'navigator';
      return 'sql_builder';
    },
    {
      explainer: 'explainer',
      navigator: 'navigator',
      sql_builder: 'sql_builder',
    },
  );

  // ── explainer → end ───────────────────────────────────────────────────────
  graph.addEdge('explainer', END);

  return graph.compile();
}
