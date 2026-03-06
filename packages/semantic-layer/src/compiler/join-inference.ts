import type { DatasourceMetadata } from '@qwery/domain/entities';
import type { SemanticTableMapping, JoinPath } from './types';
import loggerModule from '@qwery/shared/logger';
import type { Logger } from '@qwery/shared/logger/logger';

type GetLoggerFn = () => Promise<Logger>;

const { getLogger } = loggerModule as { getLogger: GetLoggerFn };

export interface JoinInferenceOptions {
  tableMappings: SemanticTableMapping[];
  metadata: DatasourceMetadata;
  relationships: Array<{
    from: string;
    to: string;
    type: 'has_one' | 'has_many' | 'belongs_to' | 'many_to_many';
  }>;
}

export async function inferJoinPaths(
  options: JoinInferenceOptions,
): Promise<JoinPath[]> {
  const { tableMappings, metadata, relationships } = options;
  const logger = await getLogger();

  logger.info('[JoinInference] Starting join inference', {
    tableMappingsCount: tableMappings.length,
    relationshipsCount: relationships.length,
    tablesInMetadata: metadata.tables.length,
  });

  const joinPaths: JoinPath[] = [];

  const tableMap = new Map<string, SemanticTableMapping>();
  for (const mapping of tableMappings) {
    const key = `${mapping.table_schema}.${mapping.table_name}`;
    tableMap.set(key, mapping);
  }

  for (const rel of relationships) {
    logger.debug('[JoinInference] Processing relationship', {
      from: rel.from,
      to: rel.to,
      type: rel.type,
    });
    const fromMapping = tableMappings.find((m) => m.concept_id === rel.from);
    const toMapping = tableMappings.find((m) => m.concept_id === rel.to);

    if (!fromMapping || !toMapping) {
      logger.warn('[JoinInference] Missing mapping for relationship', {
        from: rel.from,
        to: rel.to,
      });
      continue;
    }

    const fromTable = metadata.tables.find(
      (t) =>
        t.schema === fromMapping.table_schema &&
        t.name === fromMapping.table_name,
    );
    const toTable = metadata.tables.find(
      (t) =>
        t.schema === toMapping.table_schema &&
        t.name === toMapping.table_name,
    );

    if (!fromTable || !toTable) {
      logger.warn('[JoinInference] Table not found in metadata', {
        fromTable: `${fromMapping.table_schema}.${fromMapping.table_name}`,
        toTable: `${toMapping.table_schema}.${toMapping.table_name}`,
      });
      continue;
    }

    let joinPath: JoinPath | null = null;

    if (rel.type === 'has_many' || rel.type === 'belongs_to') {
      const foreignKey = fromTable.relationships?.find(
        (fk) =>
          fk.target_table_schema === toTable.schema &&
          fk.target_table_name === toTable.name,
      );

      if (foreignKey) {
        logger.info('[JoinInference] Foreign key found', {
          fromTable: `${fromTable.schema}.${fromTable.name}`,
          toTable: `${toTable.schema}.${toTable.name}`,
          fromColumn: foreignKey.source_column_name,
          toColumn: foreignKey.target_column_name,
        });

        joinPath = {
          from_table: {
            schema: fromTable.schema,
            name: fromTable.name,
          },
          to_table: {
            schema: toTable.schema,
            name: toTable.name,
          },
          from_column: foreignKey.source_column_name,
          to_column: foreignKey.target_column_name,
          relationship_type: rel.type,
        };
      } else {
        const reverseForeignKey = toTable.relationships?.find(
          (fk) =>
            fk.target_table_schema === fromTable.schema &&
            fk.target_table_name === fromTable.name,
        );

        if (reverseForeignKey) {
          joinPath = {
            from_table: {
              schema: toTable.schema,
              name: toTable.name,
            },
            to_table: {
              schema: fromTable.schema,
              name: fromTable.name,
            },
            from_column: reverseForeignKey.source_column_name,
            to_column: reverseForeignKey.target_column_name,
            relationship_type: rel.type === 'has_many' ? 'belongs_to' : 'has_many',
          };
        }
      }
    } else if (rel.type === 'has_one') {
      const foreignKey = fromTable.relationships?.find(
        (fk) =>
          fk.target_table_schema === toTable.schema &&
          fk.target_table_name === toTable.name,
      );

      if (foreignKey) {
        joinPath = {
          from_table: {
            schema: fromTable.schema,
            name: fromTable.name,
          },
          to_table: {
            schema: toTable.schema,
            name: toTable.name,
          },
          from_column: foreignKey.source_column_name,
          to_column: foreignKey.target_column_name,
          relationship_type: 'has_one',
        };
      }
    }

    if (joinPath) {
      joinPaths.push(joinPath);
    } else {
      logger.warn('[JoinInference] No foreign key found for relationship', {
        from: rel.from,
        to: rel.to,
        fromTable: `${fromMapping.table_schema}.${fromMapping.table_name}`,
        toTable: `${toMapping.table_schema}.${toMapping.table_name}`,
      });
    }
  }

  logger.info('[JoinInference] Join inference complete', {
    joinPathsGenerated: joinPaths.length,
    joinPaths: joinPaths.map((jp) => ({
      from: `${jp.from_table.schema}.${jp.from_table.name}`,
      to: `${jp.to_table.schema}.${jp.to_table.name}`,
    })),
  });

  return joinPaths;
}
