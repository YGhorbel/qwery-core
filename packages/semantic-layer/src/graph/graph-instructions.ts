import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import { OntologyGraph } from './ontology-graph';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface GraphInstruction {
  nodes: Array<{
    id: string;
    type: string;
    label: string;
    attributes?: Array<{ id: string; label: string; type: string }>;
    domain?: string;
    synonyms?: string[];
  }>;
  edges: Array<{
    from: string;
    to: string;
    type: string;
    label?: string;
    relationshipType?: string;
    confidence?: number;
    cardinality?: 'one' | 'many';
  }>;
  description: string;
  embeddings?: {
    conceptEmbeddings?: Record<string, number[]>;
    tableEmbeddings?: Record<string, number[]>;
  };
}

/**
 * Generate graph-structured instructions for LLM understanding.
 * Based on HiGBT paper approach for graph instruction tuning.
 */
export function generateGraphInstructions(ontology: Ontology): GraphInstruction {
  const logger = getLogger();
  const graph = new OntologyGraph(ontology);

  const nodes = ontology.ontology.concepts.map((concept) => {
    const properties = (concept.properties || []).map((prop) => ({
      id: prop.id,
      label: prop.label,
      type: prop.type,
    }));

    return {
      id: concept.id,
      type: 'concept',
      label: concept.label,
      attributes: properties,
    };
  });

  const edges = ontology.ontology.concepts.flatMap((concept) =>
    (concept.relationships || []).map((rel) => ({
      from: concept.id,
      to: rel.target,
      type: 'relationship',
      label: rel.label,
      relationshipType: rel.type,
      confidence: undefined, // Will be populated if available
      cardinality: rel.type === 'has_one' || rel.type === 'belongs_to' ? 'one' : 'many',
    })),
  );

  const description = `Graph Structure:
Nodes: ${nodes.map((n) => {
    const attrs = n.attributes?.map((a) => a.id).join(', ') || '';
    const domain = (n as { domain?: string }).domain ? ` [${(n as { domain?: string }).domain}]` : '';
    return `${n.id}(${attrs})${domain}`;
  }).join(', ')}
Edges: ${edges.map((e) => {
    const conf = (e as { confidence?: number }).confidence ? ` (${((e as { confidence?: number }).confidence! * 100).toFixed(0)}%)` : '';
    return `${e.from} --[${e.relationshipType}]--> ${e.to}${conf}`;
  }).join(', ')}`;

  logger.then((l) => {
    l.debug('[GraphInstructions] Generated graph instructions', {
      nodesCount: nodes.length,
      edgesCount: edges.length,
    });
  });

  return {
    nodes,
    edges,
    description,
  };
}

/**
 * Format graph instructions as text for LLM prompts
 */
export function formatGraphInstructionsAsText(instructions: GraphInstruction): string {
  const nodesText = instructions.nodes
    .map((n) => {
      const attrs = n.attributes?.map((a) => `${a.id}: ${a.type}`).join(', ') || '';
      return `  - ${n.id} (${n.label}): ${attrs}`;
    })
    .join('\n');

  const edgesText = instructions.edges
    .map((e) => {
      const label = e.label ? ` "${e.label}"` : '';
      return `  - ${e.from} --[${e.relationshipType}]--> ${e.to}${label}`;
    })
    .join('\n');

  return `Graph Structure:

Nodes:
${nodesText}

Edges:
${edgesText}

You can reason over this graph structure to understand relationships between concepts.
Use graph traversal to find paths between nodes.
Consider relationship types when planning joins.`;
}
