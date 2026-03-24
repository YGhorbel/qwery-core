import type { z } from 'zod';
import type { ZodError } from 'zod';
import {
  hasLegacyFormRule,
  normalizeProviderConfig,
  validateProviderConfigWithZod,
} from '~/lib/utils/datasource-form-config';
import {
  getUrlForValidation,
  type DatasourceExtensionMeta,
} from '~/lib/utils/datasource-utils';
import {
  validateUrlStructure,
  type DataUrlFormat,
} from '~/lib/utils/validate-datasource-url-structure';

type PreviewMeta = DatasourceExtensionMeta;

type ValidateDatasourceConfigInput = {
  values: Record<string, unknown>;
  extensionId: string;
  schema?: z.ZodTypeAny;
  extensionMeta?: PreviewMeta | null;
};

type ValidateDatasourceConfigResult =
  | { success: true; config: Record<string, unknown> }
  | { success: false; error: string; zodError?: ZodError };

function shouldValidateDataFileUrl(meta?: PreviewMeta | null): boolean {
  return Boolean(
    meta?.previewUrlKind === 'data-file' &&
      (meta.previewDataFormat === 'json' ||
        meta.previewDataFormat === 'csv' ||
        meta.previewDataFormat === 'parquet'),
  );
}

export async function validateDatasourceConfigPipeline({
  values,
  extensionId,
  schema,
  extensionMeta,
}: ValidateDatasourceConfigInput): Promise<ValidateDatasourceConfigResult> {
  let config: Record<string, unknown>;

  if (hasLegacyFormRule(extensionId)) {
    const zodResult = validateProviderConfigWithZod(values, extensionId);
    if (!zodResult.success) {
      return {
        success: false,
        error: zodResult.error,
        zodError: zodResult.zodError,
      };
    }
    config = normalizeProviderConfig(zodResult.data, extensionId);
  } else {
    if (!schema) {
      return { success: false, error: 'No schema available' };
    }
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      return {
        success: false,
        error: parsed.error.issues?.[0]?.message ?? 'Invalid configuration',
        zodError: parsed.error,
      };
    }
    config = parsed.data as Record<string, unknown>;
  }

  if (shouldValidateDataFileUrl(extensionMeta)) {
    const url = getUrlForValidation(config, extensionMeta);
    if (url) {
      const structureResult = await validateUrlStructure(
        url,
        extensionMeta!.previewDataFormat as DataUrlFormat,
      );
      if (!structureResult.valid) {
        return {
          success: false,
          error: structureResult.error ?? 'URL format does not match',
        };
      }
    }
  }

  return { success: true, config };
}
