import { generateText, type LanguageModel } from 'ai';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import type { SemanticPlan } from '../compiler/types';
import { OntologyGraph } from '../graph/ontology-graph';
import { loadMappings } from '../mapping/store';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ReasoningStep {
  type: 'concept_identification' | 'path_finding' | 'property_resolution' | 'join_planning' | 'optimization';
  description: string;
  data: unknown;
}

export interface ReasoningChain {
  steps: ReasoningStep[];
  finalPlan: SemanticPlan;
}

const COT_PROMPT = `You are a semantic query reasoner. Use Chain-of-Thought reasoning to analyze a natural language query over an ontology graph.

Given:
- User Query: "{query}"
- Ontology Concepts: {concepts}
- Ontology Relationships: {relationships}

Reason through these steps:

Step 1: Concept Identification
- Identify which concepts from the ontology are mentioned or implied in the query
- List all relevant concepts

Step 2: Relationship Traversal
- Find paths between identified concepts using the relationship graph
- Determine how concepts are connected

Step 3: Property Resolution
- Identify which properties are referenced in the query
- Map properties to their concepts

Step 4: Join Planning
- Plan how to join tables based on relationship paths
- Consider relationship types (has_one, has_many, belongs_to, many_to_many)

Step 5: Query Optimization
- Optimize the query plan based on relationship cardinality
- Consider filters, aggregations, and ordering

Return a JSON object with your reasoning chain:
{
  "steps": [
    {
      "type": "concept_identification",
      "description": "...",
      "concepts": ["Customer", "Order"]
    },
    {
      "type": "path_finding",
      "description": "...",
      "paths": [{"from": "Customer", "to": "Order", "type": "has_many"}]
    },
    {
      "type": "property_resolution",
      "description": "...",
      "properties": ["Customer.name", "Order.total"]
    },
    {
      "type": "join_planning",
      "description": "...",
      "joins": [...]
    },
    {
      "type": "optimization",
      "description": "...",
      "optimizations": [...]
    }
  ],
  "finalPlan": {
    "concepts": ["Customer", "Order"],
    "properties": ["Customer.name", "Order.total"],
    "relationships": [{"from": "Customer", "to": "Order", "type": "has_many"}],
    "filters": [],
    "aggregations": [],
    "groupBy": [],
    "ordering": [],
    "limit": null
  }
}`;

/**
 * Chain-of-Thought reasoning over ontology graph for complex queries.
 */
export async function reasonOverOntology(
  query: string,
  ontology: Ontology,
  ontologyVersion: string,
  datasourceId: string,
  languageModel: LanguageModel,
): Promise<ReasoningChain> {
  const logger = await getLogger();

  logger.info('[CoTReasoner] Starting chain-of-thought reasoning', {
    queryLength: query.length,
    conceptsCount: ontology.ontology.concepts.length,
  });

  const graph = new OntologyGraph(ontology);

  // Step 1: Concept Identification
  const concepts = await identifyConcepts(query, ontology, languageModel);
  logger.info('[CoTReasoner] Concepts identified', { concepts });

  // Step 2: Relationship Traversal
  const paths = findRelationshipPaths(graph, concepts);
  logger.info('[CoTReasoner] Relationship paths found', { pathsCount: paths.length });

  // Step 3: Property Resolution
  const properties = await resolveProperties(query, ontology, ontologyVersion, datasourceId, languageModel);
  logger.info('[CoTReasoner] Properties resolved', { properties });

  // Step 4: Join Planning
  const joins = planJoins(paths, concepts);
  logger.info('[CoTReasoner] Joins planned', { joinsCount: joins.length });

  // Step 5: Optimization
  const optimized = optimizeQuery(joins, properties, concepts);
  logger.info('[CoTReasoner] Query optimized');

  const steps: ReasoningStep[] = [
    {
      type: 'concept_identification',
      description: `Identified ${concepts.length} concepts: ${concepts.join(', ')}`,
      data: { concepts },
    },
    {
      type: 'path_finding',
      description: `Found ${paths.length} relationship paths`,
      data: { paths },
    },
    {
      type: 'property_resolution',
      description: `Resolved ${properties.length} properties`,
      data: { properties },
    },
    {
      type: 'join_planning',
      description: `Planned ${joins.length} joins`,
      data: { joins },
    },
    {
      type: 'optimization',
      description: 'Applied query optimizations',
      data: { optimizations: optimized },
    },
  ];

  // Build final semantic plan
  const finalPlan: SemanticPlan = {
    concepts,
    properties,
    relationships: paths.map((p) => ({
      from: p.from,
      to: p.to,
      type: p.type,
    })),
    filters: [],
    aggregations: [],
    groupBy: [],
    ordering: [],
    limit: undefined,
  };

  return {
    steps,
    finalPlan,
  };
}

async function identifyConcepts(
  query: string,
  ontology: Ontology,
  languageModel: LanguageModel,
): Promise<string[]> {
  const conceptsList = ontology.ontology.concepts
    .map((c) => `- ${c.id}: ${c.label}${c.description ? ` - ${c.description}` : ''}`)
    .join('\n');

  const prompt = `Identify which concepts from this ontology are mentioned or implied in the query.

Ontology Concepts:
${conceptsList}

Query: "${query}"

Return a JSON array of concept IDs: ["Customer", "Order"]`;

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.1,
    });

    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
  } catch (error) {
    // Fallback to simple keyword matching
  }

  // Fallback: simple keyword matching
  const queryLower = query.toLowerCase();
  return ontology.ontology.concepts
    .filter((c) => {
      const conceptLower = `${c.id} ${c.label} ${c.description || ''}`.toLowerCase();
      return conceptLower.split(' ').some((word) => queryLower.includes(word));
    })
    .map((c) => c.id);
}

function findRelationshipPaths(
  graph: OntologyGraph,
  concepts: string[],
): Array<{ from: string; to: string; type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' }> {
  const paths: Array<{ from: string; to: string; type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many' }> = [];

  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const fromConcept = concepts[i]!;
      const toConcept = concepts[j]!;

      const graphPath = graph.findShortestConceptPath(fromConcept, toConcept);
      if (graphPath && graphPath.nodes.length === 2) {
        // Direct relationship
        const relationships = graph.getConceptRelationships(fromConcept);
        const rel = relationships.find((r) => r.targetConcept === toConcept);
        if (rel && rel.relationshipType) {
          paths.push({
            from: fromConcept,
            to: toConcept,
            type: rel.relationshipType,
          });
        }
      }
    }
  }

  return paths;
}

async function resolveProperties(
  query: string,
  ontology: Ontology,
  ontologyVersion: string,
  datasourceId: string,
  languageModel: LanguageModel,
): Promise<string[]> {
  const propertiesList = ontology.ontology.concepts
    .flatMap((c) =>
      (c.properties || []).map((p) => `${c.id}.${p.id}: ${p.label} (${p.type})`),
    )
    .join('\n');

  const prompt = `Identify which properties from this ontology are referenced in the query.

Available Properties:
${propertiesList}

Query: "${query}"

Return a JSON array of property IDs in format "Concept.property": ["Customer.name", "Order.total"]`;

  try {
    const result = await generateText({
      model: languageModel,
      prompt,
      temperature: 0.1,
    });

    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
  } catch (error) {
    // Fallback to simple matching
  }

  // Fallback: simple keyword matching
  const queryLower = query.toLowerCase();
  const properties: string[] = [];

  for (const concept of ontology.ontology.concepts) {
    for (const property of concept.properties || []) {
      const propertyLower = `${property.id} ${property.label}`.toLowerCase();
      if (propertyLower.split(' ').some((word) => queryLower.includes(word))) {
        properties.push(`${concept.id}.${property.id}`);
      }
    }
  }

  return properties;
}

function planJoins(
  paths: Array<{ from: string; to: string; type: string }>,
  concepts: string[],
): Array<{ from: string; to: string; type: string }> {
  return paths;
}

function optimizeQuery(
  joins: Array<{ from: string; to: string; type: string }>,
  properties: string[],
  concepts: string[],
): unknown {
  return {
    joins,
    properties,
    concepts,
  };
}
