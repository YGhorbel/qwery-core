import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { AbstractConcept, AbstractRelationship } from '../models/ontology.schema';
import type { Concept, Relationship } from '../models/ontology.schema';
import type { LanguageModel } from 'ai';
import { generateText } from 'ai';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface AbstractLayer {
  concepts: AbstractConcept[];
  relationships: AbstractRelationship[];
  domain?: string;
}

/**
 * Extract abstract concepts from concrete concepts.
 * Abstract concepts represent business domain concepts independent of datasource.
 */
export async function extractAbstractConcepts(
  concepts: Concept[],
  languageModel?: LanguageModel,
): Promise<AbstractConcept[]> {
  const logger = await getLogger();

  logger.info('[AbstractLayer] Extracting abstract concepts', {
    conceptsCount: concepts.length,
  });

  const abstractConcepts: AbstractConcept[] = [];

  for (const concept of concepts) {
    // For now, convert directly - in full implementation, would use LLM to extract domain-agnostic concepts
    const abstractConcept: AbstractConcept = {
      id: concept.id,
      label: concept.label,
      description: concept.description,
      properties: concept.properties,
      relationships: concept.relationships.map((rel) => ({
        ...rel,
        cardinality: inferCardinality(rel.type),
      })),
      domain: await inferDomain(concept, languageModel),
      synonyms: await extractSynonyms(concept, languageModel),
    };

    abstractConcepts.push(abstractConcept);
  }

  logger.info('[AbstractLayer] Abstract concepts extracted', {
    abstractConceptsCount: abstractConcepts.length,
  });

  return abstractConcepts;
}

/**
 * Build abstract layer from multiple datasource ontologies.
 */
export async function buildAbstractLayer(
  datasourceOntologies: Array<{ datasourceId: string; concepts: Concept[] }>,
  languageModel?: LanguageModel,
): Promise<AbstractLayer> {
  const logger = await getLogger();

  logger.info('[AbstractLayer] Building unified abstract layer', {
    datasourcesCount: datasourceOntologies.length,
  });

  // Extract abstract concepts from each datasource
  const allAbstractConcepts = new Map<string, AbstractConcept>();

  for (const { datasourceId, concepts } of datasourceOntologies) {
    const abstractConcepts = await extractAbstractConcepts(concepts, languageModel);

    for (const abstractConcept of abstractConcepts) {
      // Merge concepts with same ID from different datasources
      const existing = allAbstractConcepts.get(abstractConcept.id);
      if (existing) {
        // Merge properties and relationships
        const mergedProperties = new Map<string, typeof abstractConcept.properties[0]>();
        for (const prop of existing.properties) {
          mergedProperties.set(prop.id, prop);
        }
        for (const prop of abstractConcept.properties) {
          mergedProperties.set(prop.id, prop);
        }

        existing.properties = Array.from(mergedProperties.values());
        // Merge relationships
        const mergedRels = new Map<string, AbstractRelationship>();
        for (const rel of existing.relationships) {
          mergedRels.set(`${rel.target}:${rel.type}`, rel);
        }
        for (const rel of abstractConcept.relationships) {
          mergedRels.set(`${rel.target}:${rel.type}`, rel);
        }
        existing.relationships = Array.from(mergedRels.values());
      } else {
        allAbstractConcepts.set(abstractConcept.id, abstractConcept);
      }
    }
  }

  // Extract relationships
  const relationships = new Map<string, AbstractRelationship>();
  for (const concept of allAbstractConcepts.values()) {
    for (const rel of concept.relationships) {
      const key = `${concept.id}:${rel.target}:${rel.type}`;
      if (!relationships.has(key)) {
        relationships.set(key, rel);
      }
    }
  }

  logger.info('[AbstractLayer] Abstract layer built', {
    conceptsCount: allAbstractConcepts.size,
    relationshipsCount: relationships.size,
  });

  return {
    concepts: Array.from(allAbstractConcepts.values()),
    relationships: Array.from(relationships.values()),
  };
}

function inferCardinality(
  type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many',
): 'one' | 'many' {
  if (type === 'has_one' || type === 'belongs_to') {
    return 'one';
  }
  return 'many';
}

async function inferDomain(concept: Concept, languageModel?: LanguageModel): Promise<string | undefined> {
  if (!languageModel) {
    return undefined;
  }

  try {
    const result = await generateText({
      model: languageModel,
      prompt: `What business domain does this concept belong to? Concept: ${concept.id} - ${concept.label}. ${concept.description || ''}

Return only the domain name (e.g., "E-commerce", "CRM", "Finance").`,
      temperature: 0.1,
    });

    return result.text.trim() || undefined;
  } catch (error) {
    return undefined;
  }
}

async function extractSynonyms(concept: Concept, languageModel?: LanguageModel): Promise<string[]> {
  if (!languageModel) {
    return [];
  }

  try {
    const result = await generateText({
      model: languageModel,
      prompt: `Generate synonyms for this concept: ${concept.id} - ${concept.label}. ${concept.description || ''}

Return a JSON array of synonyms: ["synonym1", "synonym2"]`,
      temperature: 0.2,
    });

    const jsonMatch = result.text.match(/\[[\s\S]*\]/);
    if (jsonMatch) {
      return JSON.parse(jsonMatch[0]) as string[];
    }
  } catch (error) {
    // Fallback to empty array
  }

  return [];
}
