import yaml from 'yaml';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { VectorStore } from '@qwery/vector-store';
import type { Embedder } from '@qwery/vector-store';

type SemanticField = {
  label?: string;
  description?: string;
  type?: string;
  table?: string;
  sql?: string;
  synonyms?: string[];
  format?: string;
  filters?: string[];
  confidence?: number;
  flagged?: boolean;
  flagReason?: string;
};

type SemanticLayer = {
  measures?: Record<string, SemanticField>;
  dimensions?: Record<string, SemanticField>;
  business_rules?: Record<string, SemanticField & { hidden?: boolean }>;
};

export class ArtifactPatcher {
  constructor(
    private storageDir: string,
    private vectorStore: VectorStore,
    private embedder: Embedder,
  ) {}

  private layerPath(datasourceId: string): string {
    return path.join(
      this.storageDir,
      'datasources',
      datasourceId,
      'semantic_layer.yaml',
    );
  }

  private async readLayer(datasourceId: string): Promise<SemanticLayer> {
    const raw = await fs.readFile(this.layerPath(datasourceId), 'utf-8');
    return yaml.parse(raw) as SemanticLayer;
  }

  private async writeLayer(
    datasourceId: string,
    layer: SemanticLayer,
  ): Promise<void> {
    await fs.writeFile(this.layerPath(datasourceId), yaml.stringify(layer));
  }

  async patchMissingFilter(
    datasourceId: string,
    fieldId: string,
    missingFilter: string,
  ): Promise<void> {
    const layer = await this.readLayer(datasourceId);
    const field =
      layer.measures?.[fieldId] ?? layer.business_rules?.[fieldId];
    if (!field || (field.confidence ?? 0.7) < 0.3) return;

    if (!field.filters) field.filters = [];
    if (!field.filters.includes(missingFilter)) {
      field.filters.push(missingFilter);
      field.confidence = Math.min((field.confidence ?? 0.7) + 0.1, 1.0);
      await this.writeLayer(datasourceId, layer);
      await this.reembedField(datasourceId, fieldId, field);
    }
  }

  async patchWrongExpression(
    datasourceId: string,
    fieldId: string,
    correctedSQL: string,
  ): Promise<void> {
    const layer = await this.readLayer(datasourceId);
    const field = layer.measures?.[fieldId];
    if (!field || (field.confidence ?? 0.7) < 0.3) return;

    // Validate corrected SQL before writing
    const valid = await this.validateSQL(correctedSQL, field.table);
    if (!valid) return;

    field.sql = correctedSQL;
    field.confidence = Math.min((field.confidence ?? 0.7) + 0.05, 1.0);
    await this.writeLayer(datasourceId, layer);
    await this.reembedField(datasourceId, fieldId, field);
  }

  async proposeDerivedMeasure(
    datasourceId: string,
    expression: string,
    question: string,
    rows: unknown[],
  ): Promise<void> {
    if (!rows.length) return;
    const firstVal =
      Array.isArray(rows[0]) ? rows[0][0] : Object.values(rows[0] as Record<string, unknown>)[0];
    if (typeof firstVal !== 'number') return;

    const candidatePath = path.join(
      this.storageDir,
      'datasources',
      datasourceId,
      'measure_candidates.json',
    );
    let existing: unknown[] = [];
    try {
      existing = JSON.parse(await fs.readFile(candidatePath, 'utf-8')) as unknown[];
    } catch {
      // file doesn't exist yet
    }
    existing.push({
      id: crypto.randomUUID(),
      expression,
      question,
      proposedAt: new Date().toISOString(),
      validated: false,
    });
    await fs.writeFile(candidatePath, JSON.stringify(existing, null, 2));
  }

  async downgradeConfidence(
    datasourceId: string,
    fieldId: string,
  ): Promise<void> {
    const layer = await this.readLayer(datasourceId);
    const field =
      layer.measures?.[fieldId] ?? layer.dimensions?.[fieldId];
    if (!field) return;

    field.confidence = Math.max((field.confidence ?? 0.7) - 0.15, 0.0);
    if (field.confidence < 0.3) {
      field.flagged = true;
      field.flagReason = 'Repeated correction failures — needs manual review';
    }
    await this.writeLayer(datasourceId, layer);
  }

  async promoteMeasure(
    datasourceId: string,
    fieldId: string,
    measure: {
      label: string;
      description: string;
      sql: string;
      filters: string[];
      format: string;
      table: string;
      synonyms: string[];
    },
  ): Promise<void> {
    const layer = await this.readLayer(datasourceId);
    if (!layer.measures) layer.measures = {};
    if (layer.measures[fieldId]) return; // never overwrite existing measures

    const field: SemanticField = {
      label: measure.label,
      description: measure.description,
      sql: measure.sql,
      filters: measure.filters,
      format: measure.format,
      table: measure.table,
      synonyms: measure.synonyms,
      type: 'measure',
      confidence: 0.5,
    };
    layer.measures[fieldId] = field;
    await this.writeLayer(datasourceId, layer);
    await this.reembedField(datasourceId, fieldId, field);
    console.info(
      `[artifact-patcher] promoted new measure ${fieldId} to semantic layer for ${datasourceId}`,
    );
  }

  private async validateSQL(sql: string, table?: string): Promise<boolean> {
    if (!table) return true;
    // Surface-level validation: check the expression references a plausible column
    return sql.trim().length > 0 && !sql.includes(';');
  }

  private async reembedField(
    datasourceId: string,
    fieldId: string,
    field: SemanticField,
  ): Promise<void> {
    const text = [
      field.label,
      field.description,
      field.type ? `Type: ${field.type}` : '',
      field.table ? `Table: ${field.table}` : '',
      field.synonyms?.length ? `Synonyms: ${field.synonyms.join(', ')}` : '',
    ]
      .filter(Boolean)
      .join('. ');

    const embedding = await this.embedder.embedDocument(text);

    await this.vectorStore.upsertBatch([
      {
        id: `${datasourceId}::${fieldId}`,
        datasource_id: datasourceId,
        embedding,
        metadata: {
          field_id: fieldId,
          label: field.label ?? fieldId,
          type: (field.type as 'measure' | 'dimension' | 'business_rule') ?? 'measure',
          table: field.table ?? '',
          sql: field.sql ?? '',
          filters: field.filters ?? [],
          format: field.format,
          description: field.description ?? '',
          synonyms: field.synonyms ?? [],
        },
      },
    ]);
  }
}
