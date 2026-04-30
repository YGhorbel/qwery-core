/**
 * Embeds all fields from semantic_layer.yaml into the pgvector term_index table.
 * Run after Phase 3 pipeline completes (agents 01–08).
 */
import type { VectorStore, Embedder, TermIndexRecord } from '@qwery/vector-store';
import type { SemanticLayer } from '../types.js';

import type { FieldMetadata } from '@qwery/vector-store';

function buildIndexedText(field: FieldMetadata): string {
  return [
    field.label,
    field.description,
    field.when_to_use ? `When to use: ${field.when_to_use}` : '',
    field.synonyms?.length ? `Also known as: ${field.synonyms.join(', ')}` : '',
    field.table ? `Table: ${field.table}` : '',
    field.filters?.length ? `Always apply: ${field.filters.join('; ')}` : '',
    field.sql ? `SQL expression: ${field.sql}` : '',
  ]
    .filter(Boolean)
    .join('. ');
}

export async function embedSemanticLayer(
  datasourceId: string,
  semanticLayer: SemanticLayer,
  vectorStore: VectorStore,
  embedder: Embedder,
): Promise<void> {
  const records: TermIndexRecord[] = [];

  for (const [fieldId, measure] of Object.entries(semanticLayer.measures ?? {})) {
    records.push({
      id: `${datasourceId}::${fieldId}`,
      datasource_id: datasourceId,
      embedding: [],
      metadata: {
        field_id: fieldId,
        label: measure.label,
        type: 'measure',
        table: measure.table,
        sql: measure.sql,
        filters: measure.filters,
        format: measure.format,
        description: measure.description,
        synonyms: measure.synonyms,
        when_to_use: measure.when_to_use,
      },
    });
  }

  for (const [fieldId, dim] of Object.entries(semanticLayer.dimensions ?? {})) {
    records.push({
      id: `${datasourceId}::${fieldId}`,
      datasource_id: datasourceId,
      embedding: [],
      metadata: {
        field_id: fieldId,
        label: dim.label,
        type: 'dimension',
        table: dim.table,
        sql: dim.sql,
        description: '',
        synonyms: dim.synonyms,
      },
    });
  }

  for (const [ruleId, rule] of Object.entries(semanticLayer.business_rules ?? {})) {
    records.push({
      id: `${datasourceId}::${ruleId}`,
      datasource_id: datasourceId,
      embedding: [],
      metadata: {
        field_id: ruleId,
        label: rule.label,
        type: 'business_rule',
        table: rule.table,
        sql: rule.sql,
        description: rule.description,
        synonyms: rule.synonyms,
      },
    });
  }

  if (records.length === 0) return;

  const texts = records.map((r) => buildIndexedText(r.metadata));

  const embeddings = await embedder.embedBatch(texts, 'document');
  records.forEach((r, i) => {
    r.embedding = embeddings[i]!;
  });

  await vectorStore.deleteByDatasource(datasourceId);
  await vectorStore.upsertBatch(records);
}
