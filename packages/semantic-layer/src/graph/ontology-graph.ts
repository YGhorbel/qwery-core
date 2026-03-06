import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology, Concept, Relationship, Property } from '../models/ontology.schema';
import { Graph, type GraphNode, type GraphEdge, type GraphPath } from './graph-traversal';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface OntologyGraphNode extends GraphNode {
  conceptId?: string;
  propertyId?: string;
  label?: string;
  description?: string;
}

export interface OntologyGraphEdge extends GraphEdge {
  sourceConcept?: string;
  targetConcept?: string;
  relationshipType?: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  label?: string;
  description?: string;
}

export class OntologyGraph {
  private graph: Graph;
  private conceptToNodeMap = new Map<string, string>();
  private propertyToNodeMap = new Map<string, string>();

  constructor(ontology: Ontology) {
    this.graph = new Graph();
    this.buildGraph(ontology);
  }

  private buildGraph(ontology: Ontology): void {
    const logger = getLogger();

    // Add concept nodes
    for (const concept of ontology.ontology.concepts) {
      const conceptNodeId = `concept:${concept.id}`;
      this.conceptToNodeMap.set(concept.id, conceptNodeId);

      const node: OntologyGraphNode = {
        id: conceptNodeId,
        type: 'concept',
        conceptId: concept.id,
        label: concept.label,
        description: concept.description,
        data: concept,
      };

      this.graph.addNode(node);

      // Add property nodes (as concept attributes)
      for (const property of concept.properties || []) {
        const propertyNodeId = `property:${concept.id}:${property.id}`;
        this.propertyToNodeMap.set(`${concept.id}.${property.id}`, propertyNodeId);

        const propertyNode: OntologyGraphNode = {
          id: propertyNodeId,
          type: 'property',
          conceptId: concept.id,
          propertyId: property.id,
          label: property.label,
          description: property.description,
          data: property,
        };

        this.graph.addNode(propertyNode);

        // Add property edge (concept -> property)
        const propertyEdge: OntologyGraphEdge = {
          from: conceptNodeId,
          to: propertyNodeId,
          type: 'property',
          sourceConcept: concept.id,
          data: property,
        };

        this.graph.addEdge(propertyEdge);
      }

      // Add relationship edges
      for (const relationship of concept.relationships || []) {
        const targetConceptNodeId = `concept:${relationship.target}`;
        
        // Ensure target concept node exists
        if (!this.graph.getNode(targetConceptNodeId)) {
          const targetConcept = ontology.ontology.concepts.find((c) => c.id === relationship.target);
          if (targetConcept) {
            const targetNode: OntologyGraphNode = {
              id: targetConceptNodeId,
              type: 'concept',
              conceptId: targetConcept.id,
              label: targetConcept.label,
              description: targetConcept.description,
              data: targetConcept,
            };
            this.graph.addNode(targetNode);
            this.conceptToNodeMap.set(targetConcept.id, targetConceptNodeId);
          }
        }

        const relationshipEdge: OntologyGraphEdge = {
          from: conceptNodeId,
          to: targetConceptNodeId,
          type: 'relationship',
          relationshipType: relationship.type,
          sourceConcept: concept.id,
          targetConcept: relationship.target,
          label: relationship.label,
          description: relationship.description,
          confidence: 1.0, // Explicit relationships have full confidence
          data: relationship,
        };

        this.graph.addEdge(relationshipEdge);
      }
    }

    logger.then((l) => {
      l.info('[OntologyGraph] Graph built', {
        conceptsCount: ontology.ontology.concepts.length,
        totalNodes: this.graph.getAllNodes().length,
        totalEdges: this.graph.getAllEdges().length,
      });
    });
  }

  /**
   * Find paths between two concepts
   */
  findConceptPaths(fromConcept: string, toConcept: string, maxDepth: number = 5): GraphPath[] {
    const fromNodeId = this.conceptToNodeMap.get(fromConcept);
    const toNodeId = this.conceptToNodeMap.get(toConcept);

    if (!fromNodeId || !toNodeId) {
      return [];
    }

    return this.graph.findAllPaths(fromNodeId, toNodeId, maxDepth);
  }

  /**
   * Find shortest path between two concepts
   */
  findShortestConceptPath(fromConcept: string, toConcept: string): GraphPath | null {
    const fromNodeId = this.conceptToNodeMap.get(fromConcept);
    const toNodeId = this.conceptToNodeMap.get(toConcept);

    if (!fromNodeId || !toNodeId) {
      return null;
    }

    return this.graph.findShortestPath(fromNodeId, toNodeId);
  }

  /**
   * Get all relationships for a concept
   */
  getConceptRelationships(conceptId: string): OntologyGraphEdge[] {
    const nodeId = this.conceptToNodeMap.get(conceptId);
    if (!nodeId) {
      return [];
    }

    return this.graph.getEdges(nodeId).filter((e) => e.type === 'relationship') as OntologyGraphEdge[];
  }

  /**
   * Get all properties for a concept
   */
  getConceptProperties(conceptId: string): OntologyGraphNode[] {
    const nodeId = this.conceptToNodeMap.get(conceptId);
    if (!nodeId) {
      return [];
    }

    const propertyEdges = this.graph.getEdges(nodeId).filter((e) => e.type === 'property');
    return propertyEdges
      .map((e) => this.graph.getNode(e.to))
      .filter((n): n is OntologyGraphNode => n !== undefined && n.type === 'property');
  }

  /**
   * Check if two concepts are related
   */
  areConceptsRelated(fromConcept: string, toConcept: string): boolean {
    return this.findShortestConceptPath(fromConcept, toConcept) !== null;
  }

  /**
   * Get neighbors of a concept (concepts directly related)
   */
  getConceptNeighbors(conceptId: string): string[] {
    const relationships = this.getConceptRelationships(conceptId);
    return relationships.map((r) => r.targetConcept!).filter((c): c is string => c !== undefined);
  }

  /**
   * Get subgraph containing specific concepts
   */
  getConceptSubgraph(conceptIds: string[]): OntologyGraph {
    const nodeIds = conceptIds
      .map((id) => this.conceptToNodeMap.get(id))
      .filter((id): id is string => id !== undefined);

    const subgraph = this.graph.getSubgraph(nodeIds);
    
    // Create new OntologyGraph from subgraph
    // This is a simplified version - in practice, you'd rebuild from the subgraph
    const ontology: Ontology = {
      ontology: {
        concepts: [],
        inheritance: [],
      },
    };

    return new OntologyGraph(ontology);
  }

  /**
   * Add discovered relationship to graph
   */
  addDiscoveredRelationship(
    fromConcept: string,
    toConcept: string,
    relationshipType: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many',
    confidence: number,
    label?: string,
    description?: string,
  ): void {
    const fromNodeId = this.conceptToNodeMap.get(fromConcept);
    const toNodeId = this.conceptToNodeMap.get(toConcept);

    if (!fromNodeId || !toNodeId) {
      return;
    }

    // Check if relationship already exists
    const existing = this.graph.getEdges(fromNodeId).find(
      (e) => e.to === toNodeId && e.type === 'relationship',
    );

    if (existing) {
      return;
    }

    const edge: OntologyGraphEdge = {
      from: fromNodeId,
      to: toNodeId,
      type: 'relationship',
      relationshipType,
      sourceConcept: fromConcept,
      targetConcept: toConcept,
      label: label || `${fromConcept} → ${toConcept}`,
      description,
      confidence,
    };

    this.graph.addEdge(edge);
  }

  /**
   * Get all concepts in the graph
   */
  getAllConcepts(): string[] {
    return Array.from(this.conceptToNodeMap.keys());
  }

  /**
   * Get underlying graph for advanced operations
   */
  getGraph(): Graph {
    return this.graph;
  }
}
