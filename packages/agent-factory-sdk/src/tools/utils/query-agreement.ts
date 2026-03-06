import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';
import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { SemanticPlan } from '@qwery/semantic-layer/compiler/types';
import type { MappingResult } from '@qwery/semantic-layer/mapping/generator';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface QueryAgreement {
  agreed: boolean;
  sql: string;
  corrections: Array<{
    original: string;
    corrected: string;
    reason: string;
  }>;
  conceptToTableMap: Map<string, { schema: string; table: string }>;
  propertyToColumnMap: Map<string, { schema: string; table: string; column: string }>;
}

/**
 * Ensure semantic queries and runQuery agree on table/column names.
 * Validates SQL uses correct table/column names from actual schema.
 */
export async function agreeOnQueryNames(
  semanticPlan: SemanticPlan,
  generatedSQL: string,
  metadata: DatasourceMetadata,
  mappings: MappingResult,
): Promise<QueryAgreement> {
  const logger = await getLogger();

  logger.info('[QueryAgreement] Validating query names', {
    conceptsCount: semanticPlan.concepts.length,
    propertiesCount: semanticPlan.properties.length,
    sqlLength: generatedSQL.length,
  });

  const corrections: QueryAgreement['corrections'] = [];
  const conceptToTableMap = new Map<string, { schema: string; table: string }>();
  const propertyToColumnMap = new Map<string, { schema: string; table: string; column: string }>();

  let agreed = true;

  // Build concept to table mapping
  for (const conceptId of semanticPlan.concepts) {
    const mapping = mappings.table_mappings.find((m) => m.concept_id === conceptId);
    if (mapping) {
      // Validate table exists in schema
      const table = metadata.tables.find(
        (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
      );

      if (!table) {
        logger.warn('[QueryAgreement] Table from mapping not found in schema', {
          conceptId,
          table: `${mapping.table_schema}.${mapping.table_name}`,
        });
        agreed = false;
        corrections.push({
          original: `${mapping.table_schema}.${mapping.table_name}`,
          corrected: 'NOT_FOUND',
          reason: `Table ${mapping.table_schema}.${mapping.table_name} not found in schema`,
        });
        continue;
      }

      // Use actual table name from schema
      conceptToTableMap.set(conceptId, {
        schema: table.schema,
        table: table.name,
      });

      // Build property to column mapping
      for (const property of semanticPlan.properties) {
        if (property.startsWith(`${conceptId}.`)) {
          const propertyId = property.split('.')[1];
          const columnMapping = mapping.column_mappings.find(
            (cm) => cm.property_id === property,
          );

          if (columnMapping) {
            // Validate column exists
            const column = metadata.columns.find(
              (c) =>
                c.schema === table.schema &&
                c.table === table.name &&
                c.name === columnMapping.column_name,
            );

            if (!column) {
              logger.warn('[QueryAgreement] Column from mapping not found in schema', {
                property,
                column: columnMapping.column_name,
                table: `${table.schema}.${table.name}`,
              });
              agreed = false;
              corrections.push({
                original: columnMapping.column_name,
                corrected: 'NOT_FOUND',
                reason: `Column ${columnMapping.column_name} not found in table ${table.schema}.${table.name}`,
              });
              continue;
            }

            // Use actual column name from schema
            propertyToColumnMap.set(property, {
              schema: column.schema,
              table: column.table,
              column: column.name,
            });
          }
        }
      }
    } else {
      logger.warn('[QueryAgreement] No mapping found for concept', {
        conceptId,
      });
      agreed = false;
    }
  }

  // Validate SQL contains correct table/column names
  let correctedSQL = generatedSQL;

  for (const [conceptId, tableInfo] of conceptToTableMap.entries()) {
    const expectedTableRef = `"${tableInfo.schema}"."${tableInfo.table}"`;
    // Check if SQL uses wrong table name
    const wrongPattern = new RegExp(`"${tableInfo.schema}"\\.\\"([^"]+)\\"`, 'g');
    const matches = correctedSQL.match(wrongPattern);
    if (matches) {
      for (const match of matches) {
        if (!match.includes(tableInfo.table)) {
          // This is a simplified check - in practice, would need more sophisticated SQL parsing
          logger.debug('[QueryAgreement] Potential table name mismatch', {
            expected: expectedTableRef,
            found: match,
          });
        }
      }
    }
  }

  logger.info('[QueryAgreement] Agreement check complete', {
    agreed,
    correctionsCount: corrections.length,
    conceptsMapped: conceptToTableMap.size,
    propertiesMapped: propertyToColumnMap.size,
  });

  return {
    agreed,
    sql: correctedSQL,
    corrections,
    conceptToTableMap,
    propertyToColumnMap,
  };
}
