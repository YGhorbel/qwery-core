import { END, START, StateGraph } from '@langchain/langgraph';

import { assembleModelNode } from './nodes/assemble-model';
import { discoverAndGenerateNode } from './nodes/discover-and-generate';
import { discoverRelationshipsNode } from './nodes/discover-relationships';
import { generateRelationshipsNode } from './nodes/generate-relationships';
import { persistModelNode } from './nodes/persist-model';
import { validateModelNode } from './nodes/validate-model';
import { AgentState } from './state';

export function buildSemanticModelGraph() {
  const graph = new StateGraph(AgentState)
    .addNode('discover_and_generate', discoverAndGenerateNode)
    .addNode('discover_relationships', discoverRelationshipsNode)
    .addNode('generate_relationships', generateRelationshipsNode)
    .addNode('assemble_model', assembleModelNode)
    .addNode('validate_model', validateModelNode)
    .addNode('persist_model', persistModelNode)
    .addEdge(START, 'discover_and_generate')
    .addEdge('discover_and_generate', 'discover_relationships')
    .addEdge('discover_relationships', 'generate_relationships')
    .addEdge('generate_relationships', 'assemble_model')
    .addEdge('assemble_model', 'validate_model')
    .addEdge('validate_model', 'persist_model')
    .addEdge('persist_model', END);

  return graph.compile();
}
