import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { Ontology } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';
import { generateGraphInstructions, formatGraphInstructionsAsText } from './graph-instructions';
import { OntologyGraph } from './ontology-graph';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface GraphReasoningResult {
  identifiedConcepts: string[];
  relationshipPaths: Array<{
    from: string;
    to: string;
    path: string[];
    confidence: number;
  }>;
  reasoning: string;
}

/**
 * Use graph instructions to enhance LLM understanding for query planning.
 */
export class LLMGraphReasoner {
  /**
   * Reason over ontology graph using LLM with graph instructions.
   */
  async reasonOverGraph(
    query: string,
    ontology: Ontology,
    languageModel: LanguageModel,
  ): Promise<GraphReasoningResult> {
    const logger = await getLogger();

    logger.info('[LLMGraphReasoner] Starting graph reasoning', {
      queryLength: query.length,
      conceptsCount: ontology.ontology.concepts.length,
    });

    // Generate graph instructions
    const graphInstructions = generateGraphInstructions(ontology);
    const graphInstructionsText = formatGraphInstructionsAsText(graphInstructions);

    // Create graph-aware prompt
    const prompt = `You are a semantic query reasoner. Use the ontology graph structure to understand relationships and plan queries.

${graphInstructionsText}

User Query: "${query}"

Analyze the query and identify:
1. Which concepts from the graph are mentioned or implied
2. What relationships connect these concepts
3. What properties are needed

Return a JSON object:
{
  "concepts": ["Concept1", "Concept2"],
  "relationshipPaths": [
    {
      "from": "Concept1",
      "to": "Concept2",
      "path": ["Concept1", "Intermediate", "Concept2"],
      "confidence": 0.9
    }
  ],
  "reasoning": "Explanation of how you identified concepts and paths"
}`;

    try {
      const result = await generateText({
        model: languageModel,
        prompt,
        temperature: 0.1,
      });

      // Parse JSON response
      const jsonMatch = result.text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          concepts?: string[];
          relationshipPaths?: Array<{
            from: string;
            to: string;
            path: string[];
            confidence?: number;
          }>;
          reasoning?: string;
        };

        logger.info('[LLMGraphReasoner] Graph reasoning complete', {
          conceptsIdentified: parsed.concepts?.length || 0,
          pathsFound: parsed.relationshipPaths?.length || 0,
        });

        return {
          identifiedConcepts: parsed.concepts || [],
          relationshipPaths:
            parsed.relationshipPaths?.map((p) => ({
              from: p.from,
              to: p.to,
              path: p.path,
              confidence: p.confidence || 0.5,
            })) || [],
          reasoning: parsed.reasoning || '',
        };
      }
    } catch (error) {
      logger.warn('[LLMGraphReasoner] Graph reasoning failed, using fallback', {
        error: error instanceof Error ? error.message : String(error),
      });
    }

    // Fallback: use graph structure directly
    return this.fallbackReasoning(query, ontology);
  }

  /**
   * Fallback reasoning using graph structure without LLM.
   */
  private fallbackReasoning(query: string, ontology: Ontology): GraphReasoningResult {
    const graph = new OntologyGraph(ontology);
    const queryLower = query.toLowerCase();

    // Simple keyword matching
    const identifiedConcepts: string[] = [];
    for (const concept of ontology.ontology.concepts) {
      const conceptText = `${concept.id} ${concept.label} ${concept.description || ''}`.toLowerCase();
      if (conceptText.split(' ').some((word) => queryLower.includes(word))) {
        identifiedConcepts.push(concept.id);
      }
    }

    // Find paths between identified concepts
    const relationshipPaths: GraphReasoningResult['relationshipPaths'] = [];
    for (let i = 0; i < identifiedConcepts.length; i++) {
      for (let j = i + 1; j < identifiedConcepts.length; j++) {
        const from = identifiedConcepts[i]!;
        const to = identifiedConcepts[j]!;
        const path = graph.findShortestConceptPath(from, to);

        if (path) {
          relationshipPaths.push({
            from,
            to,
            path: path.nodes.map((n) => n.id),
            confidence: 0.7,
          });
        }
      }
    }

    return {
      identifiedConcepts,
      relationshipPaths,
      reasoning: `Identified ${identifiedConcepts.length} concepts and ${relationshipPaths.length} relationship paths using keyword matching.`,
    };
  }
}

let instance: LLMGraphReasoner | null = null;

export function getLLMGraphReasoner(): LLMGraphReasoner {
  if (!instance) {
    instance = new LLMGraphReasoner();
  }
  return instance;
}
