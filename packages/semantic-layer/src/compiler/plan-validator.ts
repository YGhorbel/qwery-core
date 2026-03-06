import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { SemanticPlan } from './types';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { Ontology } from '../models/ontology.schema';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export async function validateSemanticPlan(
  plan: SemanticPlan,
  ontology: Ontology,
  metadata: DatasourceMetadata,
): Promise<ValidationResult> {
  const logger = await getLogger();
  const errors: string[] = [];
  const warnings: string[] = [];

  logger.debug('[PlanValidator] Validating semantic plan', {
    concepts: plan.concepts,
    properties: plan.properties,
  });

  const ontologyConceptIds = new Set(ontology.ontology.concepts.map((c) => c.id));
  const ontologyPropertyIds = new Set<string>();
  
  for (const concept of ontology.ontology.concepts) {
    if (concept.properties) {
      for (const prop of concept.properties) {
        ontologyPropertyIds.add(prop.id);
      }
    }
  }

  for (const conceptId of plan.concepts) {
    if (!ontologyConceptIds.has(conceptId)) {
      errors.push(`Concept "${conceptId}" not found in ontology`);
    }
  }

  for (const propertyId of plan.properties || []) {
    if (!ontologyPropertyIds.has(propertyId)) {
      warnings.push(`Property "${propertyId}" not found in ontology`);
    }
  }

  if (plan.filters && plan.filters.length > 0) {
    for (const filter of plan.filters) {
      if (filter.property && !plan.properties?.includes(filter.property)) {
        warnings.push(
          `Filter references property "${filter.property}" that is not in the plan`,
        );
      }
    }
  }

  if (plan.aggregations && plan.aggregations.length > 0) {
    for (const agg of plan.aggregations) {
      if (agg.property && !plan.properties?.includes(agg.property)) {
        warnings.push(
          `Aggregation references property "${agg.property}" that is not in the plan`,
        );
      }
    }
  }

  if (plan.concepts.length === 0) {
    errors.push('Semantic plan must include at least one concept');
  }

  const result: ValidationResult = {
    valid: errors.length === 0,
    errors,
    warnings,
  };

  if (result.valid) {
    logger.debug('[PlanValidator] Plan validation passed', {
      warningsCount: warnings.length,
    });
  } else {
    logger.warn('[PlanValidator] Plan validation failed', {
      errorsCount: errors.length,
      errors,
    });
  }

  return result;
}

export function validateColumnExists(
  columnName: string,
  tableName: string,
  metadata: DatasourceMetadata,
): boolean {
  const table = metadata.tables.find(
    (t) => t.name === tableName || `${t.schema}.${t.name}` === tableName,
  );

  if (!table) {
    return false;
  }

  return table.columns?.some((c) => c.name === columnName) ?? false;
}

export function validateTableExists(
  tableName: string,
  metadata: DatasourceMetadata,
): boolean {
  return metadata.tables.some(
    (t) => t.name === tableName || `${t.schema}.${t.name}` === tableName,
  );
}
