import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import type { MappingResult } from '../mapping/generator';
import type { TrainingExample } from './data-collector';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface SchemaPatterns {
  tableCount: number;
  columnCount: number;
  averageColumnsPerTable: number;
  commonColumnNames: Map<string, number>;
  commonTableNames: string[];
  namingConventions: {
    tablePrefixes: string[];
    columnSuffixes: string[];
  };
}

export interface LearnedPatterns {
  conceptUsageFrequency: Map<string, number>;
  propertyUsageFrequency: Map<string, number>;
  relationshipUsageFrequency: Map<string, number>;
  sqlPatterns: string[];
  queryToSQLMappings: Map<string, string>;
}

export interface AlignedOntology extends Ontology {
  alignmentScores: Map<string, number>; // concept -> alignment score
}

export interface RefinedMappings extends MappingResult {
  refinementScores: Map<string, number>; // mapping -> refinement score
}

/**
 * Implement LOM training approach for structured data.
 * 
 * Based on LOM Paper Sections:
 * - Schema Analysis: Extract patterns from database schema
 * - Query Pattern Learning: Learn from successful query translations
 * - Statistical Alignment: Use statistics to improve mappings
 * - Feedback Loop: Continuous improvement from user corrections
 */
export class StructuredDataTrainer {
  /**
   * Step 1: Analyze schema patterns.
   */
  async analyzeSchemaPatterns(metadata: DatasourceMetadata): Promise<SchemaPatterns> {
    const logger = await getLogger();

    logger.info('[StructuredDataTrainer] Analyzing schema patterns', {
      tablesCount: metadata.tables.length,
      columnsCount: metadata.columns.length,
    });

    const columnNameCounts = new Map<string, number>();
    const tablePrefixes = new Set<string>();
    const columnSuffixes = new Set<string>();

    for (const column of metadata.columns) {
      // Count column name frequency
      const count = columnNameCounts.get(column.name) || 0;
      columnNameCounts.set(column.name, count + 1);

      // Extract naming conventions
      const parts = column.name.split('_');
      if (parts.length > 1) {
        columnSuffixes.add(parts[parts.length - 1]);
      }
    }

    for (const table of metadata.tables) {
      const parts = table.name.split('_');
      if (parts.length > 0) {
        tablePrefixes.add(parts[0]);
      }
    }

    const averageColumnsPerTable =
      metadata.tables.length > 0 ? metadata.columns.length / metadata.tables.length : 0;

    return {
      tableCount: metadata.tables.length,
      columnCount: metadata.columns.length,
      averageColumnsPerTable,
      commonColumnNames: columnNameCounts,
      commonTableNames: metadata.tables.map((t) => t.name),
      namingConventions: {
        tablePrefixes: Array.from(tablePrefixes),
        columnSuffixes: Array.from(columnSuffixes),
      },
    };
  }

  /**
   * Step 2: Learn from query examples.
   */
  async learnFromExamples(
    examples: TrainingExample[],
    ontology: Ontology,
  ): Promise<LearnedPatterns> {
    const logger = await getLogger();

    logger.info('[StructuredDataTrainer] Learning from examples', {
      examplesCount: examples.length,
    });

    const conceptUsageFrequency = new Map<string, number>();
    const propertyUsageFrequency = new Map<string, number>();
    const relationshipUsageFrequency = new Map<string, number>();
    const sqlPatterns: string[] = [];
    const queryToSQLMappings = new Map<string, string>();

    for (const example of examples) {
      // Count concept usage
      for (const concept of example.semanticPlan.concepts) {
        const count = conceptUsageFrequency.get(concept) || 0;
        conceptUsageFrequency.set(concept, count + 1);
      }

      // Count property usage
      for (const property of example.semanticPlan.properties) {
        const count = propertyUsageFrequency.get(property) || 0;
        propertyUsageFrequency.set(property, count + 1);
      }

      // Count relationship usage
      for (const rel of example.semanticPlan.relationships) {
        const key = `${rel.from}-${rel.type}-${rel.to}`;
        const count = relationshipUsageFrequency.get(key) || 0;
        relationshipUsageFrequency.set(key, count + 1);
      }

      // Collect SQL patterns
      sqlPatterns.push(example.executedSQL);

      // Map query to SQL
      queryToSQLMappings.set(example.naturalLanguageQuery, example.executedSQL);
    }

    return {
      conceptUsageFrequency,
      propertyUsageFrequency,
      relationshipUsageFrequency,
      sqlPatterns,
      queryToSQLMappings,
    };
  }

  /**
   * Step 3: Align concepts with schema.
   */
  async alignConceptsWithSchema(
    ontology: Ontology,
    metadata: DatasourceMetadata,
    patterns: SchemaPatterns,
    learnedPatterns: LearnedPatterns,
    languageModel: LanguageModel,
  ): Promise<AlignedOntology> {
    const logger = await getLogger();

    logger.info('[StructuredDataTrainer] Aligning concepts with schema', {
      conceptsCount: ontology.ontology.concepts.length,
    });

    const alignmentScores = new Map<string, number>();

    // Calculate alignment scores for each concept
    for (const concept of ontology.ontology.concepts) {
      // Base score from usage frequency
      const usageCount = learnedPatterns.conceptUsageFrequency.get(concept.id) || 0;
      const usageScore = Math.min(usageCount / 10, 1.0); // Normalize to 0-1

      // Schema alignment score (simplified)
      const schemaScore = this.calculateSchemaAlignment(concept, metadata, patterns);

      // Combined alignment score
      const alignmentScore = (usageScore * 0.6 + schemaScore * 0.4);
      alignmentScores.set(concept.id, alignmentScore);
    }

    logger.info('[StructuredDataTrainer] Alignment complete', {
      conceptsAligned: alignmentScores.size,
      averageScore: Array.from(alignmentScores.values()).reduce((a, b) => a + b, 0) / alignmentScores.size,
    });

    return {
      ...ontology,
      alignmentScores,
    };
  }

  /**
   * Step 4: Refine mappings.
   */
  async refineMappings(
    mappings: MappingResult,
    alignedOntology: AlignedOntology,
    examples: TrainingExample[],
    learnedPatterns: LearnedPatterns,
  ): Promise<RefinedMappings> {
    const logger = await getLogger();

    logger.info('[StructuredDataTrainer] Refining mappings', {
      mappingsCount: mappings.table_mappings.length,
    });

    const refinementScores = new Map<string, number>();

    // Calculate refinement scores for each mapping
    for (const tableMapping of mappings.table_mappings) {
      const conceptId = tableMapping.concept_id;
      const alignmentScore = alignedOntology.alignmentScores.get(conceptId) || 0.5;
      const usageCount = learnedPatterns.conceptUsageFrequency.get(conceptId) || 0;
      const usageScore = Math.min(usageCount / 5, 1.0);

      const refinementScore = (alignmentScore * 0.5 + usageScore * 0.5);
      const mappingKey = `${tableMapping.table_schema}.${tableMapping.table_name}`;
      refinementScores.set(mappingKey, refinementScore);
    }

    logger.info('[StructuredDataTrainer] Refinement complete', {
      mappingsRefined: refinementScores.size,
    });

    return {
      ...mappings,
      refinementScores,
    };
  }

  /**
   * Calculate schema alignment score for a concept.
   */
  private calculateSchemaAlignment(
    concept: { id: string; label: string },
    metadata: DatasourceMetadata,
    patterns: SchemaPatterns,
  ): number {
    // Simplified alignment: check if concept name matches table names
    const conceptLower = concept.id.toLowerCase();
    const matchingTables = metadata.tables.filter(
      (t) => t.name.toLowerCase().includes(conceptLower) || conceptLower.includes(t.name.toLowerCase()),
    );

    if (matchingTables.length > 0) {
      return 0.8; // Good alignment
    }

    // Check label similarity
    const labelLower = concept.label.toLowerCase();
    const matchingByLabel = metadata.tables.filter(
      (t) => t.name.toLowerCase().includes(labelLower) || labelLower.includes(t.name.toLowerCase()),
    );

    if (matchingByLabel.length > 0) {
      return 0.6; // Moderate alignment
    }

    return 0.3; // Low alignment
  }
}

// Singleton instance
let trainerInstance: StructuredDataTrainer | null = null;

export function getStructuredDataTrainer(): StructuredDataTrainer {
  if (!trainerInstance) {
    trainerInstance = new StructuredDataTrainer();
  }
  return trainerInstance;
}
