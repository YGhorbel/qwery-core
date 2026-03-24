/**
 * Validates that a URL returns content matching the expected format (JSON, CSV, or Parquet).
 * Calls the server to fetch the URL and parse structure; prevents using a JSON URL in a CSV/Parquet datasource and vice versa.
 */

import { apiPost } from '../repositories/api-client';

export type DataUrlFormat = 'json' | 'csv' | 'parquet';

export interface ValidateUrlStructureResult {
  valid: boolean;
  error: string | null;
}

const URL_STRUCTURE_CACHE_TTL_MS = 60_000;
const urlStructureSuccessCache = new Map<
  string,
  { expiresAt: number; result: ValidateUrlStructureResult }
>();

function urlStructureCacheKey(
  url: string,
  expectedFormat: DataUrlFormat,
): string {
  return `${expectedFormat}\0${url}`;
}

export async function validateUrlStructure(
  url: string,
  expectedFormat: DataUrlFormat,
): Promise<ValidateUrlStructureResult> {
  const trimmed = url?.trim();
  if (
    !trimmed ||
    (!trimmed.startsWith('http://') && !trimmed.startsWith('https://'))
  ) {
    return { valid: false, error: 'Please enter a valid URL (http or https)' };
  }

  const key = urlStructureCacheKey(trimmed, expectedFormat);
  const now = Date.now();
  const hit = urlStructureSuccessCache.get(key);
  if (hit && hit.expiresAt > now && hit.result.valid) {
    return hit.result;
  }

  try {
    const result = await apiPost<{ valid: boolean; error?: string }>(
      '/datasources/validate-url',
      { url: trimmed, expectedFormat },
      { timeout: 20_000 },
    );
    const normalized: ValidateUrlStructureResult = {
      valid: result.valid === true,
      error: result.error ?? null,
    };
    if (normalized.valid) {
      urlStructureSuccessCache.set(key, {
        expiresAt: now + URL_STRUCTURE_CACHE_TTL_MS,
        result: normalized,
      });
    }
    return normalized;
  } catch (err) {
    const message =
      err && typeof err === 'object' && 'details' in err
        ? String((err as { details?: string }).details)
        : err instanceof Error
          ? err.message
          : 'Unable to verify URL format';
    return { valid: false, error: message };
  }
}
