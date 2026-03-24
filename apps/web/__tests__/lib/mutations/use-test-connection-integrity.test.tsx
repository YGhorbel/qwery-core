import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Datasource } from '@qwery/domain/entities';
import { ExtensionScope } from '@qwery/extensions-sdk';
import type { DatasourceExtension } from '@qwery/extensions-sdk';

import { useTestConnection } from '~/lib/mutations/use-test-connection';

vi.mock('~/lib/queries/use-get-extension', () => ({
  useGetDatasourceExtensions: vi.fn(),
}));

import { useGetDatasourceExtensions } from '~/lib/queries/use-get-extension';

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

describe('useTestConnection provider / driver integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls onError when provider is not in the extensions registry', async () => {
    vi.mocked(useGetDatasourceExtensions).mockReturnValue({
      data: [],
    } as unknown as ReturnType<typeof useGetDatasourceExtensions>);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() => useTestConnection(onSuccess, onError), {
      wrapper: createWrapper(queryClient),
    });

    const payload = {
      datasource_provider: 'missing-provider-xyz',
      datasource_driver: 'some.driver',
      datasource_kind: 'remote',
      name: 't',
      config: {},
    } as unknown as Datasource;

    result.current.mutate(payload);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toMatch(/not registered|extensions/i);
  });

  it('calls onError when provider has no resolvable drivers', async () => {
    const brokenExtension = {
      id: 'postgresql',
      name: 'PostgreSQL',
      icon: '/x.svg',
      scope: ExtensionScope.DATASOURCE,
      drivers: [],
    } as unknown as DatasourceExtension;

    vi.mocked(useGetDatasourceExtensions).mockReturnValue({
      data: [brokenExtension],
    } as ReturnType<typeof useGetDatasourceExtensions>);

    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    const onSuccess = vi.fn();
    const onError = vi.fn();

    const { result } = renderHook(() => useTestConnection(onSuccess, onError), {
      wrapper: createWrapper(queryClient),
    });

    const payload = {
      datasource_provider: 'postgresql',
      datasource_driver: 'postgresql.default',
      datasource_kind: 'remote',
      name: 't',
      config: {},
    } as unknown as Datasource;

    result.current.mutate(payload);

    await waitFor(() => expect(onError).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
    const err = onError.mock.calls[0]?.[0] as Error;
    expect(err.message).toMatch(/No driver resolved/i);
  });
});
