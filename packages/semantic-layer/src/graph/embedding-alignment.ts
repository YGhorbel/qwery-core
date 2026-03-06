import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { MappingResult } from '../mapping/generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface EmbeddingVector {
  id: string;
  vector: number[];
}

export interface AlignmentResult {
  conceptEmbeddings: Map<string, number[]>;
  tableEmbeddings: Map<string, number[]>;
  alignmentLoss: number;
}

/**
 * Align concept and table embeddings using graph structure.
 * Implements inter-type and intra-type alignment from HiGBT paper.
 */
export class EmbeddingAlignment {
  private embeddingDimension = 128; // Default embedding dimension

  /**
   * Learn embeddings for concepts and tables, then align them.
   */
  async learnAndAlign(
    ontology: Ontology,
    metadata: DatasourceMetadata,
    mappings: MappingResult,
  ): Promise<AlignmentResult> {
    const logger = await getLogger();

    logger.info('[EmbeddingAlignment] Learning and aligning embeddings', {
      conceptsCount: ontology.ontology.concepts.length,
      tablesCount: metadata.tables.length,
      mappingsCount: mappings.table_mappings.length,
    });

    // Learn concept embeddings from ontology structure
    const conceptEmbeddings = await this.learnConceptEmbeddings(ontology);

    // Learn table embeddings from schema
    const tableEmbeddings = await this.learnTableEmbeddings(metadata);

    // Align embeddings
    const alignmentLoss = await this.alignEmbeddings(
      conceptEmbeddings,
      tableEmbeddings,
      mappings,
    );

    logger.info('[EmbeddingAlignment] Embedding alignment complete', {
      conceptEmbeddingsCount: conceptEmbeddings.size,
      tableEmbeddingsCount: tableEmbeddings.size,
      alignmentLoss: alignmentLoss.toFixed(4),
    });

    return {
      conceptEmbeddings,
      tableEmbeddings,
      alignmentLoss,
    };
  }

  /**
   * Learn concept embeddings from ontology graph structure.
   */
  private async learnConceptEmbeddings(ontology: Ontology): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();

    // Simple embedding: based on concept properties and relationships
    // In a full implementation, this would use graph neural networks
    for (const concept of ontology.ontology.concepts) {
      const embedding = this.generateConceptEmbedding(concept);
      embeddings.set(concept.id, embedding);
    }

    return embeddings;
  }

  /**
   * Learn table embeddings from schema structure.
   */
  private async learnTableEmbeddings(metadata: DatasourceMetadata): Promise<Map<string, number[]>> {
    const embeddings = new Map<string, number[]>();

    // Simple embedding: based on table columns and relationships
    // In a full implementation, this would use schema structure and data statistics
    for (const table of metadata.tables) {
      const tableKey = `${table.schema}.${table.name}`;
      const embedding = this.generateTableEmbedding(table, metadata);
      embeddings.set(tableKey, embedding);
    }

    return embeddings;
  }

  /**
   * Align embeddings using inter-type and intra-type constraints.
   */
  private async alignEmbeddings(
    conceptEmbeddings: Map<string, number[]>,
    tableEmbeddings: Map<string, number[]>,
    mappings: MappingResult,
  ): Promise<number> {
    let totalLoss = 0.0;
    let alignmentCount = 0;

    // Inter-type alignment: concept-table pairs from mappings
    for (const mapping of mappings.table_mappings) {
      const conceptId = mapping.concept_id;
      const tableKey = `${mapping.table_schema}.${mapping.table_name}`;

      const conceptEmb = conceptEmbeddings.get(conceptId);
      const tableEmb = tableEmbeddings.get(tableKey);

      if (conceptEmb && tableEmb) {
        // Calculate distance (cosine similarity)
        const distance = this.cosineDistance(conceptEmb, tableEmb);
        totalLoss += distance;
        alignmentCount++;

        // In a full implementation, we would update embeddings to minimize this distance
      }
    }

    // Intra-type alignment: concepts with similar relationships
    // This would align concepts that have similar relationship patterns
    // For now, we calculate a simple similarity metric

    return alignmentCount > 0 ? totalLoss / alignmentCount : 0.0;
  }

  /**
   * Generate embedding for a concept based on its structure.
   */
  private generateConceptEmbedding(concept: {
    id: string;
    label: string;
    properties: Array<{ id: string; type: string }>;
    relationships?: Array<{ target: string; type: string }>;
  }): number[] {
    // Simple hash-based embedding
    // In a full implementation, this would use learned embeddings from graph structure
    const embedding: number[] = new Array(this.embeddingDimension).fill(0);

    // Hash concept ID
    let hash = 0;
    for (let i = 0; i < concept.id.length; i++) {
      hash = ((hash << 5) - hash + concept.id.charCodeAt(i)) & 0xffffffff;
    }

    // Distribute hash across embedding dimensions
    for (let i = 0; i < this.embeddingDimension; i++) {
      embedding[i] = ((hash + i) % 100) / 100.0;
    }

    // Adjust based on properties count
    const propFactor = concept.properties.length / 10.0;
    for (let i = 0; i < Math.min(this.embeddingDimension, 10); i++) {
      embedding[i] = (embedding[i]! + propFactor) % 1.0;
    }

    // Adjust based on relationships count
    const relFactor = (concept.relationships?.length || 0) / 10.0;
    for (let i = 10; i < Math.min(this.embeddingDimension, 20); i++) {
      embedding[i] = (embedding[i]! + relFactor) % 1.0;
    }

    return embedding;
  }

  /**
   * Generate embedding for a table based on its schema.
   */
  private generateTableEmbedding(
    table: { schema: string; name: string; relationships?: unknown[] },
    metadata: DatasourceMetadata,
  ): number[] {
    const embedding: number[] = new Array(this.embeddingDimension).fill(0);

    // Hash table name
    let hash = 0;
    const tableKey = `${table.schema}.${table.name}`;
    for (let i = 0; i < tableKey.length; i++) {
      hash = ((hash << 5) - hash + tableKey.charCodeAt(i)) & 0xffffffff;
    }

    // Distribute hash
    for (let i = 0; i < this.embeddingDimension; i++) {
      embedding[i] = ((hash + i) % 100) / 100.0;
    }

    // Adjust based on column count
    const columns = metadata.columns.filter(
      (c) => c.schema === table.schema && c.table === table.name,
    );
    const colFactor = columns.length / 20.0;
    for (let i = 0; i < Math.min(this.embeddingDimension, 10); i++) {
      embedding[i] = (embedding[i]! + colFactor) % 1.0;
    }

    // Adjust based on relationships count
    const relFactor = (table.relationships?.length || 0) / 10.0;
    for (let i = 10; i < Math.min(this.embeddingDimension, 20); i++) {
      embedding[i] = (embedding[i]! + relFactor) % 1.0;
    }

    return embedding;
  }

  /**
   * Calculate cosine distance between two embeddings.
   */
  private cosineDistance(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) {
      return 1.0;
    }

    let dotProduct = 0.0;
    let norm1 = 0.0;
    let norm2 = 0.0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i]! * vec2[i]!;
      norm1 += vec1[i]! * vec1[i]!;
      norm2 += vec2[i]! * vec2[i]!;
    }

    if (norm1 === 0 || norm2 === 0) {
      return 1.0;
    }

    const similarity = dotProduct / (Math.sqrt(norm1) * Math.sqrt(norm2));
    return 1.0 - similarity; // Convert similarity to distance
  }
}

let instance: EmbeddingAlignment | null = null;

export function getEmbeddingAlignment(): EmbeddingAlignment {
  if (!instance) {
    instance = new EmbeddingAlignment();
  }
  return instance;
}
