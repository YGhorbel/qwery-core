'use client';

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  forwardRef,
  useCallback,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useTheme } from 'next-themes';
import {
  ExternalLink,
  RefreshCw,
  FileJson,
  Copy,
  Check,
  Loader2,
} from 'lucide-react';
import { cn } from '@qwery/ui/utils';
import { Button } from '@qwery/ui/button';
import {
  getDatasourcePreviewUrl,
  getUrlForValidation,
  validateDatasourceUrl,
  isGsheetLikeUrl,
  type DatasourceExtensionMeta,
} from '~/lib/utils/datasource-utils';
import {
  detectPublishedState,
  type PublicationStatus,
} from '~/lib/utils/google-sheets-preview';
import { fetchJsonData } from '~/lib/utils/json-preview-utils';
import { fetchParquetData, fetchCsvData } from '~/lib/utils/data-preview-utils';

import { getErrorKey } from '~/lib/utils/error-key';
import { DatasourcePublishingGuide } from './datasource-publishing-guide';
import { JsonViewer, type JsonViewMode } from './json-viewer';

const PREVIEW_REVEAL_DELAY_MS = 2500;

function getPreviewTitle(
  meta: DatasourceExtensionMeta | undefined | null,
): string {
  if (!meta) return 'Preview';
  const id = meta.id ?? '';
  const format = meta.previewDataFormat;
  const kind = meta.previewUrlKind;
  if (id === 'gsheet-csv' || kind === 'embeddable')
    return 'Google Sheets preview';
  if (kind === 'data-file') {
    if (format === 'json') return 'JSON preview';
    if (format === 'parquet') return 'Parquet preview';
    if (format === 'csv') return 'CSV preview';
    return 'Data preview';
  }
  return 'Preview';
}

export interface DatasourcePreviewRef {
  refresh: () => void;
}

export const DatasourcePreview = forwardRef<
  DatasourcePreviewRef,
  {
    formValues: Record<string, unknown> | null;
    extensionMeta: DatasourceExtensionMeta | undefined | null;
    className?: string;
    isTestConnectionLoading?: boolean;
  }
>(function DatasourcePreview(
  {
    formValues,
    extensionMeta,
    className,
    isTestConnectionLoading: _isTestConnectionLoading = false,
  },
  _ref,
) {
  const { t } = useTranslation('common');
  const { theme, resolvedTheme } = useTheme();
  const supportsPreviewProp = extensionMeta?.supportsPreview === true;
  const previewUrl = useMemo(
    () => getDatasourcePreviewUrl(formValues, extensionMeta),
    [formValues, extensionMeta],
  );
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [publicationStatus, setPublicationStatus] =
    useState<PublicationStatus>('unknown');
  const [isIframeLoading, setIsIframeLoading] = useState(false);
  const [jsonData, setJsonData] = useState<unknown>(null);
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [isLoadingJson, setIsLoadingJson] = useState(false);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [copied, setCopied] = useState(false);
  const [viewMode, setViewMode] = useState<JsonViewMode>('table');
  const [isWasmFallbackRequested, setIsWasmFallbackRequested] = useState(false);
  const [showPublishingGuide, setShowPublishingGuide] = useState(false);
  const [previewRevealReady, setPreviewRevealReady] = useState(false);

  useEffect(() => {
    const next = extensionMeta?.previewDataFormat === 'json' ? 'tree' : 'table';
    queueMicrotask(() => setViewMode(next));
  }, [extensionMeta?.previewDataFormat]);

  useEffect(() => {
    if (!previewUrl) {
      queueMicrotask(() => setPublicationStatus('unknown'));
      return;
    }
    setRefreshKey((prev) => prev + 1);
    setIsIframeLoading(true);
    setIsWasmFallbackRequested(false);
    setJsonData(null);
    setJsonError(null);
    if (
      extensionMeta?.previewUrlKind === 'embeddable' &&
      isGsheetLikeUrl(previewUrl)
    ) {
      setShowPublishingGuide(true);
    } else {
      setShowPublishingGuide(false);
    }
  }, [previewUrl, extensionMeta?.previewUrlKind]);

  const needsPublicationCheck =
    extensionMeta?.previewUrlKind === 'embeddable' &&
    isGsheetLikeUrl(previewUrl);

  useEffect(() => {
    if (!previewUrl) {
      setPreviewRevealReady(false);
      return;
    }
    if (!needsPublicationCheck) {
      setPreviewRevealReady(true);
      return;
    }
    setPreviewRevealReady(false);
    const timer = setTimeout(() => {
      setPreviewRevealReady(true);
    }, PREVIEW_REVEAL_DELAY_MS);
    return () => clearTimeout(timer);
  }, [previewUrl, needsPublicationCheck]);

  useEffect(() => {
    if (needsPublicationCheck && publicationStatus === 'not-published') {
      setShowPublishingGuide(true);
    }
  }, [needsPublicationCheck, publicationStatus]);

  useEffect(() => {
    if (!needsPublicationCheck || !previewUrl) {
      queueMicrotask(() => setPublicationStatus('unknown'));
      return;
    }

    const sharedLink = (formValues?.sharedLink || formValues?.url) as
      | string
      | undefined;
    if (!sharedLink || typeof sharedLink !== 'string') {
      queueMicrotask(() => setPublicationStatus('unknown'));
      return;
    }

    queueMicrotask(() => setPublicationStatus('checking'));
    detectPublishedState(sharedLink)
      .then((status) => {
        setPublicationStatus(status);
      })
      .catch(() => {
        setPublicationStatus('unknown');
      });
  }, [needsPublicationCheck, previewUrl, formValues]);

  useEffect(() => {
    const url = getUrlForValidation(formValues ?? null, extensionMeta);
    const { error } = validateDatasourceUrl(extensionMeta, url);
    setValidationError(error);
  }, [extensionMeta, formValues]);

  const needsDataFetching = extensionMeta?.previewUrlKind === 'data-file';
  const dataFormat = extensionMeta?.previewDataFormat;
  const isGSheetUrl = (url: string | null) =>
    !!url?.includes('docs.google.com/spreadsheets');

  useEffect(() => {
    if (!needsDataFetching || !previewUrl) {
      if (!isGSheetUrl(previewUrl)) {
        queueMicrotask(() => {
          setJsonData(null);
          setJsonError(null);
          setIsLoadingJson(false);
        });
      }
      return;
    }

    const gsheet = isGSheetUrl(previewUrl);
    const isDirectCsv = dataFormat === 'csv' && !gsheet;
    if (!isDirectCsv && dataFormat !== 'json' && dataFormat !== 'parquet') {
      return;
    }

    queueMicrotask(() => {
      setIsLoadingJson(true);
      setJsonError(null);
    });

    const fetcher =
      dataFormat === 'json'
        ? fetchJsonData(previewUrl)
        : dataFormat === 'parquet'
          ? fetchParquetData(previewUrl)
          : fetchCsvData(previewUrl);

    fetcher
      .then((result) => {
        if (result.error) {
          setJsonError(getErrorKey(new Error(result.error), t));
          setJsonData(null);
        } else {
          setJsonData(result.data);
          setExpandedPaths(new Set(['root']));
        }
      })
      .finally(() => {
        setIsLoadingJson(false);
      });
  }, [previewUrl, refreshKey, needsDataFetching, dataFormat, t]);

  useEffect(() => {
    if (
      !needsPublicationCheck ||
      publicationStatus !== 'not-published' ||
      !previewUrl ||
      !isWasmFallbackRequested
    ) {
      return;
    }

    const gSheetIdMatch = previewUrl.match(
      /\/spreadsheets\/d\/(e\/)?([a-zA-Z0-9-_]{20,})/,
    );
    if (!gSheetIdMatch) return;

    const sheetId = gSheetIdMatch[2];
    const csvUrl = `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`;

    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsLoadingJson(true);
    setJsonError(null); // Clear any previous error
    fetchCsvData(csvUrl)
      .then((result) => {
        if (!result.error && result.data) {
          setJsonData(result.data);
          setExpandedPaths(new Set(['root']));
        } else if (result.error) {
          setJsonError(getErrorKey(new Error(result.error), t));
        }
      })
      .finally(() => {
        setIsLoadingJson(false);
      });
  }, [
    needsPublicationCheck,
    publicationStatus,
    previewUrl,
    isWasmFallbackRequested,
    t,
  ]);

  const handleRefresh = () => {
    setIsIframeLoading(true);
    setRefreshKey((prev) => prev + 1);
    if (iframeRef.current) {
      // eslint-disable-next-line no-self-assign
      iframeRef.current.src = iframeRef.current.src;
    }
  };

  const handleIframeLoad = () => {
    setIsIframeLoading(false);
  };

  const togglePath = useCallback((path: string) => {
    setExpandedPaths((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleCopyJson = useCallback(async () => {
    if (jsonData === null) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(jsonData, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error('Failed to copy JSON:', error);
    }
  }, [jsonData]);

  // Get theme for iframe (try to inject, though Google Sheets may not respect it)
  const currentTheme = resolvedTheme || theme || 'light';
  const themeParam = currentTheme === 'dark' ? '&theme=dark' : '';

  const displayUrl: string | undefined = previewUrl
    ? previewUrl +
      (previewUrl.includes('?')
        ? '&' + themeParam.substring(1)
        : '?' + themeParam.substring(1))
    : undefined;

  const supportsPreview = supportsPreviewProp === true;
  const usesJsonFormat = dataFormat === 'json';
  const usesParquetFormat = dataFormat === 'parquet';
  const usesCsvFormat = dataFormat === 'csv';
  const hasValidUrl = Boolean(previewUrl) && !validationError;
  const hasPreview = Boolean(previewUrl) && !validationError;

  // Early return if datasource doesn't support preview
  if (!supportsPreview) {
    return null;
  }

  if (!hasValidUrl) {
    if (validationError) {
      return (
        <div
          className={cn(
            'border-destructive/20 bg-destructive/5 flex flex-col items-center justify-center rounded-xl border px-6 py-8 text-center shadow-sm',
            className,
          )}
        >
          <div className="bg-destructive/10 mb-3 flex h-12 w-12 items-center justify-center rounded-full">
            <FileJson className="text-destructive size-6" />
          </div>
          <h4 className="text-foreground text-sm font-semibold">
            Connection Required
          </h4>
          <p className="text-muted-foreground mt-1 max-w-xs text-xs leading-relaxed">
            {validationError}
          </p>
        </div>
      );
    }

    return null;
  }

  const showWasmTableView =
    usesJsonFormat ||
    usesParquetFormat ||
    (usesCsvFormat && !!jsonData) ||
    (needsPublicationCheck && (!!jsonData || isWasmFallbackRequested));

  const showPublishingGuideCollapsible =
    hasPreview &&
    previewRevealReady &&
    needsPublicationCheck &&
    publicationStatus === 'not-published' &&
    !jsonData &&
    !isWasmFallbackRequested;

  return (
    <div className={cn('flex flex-col space-y-3', className)}>
      {/* Guide only when sheet is not published; hidden when published so iframe is shown without it */}
      {showPublishingGuideCollapsible && (
        <div className="shrink-0 space-y-2">
          <DatasourcePublishingGuide isPublished={false} isChecking={false} />
          <div className="flex justify-end">
            <Button
              variant="outline"
              size="sm"
              className="h-8 border-dashed text-[11px]"
              onClick={() => setIsWasmFallbackRequested(true)}
              disabled={isLoadingJson}
            >
              {isLoadingJson ? (
                <>
                  <Loader2 className="mr-2 h-3 w-3 animate-spin" />
                  Analyzing…
                </>
              ) : (
                'Try Direct Data Preview'
              )}
            </Button>
          </div>
        </div>
      )}

      {/* During delay: full-width loading (same as preview container) */}
      {hasPreview && !previewRevealReady && (
        <div className="group border-border bg-muted/30 dark:bg-muted/25 relative flex min-h-[300px] flex-1 flex-col overflow-hidden rounded-lg border transition-colors duration-300">
          <div className="flex flex-1 items-center justify-center">
            <p className="text-muted-foreground flex items-center gap-2 text-sm">
              <Loader2 className="size-4 animate-spin" />
              Checking preview availability…
            </p>
          </div>
        </div>
      )}

      {hasPreview && previewRevealReady && (
        <div className="shrink-0">
          <h3 className="text-foreground text-sm font-semibold">
            {getPreviewTitle(extensionMeta)}
          </h3>
        </div>
      )}

      {hasPreview && previewRevealReady && (
        <div className="group border-border bg-muted/30 dark:bg-muted/25 relative flex min-h-[300px] flex-1 flex-col overflow-hidden rounded-lg border transition-colors duration-300">
          <div className="relative flex h-full min-h-0 w-full flex-1 flex-col">
            {showWasmTableView ? (
              <div className="relative flex min-h-0 flex-1 flex-col items-stretch overflow-hidden">
                {isLoadingJson ? (
                  <div className="bg-muted/30 dark:bg-muted/20 flex h-full w-full items-center justify-center">
                    <div className="flex flex-col items-center gap-3">
                      <div className="border-muted-foreground/20 border-t-muted-foreground size-8 animate-spin rounded-full border-2" />
                    </div>
                  </div>
                ) : jsonError && !needsPublicationCheck ? (
                  <div className="bg-background flex h-full w-full items-center justify-center p-6">
                    <div className="flex max-w-sm flex-col items-center text-center">
                      <div className="bg-destructive/10 mb-4 flex h-16 w-16 items-center justify-center rounded-2xl">
                        <FileJson className="text-destructive size-8" />
                      </div>
                      <h4 className="text-foreground text-lg font-semibold">
                        {usesParquetFormat
                          ? 'Failed to load Parquet'
                          : usesCsvFormat
                            ? 'Failed to load CSV'
                            : 'Failed to load JSON'}
                      </h4>
                      <p className="text-muted-foreground mt-2 text-sm leading-relaxed">
                        {jsonError}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        className="mt-6"
                        onClick={handleRefresh}
                      >
                        <RefreshCw className="mr-2 h-4 w-4" />
                        Try again
                      </Button>
                    </div>
                  </div>
                ) : jsonData ? (
                  <div className="animate-in fade-in zoom-in-95 flex min-h-0 w-full flex-1 flex-col duration-500">
                    <JsonViewer
                      data={jsonData}
                      expandedPaths={expandedPaths}
                      onTogglePath={togglePath}
                      viewMode={viewMode}
                      onViewModeChange={setViewMode}
                      itemsPerPage={
                        usesParquetFormat ||
                        usesCsvFormat ||
                        (needsPublicationCheck && !!jsonData)
                          ? 20
                          : undefined
                      }
                    />
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="relative min-h-0 flex-1">
                <iframe
                  key={refreshKey}
                  ref={iframeRef}
                  src={displayUrl}
                  className={cn(
                    'size-full border-0',
                    needsPublicationCheck &&
                      currentTheme === 'dark' &&
                      'brightness-[0.9] contrast-[1.1] hue-rotate-180 invert-[0.85]',
                  )}
                  sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-presentation"
                  title="Datasource preview"
                  allow="clipboard-read; clipboard-write"
                  onLoad={handleIframeLoad}
                />
                {isIframeLoading && (
                  <div className="bg-background/80 absolute inset-0 z-10 flex items-center justify-center backdrop-blur-sm">
                    <div className="flex flex-col items-center gap-3">
                      <div className="border-muted-foreground/20 border-t-muted-foreground size-6 animate-spin rounded-full border-2" />
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Bottom-Left Utility Controls (Hover only) */}
            {(!!jsonData || (displayUrl && !validationError)) && (
              <div className="pointer-events-auto absolute bottom-3 left-3 z-30 flex items-center gap-1.5 opacity-0 transition-opacity duration-200 group-hover:opacity-100">
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground/70 hover:text-foreground bg-background/90 border-border/40 h-7 w-7 border backdrop-blur-sm"
                  onClick={handleRefresh}
                  title="Refresh preview"
                >
                  <RefreshCw className="size-3.5" />
                </Button>
                {displayUrl && (
                  <a
                    href={displayUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-muted-foreground/70 hover:text-foreground bg-background/90 border-border/40 flex h-7 w-7 items-center justify-center rounded border backdrop-blur-sm transition-colors"
                    title="Open in new tab"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                )}
                {showWasmTableView &&
                  jsonData !== null &&
                  !isLoadingJson &&
                  !jsonError && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-muted-foreground/70 hover:text-foreground bg-background/90 border-border/40 h-7 w-7 border backdrop-blur-sm"
                      onClick={handleCopyJson}
                      title={
                        usesParquetFormat ? 'Copy rows as JSON' : 'Copy JSON'
                      }
                    >
                      {copied ? (
                        <Check className="size-3.5" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </Button>
                  )}
              </div>
            )}

            {/* Bottom-Right Controls: View Mode Toggles (Tree/Raw) */}
            {showWasmTableView &&
              jsonData !== null &&
              !isLoadingJson &&
              !jsonError && (
                <div className="pointer-events-auto absolute right-3 bottom-3 z-30 flex items-center">
                  <div className="border-border/40 bg-background/60 mr-2 flex items-center gap-0.5 rounded-md border p-0.5 shadow-sm backdrop-blur-md">
                    {(usesParquetFormat ||
                      (usesCsvFormat && !!jsonData) ||
                      (needsPublicationCheck && !!jsonData)) && (
                      <Button
                        variant={viewMode === 'table' ? 'default' : 'ghost'}
                        size="sm"
                        className={cn(
                          'h-6 rounded-[4px] px-2 text-[10px] font-medium transition-all',
                          viewMode === 'table'
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => setViewMode('table')}
                      >
                        Table
                      </Button>
                    )}
                    {usesJsonFormat && (
                      <Button
                        variant={viewMode === 'tree' ? 'default' : 'ghost'}
                        size="sm"
                        className={cn(
                          'h-6 rounded-[4px] px-2 text-[10px] font-medium transition-all',
                          viewMode === 'tree'
                            ? 'bg-primary text-primary-foreground shadow-sm'
                            : 'text-muted-foreground hover:text-foreground',
                        )}
                        onClick={() => setViewMode('tree')}
                      >
                        Tree
                      </Button>
                    )}
                    <Button
                      variant={viewMode === 'raw' ? 'default' : 'ghost'}
                      size="sm"
                      className={cn(
                        'h-6 rounded-[4px] px-2 text-[10px] font-medium transition-all',
                        viewMode === 'raw'
                          ? 'bg-primary text-primary-foreground shadow-sm'
                          : 'text-muted-foreground hover:text-foreground',
                      )}
                      onClick={() => setViewMode('raw')}
                    >
                      Raw
                    </Button>
                  </div>
                </div>
              )}
          </div>
        </div>
      )}
    </div>
  );
});
