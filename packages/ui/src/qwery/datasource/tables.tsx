import React, { memo } from 'react';
import { TableVirtuoso } from 'react-virtuoso';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../../shadcn/table';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/utils';
import { Database, Table2, Info, ArrowRight, Hash, Layers } from 'lucide-react';
import { Button } from '../../shadcn/button';

const VirtuosoTableBody = React.forwardRef<
  HTMLTableSectionElement,
  React.HTMLAttributes<HTMLTableSectionElement>
>((props, ref) => <TableBody ref={ref} {...props} />);
VirtuosoTableBody.displayName = 'VirtuosoTableBody';

export interface TableListItem {
  tableName: string;
  schema: string;
  description: string | null;
  rowsEstimated: number;
  sizeEstimated: string | null;
  numberOfColumns: number;
}

export type TableColumn =
  | 'name'
  | 'description'
  | 'columns'
  | 'rows'
  | 'actions';

/** All table column keys, in default display order. */
export const ALL_TABLE_COLUMNS = [
  'name',
  'description',
  'columns',
  'rows',
  'actions',
] as const satisfies readonly TableColumn[];

export const DEFAULT_VISIBLE_TABLE_COLUMNS: TableColumn[] = [
  ...ALL_TABLE_COLUMNS,
];

export interface TablesProps {
  tables: TableListItem[];
  onTableClick?: (table: TableListItem) => void;
  className?: string;
  searchQuery?: string;
  visibleColumns?: TableColumn[];
  showSchema?: boolean;
}

const VIRTUALIZE_THRESHOLD = 50;
const ROW_HEIGHT = 64; // Increased for better spacing
const MAX_HEIGHT = 800;

export const Tables = memo(function Tables({
  tables,
  onTableClick,
  className,
  searchQuery = '',
  visibleColumns = DEFAULT_VISIBLE_TABLE_COLUMNS,
  showSchema = true,
}: TablesProps) {
  const { t } = useTranslation();

  const isVisible = (column: TableColumn) => visibleColumns.includes(column);

  const formatNumber = (num: number) => {
    if (num >= 1_000_000_000) {
      return `${(num / 1_000_000_000).toFixed(1)}B`;
    }
    if (num >= 1_000_000) {
      return `${(num / 1_000_000).toFixed(1)}M`;
    }
    if (num >= 1_000) {
      return `${(num / 1_000).toFixed(1)}K`;
    }
    return num.toString();
  };

  const highlightMatch = (text: string, query: string) => {
    if (!query) return text;
    const parts = text.split(new RegExp(`(${query})`, 'gi'));
    return (
      <span>
        {parts.map((part, i) =>
          part.toLowerCase() === query.toLowerCase() ? (
            <span
              key={i}
              className="rounded-sm bg-[#ffcb51]/20 px-0.5 font-semibold text-[#ffcb51]"
            >
              {part}
            </span>
          ) : (
            part
          ),
        )}
      </span>
    );
  };

  if (tables.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center py-20 text-center',
          className,
        )}
      >
        <div className="bg-muted/50 mb-4 rounded-full p-4">
          <Database className="text-muted-foreground/40 h-8 w-8" />
        </div>
        <p className="text-foreground mb-1 font-medium">
          {t('datasource.tables.list.empty', {
            defaultValue: 'No tables found',
          })}
        </p>
        <p className="text-muted-foreground max-w-xs text-sm">
          {searchQuery
            ? t('datasource.tables.list.search_empty', {
                defaultValue: 'Try adjusting your search query',
              })
            : t('datasource.tables.list.empty_description', {
                defaultValue: "We couldn't find any tables in this datasource",
              })}
        </p>
      </div>
    );
  }

  const tableHeader = () => (
    <TableHeader className="bg-muted/50 hover:bg-muted/50">
      <TableRow className="hover:bg-transparent">
        {isVisible('name') && (
          <TableHead
            className={cn(
              'text-foreground/70 w-[30%] min-w-[200px] py-4 pl-6 font-semibold',
            )}
          >
            <div className="flex items-center gap-2">
              <Table2 className="h-4 w-4" />
              {t('datasource.tables.header.name', {
                defaultValue: 'Table Name',
              })}
            </div>
          </TableHead>
        )}
        {isVisible('description') && (
          <TableHead className="text-foreground/70 w-[40%] min-w-[250px] py-4 font-semibold">
            <div className="flex items-center gap-2">
              <Info className="h-4 w-4" />
              {t('datasource.tables.header.description', {
                defaultValue: 'Description',
              })}
            </div>
          </TableHead>
        )}
        {isVisible('columns') && (
          <TableHead className="text-foreground/70 w-[100px] py-4 text-right font-semibold">
            <div className="flex items-center justify-end gap-2">
              <Layers className="h-4 w-4" />
              {t('datasource.tables.header.columns', { defaultValue: 'Cols' })}
            </div>
          </TableHead>
        )}
        {isVisible('rows') && (
          <TableHead className="text-foreground/70 w-[140px] py-4 text-right font-semibold">
            <div className="flex items-center justify-end gap-2">
              <Hash className="h-4 w-4" />
              {t('datasource.tables.header.rows', { defaultValue: 'Rows' })}
            </div>
          </TableHead>
        )}
        {isVisible('actions') && (
          <TableHead className="text-foreground/70 w-[100px] py-4 pr-6 text-right font-semibold">
            {t('datasource.tables.header.actions', { defaultValue: 'Actions' })}
          </TableHead>
        )}
      </TableRow>
    </TableHeader>
  );

  const renderRow = (_index: number, table: TableListItem) => (
    <TableRow
      key={`${table.schema}-${table.tableName}`}
      className={cn(
        'group transition-colors',
        onTableClick ? 'hover:bg-muted/30 cursor-pointer' : undefined,
      )}
      onClick={() => onTableClick?.(table)}
      data-test={`table-row-${table.schema}-${table.tableName}`}
      style={{ height: ROW_HEIGHT }}
    >
      {isVisible('name') && (
        <TableCell className="py-3 pl-6">
          <div className="flex items-center gap-3">
            <div className="bg-muted group-hover:bg-background flex h-10 w-10 items-center justify-center rounded-lg border p-2 transition-colors">
              <Table2 className="text-muted-foreground group-hover:text-foreground h-5 w-5 transition-colors" />
            </div>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-sm font-semibold">
                {highlightMatch(table.tableName, searchQuery)}
              </span>
              {showSchema && (
                <span className="text-muted-foreground/60 text-[10px] font-medium tracking-wider uppercase">
                  {table.schema || 'main'}
                </span>
              )}
            </div>
          </div>
        </TableCell>
      )}
      {isVisible('description') && (
        <TableCell className="py-3">
          <span className="text-muted-foreground line-clamp-1 max-w-md text-sm">
            {table.description || (
              <span className="text-muted-foreground/30 italic">
                {t('datasource.tables.noDescription', {
                  defaultValue: 'No description',
                })}
              </span>
            )}
          </span>
        </TableCell>
      )}
      {isVisible('columns') && (
        <TableCell className="py-3 text-right">
          <span className="text-sm font-medium">{table.numberOfColumns}</span>
        </TableCell>
      )}
      {isVisible('rows') && (
        <TableCell className="py-3 text-right">
          <div className="flex flex-col items-end">
            <span className="text-sm font-semibold">
              {formatNumber(table.rowsEstimated)}
              <span className="text-muted-foreground/40 ml-1 text-[10px] font-normal uppercase">
                {t('datasource.tables.rows.suffix', { defaultValue: 'rows' })}
              </span>
            </span>
          </div>
        </TableCell>
      )}
      {isVisible('actions') && (
        <TableCell className="py-3 pr-6 text-right">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground hover:text-foreground h-8 w-8 p-0"
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
        </TableCell>
      )}
    </TableRow>
  );

  const containerClasses = cn(
    'bg-card border-border/50 overflow-hidden rounded-xl border shadow-sm',
    className,
  );

  if (tables.length > VIRTUALIZE_THRESHOLD) {
    return (
      <div className={containerClasses}>
        <TableVirtuoso
          style={{ height: MAX_HEIGHT }}
          data={tables}
          fixedHeaderContent={tableHeader}
          itemContent={renderRow}
          components={{
            Table: ({ style, ...props }) => (
              <Table {...props} style={style} className="w-full" />
            ),
            TableBody: VirtuosoTableBody,
          }}
        />
      </div>
    );
  }

  return (
    <div className={containerClasses}>
      <Table>
        {tableHeader()}
        <TableBody>
          {tables.map((table, index) => renderRow(index, table))}
        </TableBody>
      </Table>
    </div>
  );
});
