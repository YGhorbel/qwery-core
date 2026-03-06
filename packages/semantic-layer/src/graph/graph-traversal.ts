import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface GraphNode {
  id: string;
  type: 'concept' | 'property';
  data?: unknown;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: 'relationship' | 'property';
  relationshipType?: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  confidence?: number;
  data?: unknown;
}

export interface GraphPath {
  nodes: string[];
  edges: GraphEdge[];
  length: number;
  confidence: number;
}

export class Graph {
  private nodes = new Map<string, GraphNode>();
  private edges = new Map<string, GraphEdge[]>();
  private reverseEdges = new Map<string, GraphEdge[]>();

  addNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    if (!this.edges.has(node.id)) {
      this.edges.set(node.id, []);
    }
    if (!this.reverseEdges.has(node.id)) {
      this.reverseEdges.set(node.id, []);
    }
  }

  addEdge(edge: GraphEdge): void {
    if (!this.edges.has(edge.from)) {
      this.edges.set(edge.from, []);
    }
    if (!this.reverseEdges.has(edge.to)) {
      this.reverseEdges.set(edge.to, []);
    }

    this.edges.get(edge.from)!.push(edge);
    this.reverseEdges.get(edge.to)!.push(edge);
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  getEdges(from: string): GraphEdge[] {
    return this.edges.get(from) || [];
  }

  getReverseEdges(to: string): GraphEdge[] {
    return this.reverseEdges.get(to) || [];
  }

  getAllNodes(): GraphNode[] {
    return Array.from(this.nodes.values());
  }

  getAllEdges(): GraphEdge[] {
    return Array.from(this.edges.values()).flat();
  }

  /**
   * Find all paths between two nodes using BFS
   */
  findAllPaths(from: string, to: string, maxDepth: number = 5): GraphPath[] {
    const paths: GraphPath[] = [];
    const queue: Array<{ node: string; path: string[]; edges: GraphEdge[] }> = [
      { node: from, path: [from], edges: [] },
    ];
    const visited = new Set<string>();

    while (queue.length > 0) {
      const { node, path, edges } = queue.shift()!;

      if (node === to && path.length > 1) {
        const confidence = this.calculatePathConfidence(edges);
        paths.push({
          nodes: path,
          edges,
          length: path.length - 1,
          confidence,
        });
        continue;
      }

      if (path.length > maxDepth) {
        continue;
      }

      const pathKey = path.join('->');
      if (visited.has(pathKey)) {
        continue;
      }
      visited.add(pathKey);

      const outgoingEdges = this.getEdges(node);
      for (const edge of outgoingEdges) {
        if (!path.includes(edge.to)) {
          queue.push({
            node: edge.to,
            path: [...path, edge.to],
            edges: [...edges, edge],
          });
        }
      }
    }

    return paths.sort((a, b) => {
      // Sort by length first (shorter = better), then by confidence
      if (a.length !== b.length) {
        return a.length - b.length;
      }
      return b.confidence - a.confidence;
    });
  }

  /**
   * Find shortest path between two nodes using BFS
   */
  findShortestPath(from: string, to: string): GraphPath | null {
    const paths = this.findAllPaths(from, to, 10);
    return paths.length > 0 ? paths[0]! : null;
  }

  /**
   * Get neighbors of a node
   */
  getNeighbors(nodeId: string): string[] {
    const edges = this.getEdges(nodeId);
    return edges.map((e) => e.to);
  }

  /**
   * Check if two nodes are connected
   */
  isConnected(from: string, to: string): boolean {
    return this.findShortestPath(from, to) !== null;
  }

  /**
   * Calculate path confidence based on edge confidences
   */
  private calculatePathConfidence(edges: GraphEdge[]): number {
    if (edges.length === 0) {
      return 1.0;
    }

    const confidences = edges.map((e) => e.confidence ?? 0.5);
    // Use geometric mean for path confidence
    const product = confidences.reduce((acc, c) => acc * c, 1);
    return Math.pow(product, 1 / confidences.length);
  }

  /**
   * Get subgraph containing specific nodes
   */
  getSubgraph(nodeIds: string[]): Graph {
    const subgraph = new Graph();

    for (const nodeId of nodeIds) {
      const node = this.getNode(nodeId);
      if (node) {
        subgraph.addNode(node);
      }
    }

    for (const nodeId of nodeIds) {
      const edges = this.getEdges(nodeId);
      for (const edge of edges) {
        if (nodeIds.includes(edge.to)) {
          subgraph.addEdge(edge);
        }
      }
    }

    return subgraph;
  }
}
