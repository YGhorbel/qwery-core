import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { AbstractConcept } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface ConceptAlignment {
  sourceConceptId: string;
  targetConceptId: string;
  confidence: number;
  alignmentType: 'exact' | 'semantic' | 'partial';
  mergedConcept?: AbstractConcept;
}

/**
 * Align concepts from different datasources.
 * Uses semantic matching to identify equivalent concepts.
 */
export async function alignConcepts(
  concepts: Array<{
    datasourceId: string;
    concepts: AbstractConcept[];
  }>,
  languageModel?: LanguageModel,
): Promise<ConceptAlignment[]> {
  const logger = await getLogger();

  logger.info('[ConceptAligner] Aligning concepts across datasources', {
    datasourcesCount: concepts.length,
    totalConcepts: concepts.reduce((sum, ds) => sum + ds.concepts.length, 0),
  });

  const alignments: ConceptAlignment[] = [];

  // Compare concepts from different datasources
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const sourceDs = concepts[i]!;
      const targetDs = concepts[j]!;

      for (const sourceConcept of sourceDs.concepts) {
        for (const targetConcept of targetDs.concepts) {
          const alignment = await matchConcepts(
            sourceConcept,
            targetConcept,
            sourceDs.datasourceId,
            targetDs.datasourceId,
            languageModel,
          );

          if (alignment) {
            alignments.push(alignment);
          }
        }
      }
    }
  }

  logger.info('[ConceptAligner] Concept alignment complete', {
    alignmentsCount: alignments.length,
    exactMatches: alignments.filter((a) => a.alignmentType === 'exact').length,
    semanticMatches: alignments.filter((a) => a.alignmentType === 'semantic').length,
  });

  return alignments;
}

/**
 * Match two concepts and determine if they represent the same entity.
 */
async function matchConcepts(
  sourceConcept: AbstractConcept,
  targetConcept: AbstractConcept,
  sourceDatasourceId: string,
  targetDatasourceId: string,
  languageModel?: LanguageModel,
): Promise<ConceptAlignment | null> {
  // Exact match
  if (sourceConcept.id === targetConcept.id) {
    return {
      sourceConceptId: sourceConcept.id,
      targetConceptId: targetConcept.id,
      confidence: 1.0,
      alignmentType: 'exact',
    };
  }

  // Label similarity
  const labelSimilarity = calculateLabelSimilarity(sourceConcept.label, targetConcept.label);
  if (labelSimilarity > 0.9) {
    return {
      sourceConceptId: sourceConcept.id,
      targetConceptId: targetConcept.id,
      confidence: labelSimilarity,
      alignmentType: 'semantic',
    };
  }

  // Semantic similarity using LLM
  if (languageModel && labelSimilarity > 0.5) {
    try {
      const semanticScore = await calculateSemanticConceptSimilarity(
        sourceConcept,
        targetConcept,
        languageModel,
      );

      if (semanticScore > 0.7) {
        return {
          sourceConceptId: sourceConcept.id,
          targetConceptId: targetConcept.id,
          confidence: semanticScore,
          alignmentType: 'semantic',
        };
      }
    } catch (error) {
      // Fallback to label similarity
    }
  }

  // No match
  return null;
}

function calculateLabelSimilarity(label1: string, label2: string): number {
  const l1 = label1.toLowerCase();
  const l2 = label2.toLowerCase();

  if (l1 === l2) {
    return 1.0;
  }

  // Check if one contains the other
  if (l1.includes(l2) || l2.includes(l1)) {
    return 0.8;
  }

  // Levenshtein distance
  const distance = levenshteinDistance(l1, l2);
  const maxLen = Math.max(l1.length, l2.length);
  return 1 - distance / maxLen;
}

async function calculateSemanticConceptSimilarity(
  concept1: AbstractConcept,
  concept2: AbstractConcept,
  languageModel: LanguageModel,
): Promise<number> {
  try {
    const result = await generateText({
      model: languageModel,
      prompt: `Do these two concepts represent the same business entity?

Concept 1: ${concept1.id} - ${concept1.label}
${concept1.description || ''}

Concept 2: ${concept2.id} - ${concept2.label}
${concept2.description || ''}

Respond with a JSON object: {"same": true/false, "confidence": 0.0-1.0}`,
      temperature: 0.1,
    });

    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as { same?: boolean; confidence?: number };
      if (parsed.same && parsed.confidence) {
        return parsed.confidence;
      }
    }
  } catch (error) {
    // Fallback
  }

  return 0.0;
}

function levenshteinDistance(str1: string, str2: string): number {
  const matrix: number[][] = [];

  for (let i = 0; i <= str2.length; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= str1.length; j++) {
    matrix[0]![j] = j;
  }

  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i]![j] = matrix[i - 1]![j - 1]!;
      } else {
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j - 1]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j]! + 1,
        );
      }
    }
  }

  return matrix[str2.length]![str1.length]!;
}
