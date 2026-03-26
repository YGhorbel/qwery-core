import { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import { useParams, Link, useNavigate } from 'react-router';
import { useTranslation } from 'react-i18next';
import {
  Columns,
  type ColumnListItem,
  type ColumnColumn,
  DEFAULT_VISIBLE_COLUMN_COLUMNS,
} from '@qwery/ui/qwery/datasource/columns';
import { useGetDatasourceMetadata } from '~/lib/queries/use-get-datasource-metadata';
import type { Column, Table } from '@qwery/domain/entities';
import { Input } from '@qwery/ui/input';
import { MagnifyingGlassIcon } from '@radix-ui/react-icons';
import { X, ChevronLeft, Table2, Info, Settings2, Filter } from 'lucide-react';
import { Button } from '@qwery/ui/button';
import { Skeleton } from '@qwery/ui/skeleton';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuCheckboxItem,
} from '@qwery/ui/dropdown-menu';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@qwery/ui/select';

import type { Route } from './+types/table';
import { loadDatasourceBySlug } from '~/lib/loaders/load-datasource-by-slug';
import pathsConfig, { createPath } from '~/config/paths.config';

const COLUMN_PICKER_ITEMS: {
  column: ColumnColumn;
  i18nKey: string;
  defaultLabel: string;
}[] = [
  {
    column: 'name',
    i18nKey: 'datasource.table.columnPicker.name',
    defaultLabel: 'Name',
  },
  {
    column: 'description',
    i18nKey: 'datasource.table.columnPicker.description',
    defaultLabel: 'Description',
  },
  {
    column: 'type',
    i18nKey: 'datasource.table.columnPicker.typeAndFormat',
    defaultLabel: 'Type & Format',
  },
];

export const clientLoader = loadDatasourceBySlug;

export default function TablePage(props: Route.ComponentProps) {
  const params = useParams();
  const slug = params.slug as string;
  const navigate = useNavigate();
  const schemaParam = params.schema as string;
  const tableNameParam = params.tableName as string;
  const schema = schemaParam ? decodeURIComponent(schemaParam) : '';
  const tableName = tableNameParam ? decodeURIComponent(tableNameParam) : '';
  const { t } = useTranslation();
  const { datasource } = props.loaderData;
  const [searchQuery, setSearchQuery] = useState('');
  const [visibleColumns, setVisibleColumns] = useState<ColumnColumn[]>(() => [
    ...DEFAULT_VISIBLE_COLUMN_COLUMNS,
  ]);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const { data: metadata, isLoading } = useGetDatasourceMetadata(datasource, {
    enabled: !!datasource,
  });

  const table = useMemo(() => {
    if (!metadata?.tables || !schema || !tableName) return null;
    const tables = metadata.tables as Table[];
    return (
      tables.find(
        (t) => (t.schema ?? 'main') === schema && t.name === tableName,
      ) ?? null
    );
  }, [metadata, schema, tableName]);

  const filteredColumns = useMemo(() => {
    if (!metadata?.columns || !table) return [];
    const allColumns = metadata.columns as Column[];
    let cols = allColumns.filter(
      (col) =>
        col.table_id === table.id &&
        col.table === table.name &&
        (col.schema ?? 'main') === (table.schema ?? 'main'),
    );

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      cols = cols.filter(
        (col) =>
          col.name.toLowerCase().includes(query) ||
          col.data_type.toLowerCase().includes(query) ||
          col.comment?.toLowerCase().includes(query),
      );
    }

    return cols;
  }, [metadata, table, searchQuery]);

  const columnListItems: ColumnListItem[] = useMemo(() => {
    return filteredColumns.map((col) => ({
      name: col.name,
      description: col.comment,
      dataType: col.data_type,
      format: col.format,
    }));
  }, [filteredColumns]);

  const toggleColumn = useCallback((column: ColumnColumn) => {
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

  if (isLoading) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex shrink-0 flex-col gap-6 px-8 py-6 lg:px-16 lg:py-10">
          <Skeleton className="h-10 w-64" />
          <Skeleton className="h-12 w-full rounded-xl" />
        </div>
        <div className="flex-1 px-8 py-6 lg:px-16 lg:py-6">
          <Skeleton className="h-[400px] w-full rounded-xl" />
        </div>
      </div>
    );
  }

  const tablesPath = createPath(pathsConfig.app.datasourceTables, slug);

  if (!metadata || !table) {
    return (
      <div className="flex h-full flex-col items-center justify-center px-8 py-12 text-center lg:px-16 lg:py-16">
        <div className="bg-muted/50 mb-4 rounded-full p-4">
          <Info className="text-muted-foreground/40 h-8 w-8" />
        </div>
        <p className="text-foreground mb-1 font-medium">
          {t('datasource.table.error', { defaultValue: 'Table not found' })}
        </p>
        <Button variant="link" onClick={() => navigate(tablesPath)}>
          {t('common.actions.back_to_tables', {
            defaultValue: 'Back to tables',
          })}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-6 px-8 py-6 lg:px-16 lg:py-10">
        <div className="flex flex-col gap-2">
          <Link
            to={tablesPath}
            className="text-muted-foreground hover:text-foreground flex items-center gap-1 text-xs font-medium transition-colors"
          >
            <ChevronLeft className="h-3 w-3" />
            {t('datasource.table.back_to_tables', {
              defaultValue: 'Back to tables',
            })}
          </Link>
          <div className="flex items-center gap-3">
            <div className="bg-muted flex h-10 w-10 items-center justify-center rounded-lg border p-2">
              <Table2 className="text-foreground h-5 w-5" />
            </div>
            <h1 className="text-4xl font-bold tracking-tight">{table.name}</h1>
          </div>
          {table.comment && (
            <p className="text-muted-foreground mt-1 max-w-2xl text-sm">
              {table.comment}
            </p>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="bg-muted/30 border-border/50 focus-within:border-border flex h-12 flex-1 items-center gap-3 rounded-xl border px-4 transition-all focus-within:bg-transparent">
            <MagnifyingGlassIcon className="text-muted-foreground/60 h-5 w-5 shrink-0" />
            <Input
              ref={searchInputRef}
              type="text"
              placeholder={t('datasource.table.columns.search.placeholder', {
                defaultValue: 'Search columns by name, type or description...',
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

          <Select disabled value="all">
            <SelectTrigger className="bg-muted/30 border-border/50 hover:bg-muted flex h-12 w-[180px] cursor-not-allowed items-center gap-3 rounded-xl border px-4 transition-all focus:ring-0 focus-visible:ring-0">
              <Filter className="text-muted-foreground/60 h-5 w-5 shrink-0" />
              <SelectValue
                placeholder="All Types"
                className="text-sm font-medium"
              >
                All Types
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="h-full px-8 py-6 lg:px-16 lg:py-6">
          <Columns
            columns={columnListItems}
            searchQuery={searchQuery}
            visibleColumns={visibleColumns}
          />
        </div>
      </div>
    </div>
  );
}
