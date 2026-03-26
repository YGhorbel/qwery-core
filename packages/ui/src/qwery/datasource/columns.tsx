import React from 'react';
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
import { Type, Columns2, Info } from 'lucide-react';

export interface ColumnListItem {
  name: string;
  description: string | null;
  dataType: string;
  format: string;
}

export type ColumnColumn = 'name' | 'description' | 'type';

/** All column-detail table keys, in default display order. */
export const ALL_COLUMN_COLUMNS = [
  'name',
  'description',
  'type',
] as const satisfies readonly ColumnColumn[];

export const DEFAULT_VISIBLE_COLUMN_COLUMNS: ColumnColumn[] = [
  ...ALL_COLUMN_COLUMNS,
];

export interface ColumnsProps {
  columns: ColumnListItem[];
  onColumnClick?: (column: ColumnListItem) => void;
  className?: string;
  searchQuery?: string;
  visibleColumns?: ColumnColumn[];
}

export function Columns({
  columns,
  onColumnClick,
  className,
  searchQuery = '',
  visibleColumns = DEFAULT_VISIBLE_COLUMN_COLUMNS,
}: ColumnsProps) {
  const { t } = useTranslation();

  const isVisible = (column: ColumnColumn) => visibleColumns.includes(column);

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

  if (columns.length === 0) {
    return (
      <div
        className={cn(
          'flex flex-col items-center justify-center py-20 text-center',
          className,
        )}
      >
        <div className="bg-muted/50 mb-4 rounded-full p-4">
          <Columns2 className="text-muted-foreground/40 h-8 w-8" />
        </div>
        <p className="text-foreground mb-1 font-medium">
          {t('datasource.columns.list.empty', {
            defaultValue: 'No columns found',
          })}
        </p>
        <p className="text-muted-foreground text-sm">
          {searchQuery
            ? t('datasource.columns.list.search_empty', {
                defaultValue: 'Try adjusting your search query',
              })
            : t('datasource.columns.list.empty_description', {
                defaultValue: "We couldn't find any columns in this table",
              })}
        </p>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'bg-card border-border/50 overflow-hidden rounded-xl border shadow-sm',
        className,
      )}
    >
      <Table>
        <TableHeader className="bg-muted/50 hover:bg-muted/50">
          <TableRow className="hover:bg-transparent">
            {isVisible('name') && (
              <TableHead
                className={cn(
                  'text-foreground/70 py-4 pl-6 font-semibold',
                  isVisible('description') ? 'w-[35%]' : 'w-full',
                )}
              >
                <div className="flex items-center gap-2">
                  <Columns2 className="h-4 w-4" />
                  {t('datasource.columns.header.name', {
                    defaultValue: 'Column Name',
                  })}
                </div>
              </TableHead>
            )}
            {isVisible('description') && (
              <TableHead className="text-foreground/70 py-4 font-semibold">
                <div className="flex items-center gap-2">
                  <Info className="h-4 w-4" />
                  {t('datasource.columns.header.description', {
                    defaultValue: 'Description',
                  })}
                </div>
              </TableHead>
            )}
            {isVisible('type') && (
              <TableHead className="text-foreground/70 w-[20%] py-4 pr-6 text-right font-semibold">
                <div className="flex items-center justify-end gap-2">
                  <Type className="h-4 w-4" />
                  {t('datasource.columns.header.dataType', {
                    defaultValue: 'Type & Format',
                  })}
                </div>
              </TableHead>
            )}
          </TableRow>
        </TableHeader>
        <TableBody>
          {columns.map((column, index) => (
            <TableRow
              key={`${column.name}-${index}`}
              className={cn(
                'group h-14 transition-colors',
                onColumnClick ? 'hover:bg-muted/30 cursor-pointer' : undefined,
              )}
              onClick={() => onColumnClick?.(column)}
              data-test={`column-row-${column.name}`}
            >
              {isVisible('name') && (
                <TableCell className="py-3 pl-6 text-sm font-semibold">
                  {highlightMatch(column.name, searchQuery)}
                </TableCell>
              )}
              {isVisible('description') && (
                <TableCell className="py-3">
                  <span className="text-muted-foreground line-clamp-1 text-sm">
                    {column.description || (
                      <span className="text-muted-foreground/30 italic">
                        {t('datasource.columns.noDescription', {
                          defaultValue: 'No description provided',
                        })}
                      </span>
                    )}
                  </span>
                </TableCell>
              )}
              {isVisible('type') && (
                <TableCell className="py-3 pr-6">
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex w-full items-center justify-end gap-1.5">
                      <div
                        className="text-muted-foreground/40 scale-90"
                        aria-hidden
                      >
                        <Type className="h-3.5 w-3.5" />
                      </div>
                      <code className="text-foreground bg-muted/60 border-border/50 rounded border px-1.5 py-0.5 font-mono text-xs font-medium">
                        {column.dataType}
                      </code>
                    </div>
                    {column.format &&
                      column.format.toLowerCase() !==
                        column.dataType.toLowerCase() && (
                        <span className="text-muted-foreground/60 pr-1 font-mono text-[10px] italic">
                          {column.format}
                        </span>
                      )}
                  </div>
                </TableCell>
              )}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
