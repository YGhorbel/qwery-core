import { describe, expect, it, beforeEach, vi } from 'vitest';
import { mkdir, readFile, writeFile } from 'fs/promises';

vi.mock('fs/promises');
vi.mock('@qwery/shared/logger', () => ({
  getLogger: vi.fn().mockResolvedValue({ info: vi.fn(), warn: vi.fn() }),
}));

import {
  saveDiscoveryRecord,
  loadDiscoveryRecord,
  updateDiscoveryStatus,
} from '../src/schema-store';
import type { DiscoveryStatusRecord } from '../src/types';

const mockRecord: DiscoveryStatusRecord = {
  datasourceId: 'ds-1',
  status: 'ready',
  updatedAt: '2024-01-01T00:00:00.000Z',
  error: null,
  schema: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(mkdir).mockResolvedValue(undefined);
  vi.mocked(writeFile).mockResolvedValue(undefined);
});

describe('saveDiscoveryRecord', () => {
  it('writes JSON to the correct path', async () => {
    await saveDiscoveryRecord(mockRecord);

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('ds-1.json'),
      expect.stringContaining('"status": "ready"'),
      'utf-8',
    );
  });
});

describe('loadDiscoveryRecord', () => {
  it('returns null when file does not exist', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    const result = await loadDiscoveryRecord('ds-missing');
    expect(result).toBeNull();
  });

  it('returns parsed record when file exists', async () => {
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(mockRecord));
    const result = await loadDiscoveryRecord('ds-1');
    expect(result).toMatchObject({ datasourceId: 'ds-1', status: 'ready' });
  });
});

describe('updateDiscoveryStatus', () => {
  it('writes record with new status', async () => {
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));
    await updateDiscoveryStatus('ds-1', 'running');

    expect(writeFile).toHaveBeenCalledWith(
      expect.stringContaining('ds-1.json'),
      expect.stringContaining('"status": "running"'),
      'utf-8',
    );
  });

  it('preserves existing schema when updating status', async () => {
    const existing: DiscoveryStatusRecord = {
      ...mockRecord,
      schema: {
        datasourceId: 'ds-1',
        datasourceProvider: 'postgresql',
        discoveredAt: '2024-01-01T00:00:00.000Z',
        tables: [],
        foreignKeys: [],
      },
    };
    vi.mocked(readFile).mockResolvedValue(JSON.stringify(existing));

    await updateDiscoveryStatus('ds-1', 'failed', 'connection error');

    const written = vi.mocked(writeFile).mock.calls[0]![1] as string;
    const parsed = JSON.parse(written) as DiscoveryStatusRecord;
    expect(parsed.status).toBe('failed');
    expect(parsed.error).toBe('connection error');
    expect(parsed.schema).not.toBeNull();
  });
});
