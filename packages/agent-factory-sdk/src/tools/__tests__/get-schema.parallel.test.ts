import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GetSchemaTool } from '../get-schema';
import { ExtensionsRegistry } from '@qwery/extensions-sdk';
import * as driverLoader from '@qwery/extensions-loader';

vi.mock('@qwery/shared/logger', () => ({
    getLogger: vi.fn().mockResolvedValue({
        debug: vi.fn(),
        warn: vi.fn(),
        info: vi.fn(),
        error: vi.fn(),
    }),
}));

vi.mock('@qwery/extensions-loader', () => ({
    getDriverInstance: vi.fn(),
}));

describe('GetSchemaTool - Parallelism Verification', () => {
    let mockRepositories: any;
    let mockContext: any;

    beforeEach(() => {
        vi.clearAllMocks();

        mockRepositories = {
            datasource: {
                findById: vi.fn(),
            },
        };

        mockContext = {
            extra: {
                repositories: mockRepositories,
                attachedDatasources: ['ds1', 'ds2'],
            },
        };

        // Register a mock provider
        vi.spyOn(ExtensionsRegistry, 'get').mockReturnValue({
            drivers: [{ runtime: 'node' }],
        } as any);
    });

    it('should fetch schemas in parallel', async () => {
        const ds1 = { id: 'ds1', name: 'DS 1', datasource_provider: 'mock', config: { key: 'ds1' } };
        const ds2 = { id: 'ds2', name: 'DS 2', datasource_provider: 'mock', config: { key: 'ds2' } };

        mockRepositories.datasource.findById.mockImplementation((id: string) => {
            if (id === 'ds1') return Promise.resolve(ds1);
            if (id === 'ds2') return Promise.resolve(ds2);
            return Promise.resolve(null);
        });

        const mockInstance1 = {
            metadata: vi.fn().mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
                return { tables: [{ id: 1, name: 'table1', schema: 'public' }], columns: [], schemas: [] };
            }),
            close: vi.fn(),
        };

        const mockInstance2 = {
            metadata: vi.fn().mockImplementation(async () => {
                await new Promise(resolve => setTimeout(resolve, 500));
                return { tables: [{ id: 1, name: 'table2', schema: 'public' }], columns: [], schemas: [] };
            }),
            close: vi.fn(),
        };

        (driverLoader.getDriverInstance as any).mockImplementation((driver: any, opts: any) => {
            if (opts.config.key === 'ds1') return Promise.resolve(mockInstance1);
            if (opts.config.key === 'ds2') return Promise.resolve(mockInstance2);
            return Promise.resolve(null);
        });

        const startTime = Date.now();
        const result = await (GetSchemaTool as any).execute({}, mockContext);
        const endTime = Date.now();

        const duration = endTime - startTime;

        // Parallel should take ~500ms. If sequential, it would be ~1000ms.
        // 800ms threshold ensures it's parallel.
        expect(duration).toBeLessThan(800);

        expect(result.schema.tables).toHaveLength(2);
        expect(mockInstance1.metadata).toHaveBeenCalled();
        expect(mockInstance2.metadata).toHaveBeenCalled();
    });
});
