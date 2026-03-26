import { useCallback, useMemo, useState, useRef, useEffect } from 'react';
import { useNavigate, useParams } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Tables,
  type TableListItem,
  type TableColumn,
  DEFAULT_VISIBLE_TABLE_COLUMNS,
} from '@qwery/ui/qwery/datasource/tables';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qwery/ui/select';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@qwery/ui/dropdown-menu';
import { useGetDatasourceMetadata } from '~/lib/queries/use-get-datasource-metadata';
import type { Table, Column } from '@qwery/domain/entities';
import { Input } from '@qwery/ui/input';
import { MagnifyingGlassIcon } from '@radix-ui/react-icons';
import { X, Filter, Settings2 } from 'lucide-react';
import { Button } from '@qwery/ui/button';
import { Skeleton } from '@qwery/ui/skeleton';

import type { Route } from './+types/tables';
import { loadDatasourceBySlug } from '~/lib/loaders/load-datasource-by-slug';
import pathsConfig, { createPath } from '~/config/paths.config';
import { DevProfiler } from '~/lib/perf/dev-profiler';

const COLUMN_PICKER_ITEMS: {
  column: TableColumn;
  i18nKey: string;
  defaultLabel: string;
}[] = [
  {
    column: 'name',
    i18nKey: 'datasource.tables.columnPicker.name',
    defaultLabel: 'Name',
  },
  {
    column: 'description',
    i18nKey: 'datasource.tables.columnPicker.description',
    defaultLabel: 'Description',
  },
  {
    column: 'columns',
    i18nKey: 'datasource.tables.columnPicker.columnsCount',
    defaultLabel: 'Columns count',
  },
  {
    column: 'rows',
    i18nKey: 'datasource.tables.columnPicker.rowsAndSize',
    defaultLabel: 'Rows & size',
  },
  {
    column: 'actions',
    i18nKey: 'datasource.tables.columnPicker.actions',
    defaultLabel: 'Actions',
  },
];

export const clientLoader = loadDatasourceBySlug;

export default function TablesPage(props: Route.ComponentProps) {
  const params = useParams();
  const slug = params.slug as string;
  const navigate = useNavigate();
  const { t } = useTranslation();
  const { datasource } = props.loaderData;
  const [selectedSchema, setSelectedSchema] = useState<string>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleColumns, setVisibleColumns] = useState<TableColumn[]>(() => [
    ...DEFAULT_VISIBLE_TABLE_COLUMNS,
  ]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data: metadata, isLoading } = useGetDatasourceMetadata(datasource, {
    enabled: !!datasource,
  });

  const schemas = useMemo(() => {
    if (!metadata?.schemas) return [];
    return Array.from(new Set(metadata.schemas.map((s) => s.name))).sort();
  }, [metadata]);

  const filteredTables = useMemo(() => {
    if (!metadata?.tables) return [];
    let tables = metadata.tables as Table[];

    if (selectedSchema !== 'all') {
      tables = tables.filter(
        (table) => (table.schema ?? 'main') === selectedSchema,
      );
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      tables = tables.filter(
        (table) =>
          table.name.toLowerCase().includes(query) ||
          table.comment?.toLowerCase().includes(query),
      );
    }

    return tables;
  }, [metadata, selectedSchema, searchQuery]);

  const columnCountByTableId = useMemo(() => {
    const map = new Map<string, number>();
    for (const col of (metadata?.columns ?? []) as Column[]) {
      const key = String(col.table_id);
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return map;
  }, [metadata?.columns]);

  const tableListItems: TableListItem[] = useMemo(() => {
    return filteredTables.map((table) => ({
      tableName: table.name,
      schema: table.schema ?? 'main',
      description: table.comment,
      rowsEstimated: table.live_rows_estimate || 0,
      sizeEstimated: table.size || '0 B',
      numberOfColumns:
        columnCountByTableId.get(String(table.id)) ??
        table.columns?.length ??
        0,
    }));
  }, [filteredTables, columnCountByTableId]);

  const basePath = createPath(pathsConfig.app.datasourceTables, slug);

  const handleTableClick = useCallback(
    (table: TableListItem) => {
      const schema = encodeURIComponent(table.schema ?? 'main');
      const tableName = encodeURIComponent(table.tableName);
      navigate(`${basePath}/${schema}/${tableName}`);
    },
    [basePath, navigate],
  );

  const toggleColumn = useCallback((column: TableColumn) => {
    setVisibleColumns((prev) =>
      prev.includes(column)
        ? prev.filter((c) => c !== column)
        : [...prev, column],
    );
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'f' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        searchInputRef.current?.focus();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  if (!datasource) {
    throw new Response('Not Found', { status: 404 });
  }

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-col gap-6 px-8 py-6 lg:px-16 lg:py-10">
          <Skeleton className="h-10 w-48" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
        <div className="flex-1 px-8 py-6 lg:px-16 lg:py-6">
          <Skeleton className="h-[400px] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-6 px-8 py-6 lg:px-16 lg:py-10">
        <div className="flex items-center justify-between">
          <h1 className="text-4xl font-bold tracking-tight">
            {t('datasource.tables.title', { defaultValue: 'Tables' })}
          </h1>
        </div>

        <div className="flex items-center gap-3">
          <div className="bg-muted/30 border-border/50 focus-within:border-border flex h-12 flex-1 items-center gap-3 rounded-xl border px-4 transition-all focus-within:bg-transparent">
            <MagnifyingGlassIcon className="text-muted-foreground/60 h-5 w-5 shrink-0" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={t('datasource.tables.search.placeholder', {
                defaultValue: 'Search tables...',
              })}
              className="h-full flex-1 border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery('')}
                className="text-muted-foreground hover:text-foreground hover:bg-muted cursor-pointer rounded-full p-1 transition-colors"
              >
                <X className="h-4 w-4" />
              </button>
            )}
            <div className="bg-border/50 mx-1 h-6 w-px" />

            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="hover:bg-muted h-8 shrink-0 gap-2 border-none px-2 focus-visible:ring-0"
                >
                  <Settings2 className="text-muted-foreground/60 h-4 w-4" />
                  <span className="text-muted-foreground/60 text-xs font-medium">
                    Options
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                <DropdownMenuLabel className="text-muted-foreground/30 px-2 py-1.5 text-[10px] font-bold tracking-widest uppercase">
                  Toggle Visibility
                </DropdownMenuLabel>
                <DropdownMenuCheckboxItem
                  checked={visibleColumns.length === COLUMN_PICKER_ITEMS.length}
                  onCheckedChange={(checked) => {
                    if (checked) {
                      setVisibleColumns(
                        COLUMN_PICKER_ITEMS.map((item) => item.column),
                      );
                    } else {
                      setVisibleColumns(['name']); // Keep at least name
                    }
                  }}
                  className="font-medium"
                >
                  Select All
                </DropdownMenuCheckboxItem>
                <DropdownMenuSeparator className="my-1" />
                {COLUMN_PICKER_ITEMS.map(
                  ({ column, i18nKey, defaultLabel }) => (
                    <DropdownMenuCheckboxItem
                      key={column}
                      checked={visibleColumns.includes(column)}
                      onCheckedChange={() => toggleColumn(column)}
                      disabled={
                        visibleColumns.length === 1 &&
                        visibleColumns.includes(column)
                      }
                    >
                      {t(i18nKey, { defaultValue: defaultLabel })}
                    </DropdownMenuCheckboxItem>
                  ),
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>

          {schemas.length > 0 && (
            <Select value={selectedSchema} onValueChange={setSelectedSchema}>
              <SelectTrigger className="bg-muted/30 border-border/50 hover:bg-muted flex h-12 w-[180px] items-center gap-3 rounded-xl border px-4 transition-all focus:ring-0 focus-visible:ring-0">
                <Filter className="text-muted-foreground/60 h-5 w-5 shrink-0" />
                <SelectValue
                  placeholder="Select Schema"
                  className="text-sm font-medium"
                >
                  {selectedSchema === 'all'
                    ? t('datasource.tables.filter.all', {
                        defaultValue: 'All Schemas',
                      })
                    : selectedSchema}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  {t('datasource.tables.filter.all', {
                    defaultValue: 'All Schemas',
                  })}
                </SelectItem>
                {schemas.map((schema) => (
                  <SelectItem key={schema} value={schema}>
                    {schema}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="h-full px-8 py-6 lg:px-16 lg:py-6">
          <DevProfiler id="DatasourceTables/Tables">
            <Tables
              tables={tableListItems}
              onTableClick={handleTableClick}
              searchQuery={searchQuery}
              visibleColumns={visibleColumns}
              showSchema={selectedSchema === 'all'}
            />
          </DevProfiler>
        </div>
      </div>
    </div>
  );
}
