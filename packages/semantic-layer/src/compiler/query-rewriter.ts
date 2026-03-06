import type { DatasourceMetadata } from '@qwery/domain/entities';
import type {
  SemanticPlan,
  SemanticTableMapping,
  JoinPath,
  CompiledQuery,
} from './types';
import type { Ontology } from '../models/ontology.schema';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface QueryRewriteOptions {
  semanticPlan: SemanticPlan;
  tableMappings: SemanticTableMapping[];
  joinPaths: JoinPath[];
  metadata?: DatasourceMetadata; // Optional - prefer ontology
  ontology?: Ontology; // Use ontology for property types
}

export async function rewriteSemanticPlanToSQL(
  options: QueryRewriteOptions,
): Promise<CompiledQuery> {
  const { semanticPlan, tableMappings, joinPaths, metadata, ontology } = options;
  const logger = await getLogger();

  logger.info('[QueryRewriter] Starting SQL generation', {
    concepts: semanticPlan.concepts,
    properties: semanticPlan.properties,
    aggregationsCount: semanticPlan.aggregations?.length || 0,
    filtersCount: semanticPlan.filters?.length || 0,
  });

  const parameters: unknown[] = [];
  let paramIndex = 1;

  const tableAliases = new Map<string, string>();
  let aliasIndex = 1;

  for (const mapping of tableMappings) {
    const key = `${mapping.table_schema}.${mapping.table_name}`;
    if (!tableAliases.has(key)) {
      tableAliases.set(key, `t${aliasIndex++}`);
    }
  }

  const selectParts: string[] = [];
  const fromParts: string[] = [];
  const joinParts: string[] = [];
  const whereParts: string[] = [];
  const groupByParts: string[] = [];
  const orderByParts: string[] = [];

  const primaryTable = tableMappings[0];
  if (!primaryTable) {
    throw new Error('No table mappings found');
  }

  // Validate table exists in metadata if provided
  if (metadata) {
    const actualTable = metadata.tables.find(
      (t) => t.schema === primaryTable.table_schema && t.name === primaryTable.table_name,
    );
    if (!actualTable) {
      throw new Error(
        `Table ${primaryTable.table_schema}.${primaryTable.table_name} not found in schema`,
      );
    }
    // Use actual table name from schema
    logger.debug('[QueryRewriter] Validated primary table', {
      mapping: `${primaryTable.table_schema}.${primaryTable.table_name}`,
      actual: `${actualTable.schema}.${actualTable.name}`,
    });
  }

  const primaryTableKey = `${primaryTable.table_schema}.${primaryTable.table_name}`;
  const primaryAlias = tableAliases.get(primaryTableKey)!;

  fromParts.push(
    `"${primaryTable.table_schema}"."${primaryTable.table_name}" AS ${primaryAlias}`,
  );

  for (const property of semanticPlan.properties) {
    const [conceptId, propertyId] = property.split('.');
    const mapping = tableMappings.find((m) => m.concept_id === conceptId);

    if (!mapping) {
      logger.warn('[QueryRewriter] No mapping found for concept', {
        conceptId,
        property,
      });
      continue;
    }

    const columnMapping = mapping.column_mappings.find(
      (cm) => cm.property_id === property,
    );

    if (!columnMapping) {
      logger.warn('[QueryRewriter] No column mapping found for property', {
        property,
        conceptId,
      });
      continue;
    }

    // Validate column exists in metadata if provided
    if (metadata) {
      const table = metadata.tables.find(
        (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
      );
      if (table) {
        const column = metadata.columns.find(
          (c) =>
            c.schema === mapping.table_schema &&
            c.table === mapping.table_name &&
            c.name === columnMapping.column_name,
        );
        if (!column) {
          logger.warn('[QueryRewriter] Column not found in schema', {
            column: columnMapping.column_name,
            table: `${mapping.table_schema}.${mapping.table_name}`,
            availableColumns: metadata.columns
              .filter((c) => c.schema === mapping.table_schema && c.table === mapping.table_name)
              .map((c) => c.name)
              .slice(0, 5),
          });
          continue;
        }
        // Use actual column name from schema
        logger.debug('[QueryRewriter] Validated column', {
          mapping: columnMapping.column_name,
          actual: column.name,
        });
      }
    }

    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    const alias = tableAliases.get(tableKey)!;

    logger.debug('[QueryRewriter] Property mapped', {
      property,
      column: `${mapping.table_schema}.${mapping.table_name}.${columnMapping.column_name}`,
    });

    selectParts.push(
      `${alias}."${columnMapping.column_name}" AS "${property}"`,
    );
  }

  if (semanticPlan.aggregations && semanticPlan.aggregations.length > 0) {
    logger.debug('[QueryRewriter] Processing aggregations', {
      aggregations: semanticPlan.aggregations.map((a) => ({
        property: a.property,
        function: a.function,
        alias: a.alias,
      })),
    });
  }

  for (const agg of semanticPlan.aggregations) {
    const [conceptId, propertyId] = agg.property.split('.');
    const mapping = tableMappings.find((m) => m.concept_id === conceptId);

    if (!mapping) {
      logger.warn('[QueryRewriter] No mapping found for aggregation concept', {
        conceptId,
        property: agg.property,
      });
      continue;
    }

    const columnMapping = mapping.column_mappings.find(
      (cm) => cm.property_id === agg.property,
    );

    if (!columnMapping) {
      logger.warn(
        '[QueryRewriter] No column mapping found for aggregation property',
        {
          property: agg.property,
        },
      );
      continue;
    }

    // Validate column exists in metadata if provided
    if (metadata) {
      const table = metadata.tables.find(
        (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
      );
      if (table) {
        const column = metadata.columns.find(
          (c) =>
            c.schema === mapping.table_schema &&
            c.table === mapping.table_name &&
            c.name === columnMapping.column_name,
        );
        if (!column) {
          logger.warn('[QueryRewriter] Aggregation column not found in schema', {
            column: columnMapping.column_name,
            table: `${mapping.table_schema}.${mapping.table_name}`,
          });
          continue;
        }
      }
    }

    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    const alias = tableAliases.get(tableKey)!;

    const aggFunction = agg.function.toUpperCase();
    const aliasName = agg.alias || `${agg.function}_${propertyId}`;
    selectParts.push(
      `${aggFunction}(${alias}."${columnMapping.column_name}") AS "${aliasName}"`,
    );
  }

  for (const joinPath of joinPaths) {
    const fromKey = `${joinPath.from_table.schema}.${joinPath.from_table.name}`;
    const toKey = `${joinPath.to_table.schema}.${joinPath.to_table.name}`;

    const fromAlias = tableAliases.get(fromKey);
    const toAlias = tableAliases.get(toKey);

    if (!fromAlias || !toAlias) {
      continue;
    }

    if (fromAlias === primaryAlias) {
      joinParts.push(
        `LEFT JOIN "${joinPath.to_table.schema}"."${joinPath.to_table.name}" AS ${toAlias} ON ${fromAlias}."${joinPath.from_column}" = ${toAlias}."${joinPath.to_column}"`,
      );
    } else if (toAlias === primaryAlias) {
      joinParts.push(
        `LEFT JOIN "${joinPath.from_table.schema}"."${joinPath.from_table.name}" AS ${fromAlias} ON ${toAlias}."${joinPath.to_column}" = ${fromAlias}."${joinPath.from_column}"`,
      );
    } else {
      const fromTableInFrom = fromParts.some((f) => f.includes(fromAlias));
      if (fromTableInFrom) {
        joinParts.push(
          `LEFT JOIN "${joinPath.to_table.schema}"."${joinPath.to_table.name}" AS ${toAlias} ON ${fromAlias}."${joinPath.from_column}" = ${toAlias}."${joinPath.to_column}"`,
        );
      } else {
        joinParts.push(
          `LEFT JOIN "${joinPath.from_table.schema}"."${joinPath.from_table.name}" AS ${fromAlias} ON ${toAlias}."${joinPath.to_column}" = ${fromAlias}."${joinPath.from_column}"`,
        );
      }
    }
  }

  for (const filter of semanticPlan.filters) {
    const [conceptId] = filter.property.split('.');
    const mapping = tableMappings.find((m) => m.concept_id === conceptId);

    if (!mapping) {
      logger.warn('[QueryRewriter] No mapping found for filter concept', {
        conceptId,
        property: filter.property,
      });
      continue;
    }

    const columnMapping = mapping.column_mappings.find(
      (cm) => cm.property_id === filter.property,
    );

    if (!columnMapping) {
      logger.warn('[QueryRewriter] No column mapping found for filter property', {
        property: filter.property,
      });
      continue;
    }

    // Validate column exists in metadata if provided
    if (metadata) {
      const table = metadata.tables.find(
        (t) => t.schema === mapping.table_schema && t.name === mapping.table_name,
      );
      if (table) {
        const column = metadata.columns.find(
          (c) =>
            c.schema === mapping.table_schema &&
            c.table === mapping.table_name &&
            c.name === columnMapping.column_name,
        );
        if (!column) {
          logger.warn('[QueryRewriter] Filter column not found in schema', {
            column: columnMapping.column_name,
            table: `${mapping.table_schema}.${mapping.table_name}`,
          });
          continue;
        }
      }
    }

    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    const alias = tableAliases.get(tableKey)!;

    if (filter.operator === 'IN' || filter.operator === 'NOT IN') {
      const values = Array.isArray(filter.value) ? filter.value : [filter.value];
      const placeholders = values
        .map((value) => {
          parameters.push(value);
          return `$${paramIndex++}`;
        })
        .join(', ');
      whereParts.push(
        `${alias}."${columnMapping.column_name}" ${filter.operator} (${placeholders})`,
      );
    } else {
      parameters.push(filter.value);
      whereParts.push(
        `${alias}."${columnMapping.column_name}" ${filter.operator} $${paramIndex++}`,
      );
    }
  }

  for (const groupByProp of semanticPlan.groupBy) {
    const [conceptId] = groupByProp.split('.');
    const mapping = tableMappings.find((m) => m.concept_id === conceptId);

    if (!mapping) {
      continue;
    }

    const columnMapping = mapping.column_mappings.find(
      (cm) => cm.property_id === groupByProp,
    );

    if (!columnMapping) {
      continue;
    }

    const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
    const alias = tableAliases.get(tableKey)!;

    groupByParts.push(`${alias}."${columnMapping.column_name}"`);
  }

  for (const order of semanticPlan.ordering) {
    if (order.property.includes('.')) {
      const [conceptId] = order.property.split('.');
      const mapping = tableMappings.find((m) => m.concept_id === conceptId);

      if (mapping) {
        const columnMapping = mapping.column_mappings.find(
          (cm) => cm.property_id === order.property,
        );

        if (columnMapping) {
          const tableKey = `${mapping.table_schema}.${mapping.table_name}`;
          const alias = tableAliases.get(tableKey)!;
          orderByParts.push(
            `${alias}."${columnMapping.column_name}" ${order.direction}`,
          );
        }
      }
    } else {
      const agg = semanticPlan.aggregations.find((a) => a.alias === order.property);
      if (agg) {
        const aliasName = agg.alias || `${agg.function}_${order.property.split('.')[1]}`;
        orderByParts.push(`"${aliasName}" ${order.direction}`);
      } else {
        orderByParts.push(`"${order.property}" ${order.direction}`);
      }
    }
  }

  if (selectParts.length === 0) {
    selectParts.push(`${primaryAlias}.*`);
  }

  let sql = `SELECT ${selectParts.join(', ')}\n`;
  sql += `FROM ${fromParts.join(', ')}\n`;

  if (joinParts.length > 0) {
    sql += joinParts.join('\n') + '\n';
  }

  if (whereParts.length > 0) {
    sql += `WHERE ${whereParts.join(' AND ')}\n`;
  }

  if (groupByParts.length > 0) {
    sql += `GROUP BY ${groupByParts.join(', ')}\n`;
  }

  if (orderByParts.length > 0) {
    sql += `ORDER BY ${orderByParts.join(', ')}\n`;
  }

  if (semanticPlan.limit) {
    sql += `LIMIT ${semanticPlan.limit}\n`;
  }

  const finalSql = sql.trim();

  logger.info('[QueryRewriter] SQL generated', {
    sqlLength: finalSql.length,
    hasJoins: joinPaths.length > 0,
    hasAggregations: semanticPlan.aggregations && semanticPlan.aggregations.length > 0,
    hasFilters: semanticPlan.filters && semanticPlan.filters.length > 0,
    sqlPreview: finalSql.substring(0, 200),
  });

  return {
    sql: finalSql,
    parameters,
    table_mappings: tableMappings,
    join_paths: joinPaths,
  };
}
