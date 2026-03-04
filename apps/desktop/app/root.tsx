import { useCallback, useEffect, useState } from 'react';
import { Links, Meta, Outlet, Scripts, data, useLocation, useNavigate } from "react-router";
import type { Route } from '~/types/app/+types/root';

import appConfig from '../../web/config/app.config';
import styles from '../../web/styles/global.css?url';
import { cn } from '@qwery/ui/utils';
import { Spinner } from '@qwery/ui/spinner';
import { RootProviders } from '../../web/components/root-providers';
import { Titlebar } from './components/titlebar';
import { StatusBar } from './components/status-bar';
import { initDesktopApi } from './lib/desktop-api';
import { useMenuActions, type MenuActionId } from './hooks/use-menu-actions';
import { useKeyboardShortcuts } from './hooks/use-keyboard-shortcuts';

import desktopStyles from './styles/desktop.css?url';
import { isDesktopApp } from '@qwery/shared/desktop';

export const links = () => [
  { rel: 'stylesheet', href: styles },
  { rel: 'stylesheet', href: desktopStyles },
];

export const meta = () => {
  return [
    {
      title: appConfig.title,
    },
  ];
};

function getClassName(theme?: string) {
  const dark = theme === 'dark';
  const light = !dark;

  return cn('bg-background min-h-screen overscroll-none antialiased', {
    dark,
    light,
  });
}

export function HydrateFallback() {
  const className = getClassName(appConfig.theme);
  const isDark = appConfig.theme === 'dark';
  // Dark theme background: hsl(0 0% 11%) = #1c1c1c
  // Light theme background: hsl(0 0% 100%) = #ffffff
  const bgColor = isDark ? '#1c1c1c' : '#ffffff';
  const textColor = isDark ? '#fafafa' : '#09090b';
  
  return (
    <html lang="en" className={className}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>{appConfig.title}</title>
        <style dangerouslySetInnerHTML={{
          __html: `
            html { background-color: ${bgColor}; }
            body { 
              background-color: ${bgColor}; 
              color: ${textColor};
              margin: 0;
              padding: 0;
            }
          `
        }} />
        <Meta />
        <Links />
      </head>
      <body 
        className={cn('bg-background min-h-screen overscroll-none antialiased')}
        style={{
          backgroundColor: bgColor,
          color: textColor,
        }}
      >
        <main className="flex min-h-screen flex-col items-center justify-center">
          <div className="flex flex-col items-center gap-4">
            <Spinner className="size-8" />
            <p className="text-muted-foreground text-sm font-medium">
              Loading {appConfig.name}...
            </p>
          </div>
        </main>
        <Scripts />
      </body>
    </html>
  );
}

export async function clientLoader() {
  const theme = await getTheme();
  const className = getClassName(theme);

  return data({
    className,
    theme,
  });
}

function AppContent({
  className,
  theme,
}: {
  className?: string;
  theme?: string;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);

  useEffect(() => {
    if (!isDesktopApp()) return;

    initDesktopApi();
    if (typeof window !== 'undefined') {
      document.documentElement.classList.add('desktop-runtime');
    }

    import('@tauri-apps/plugin-os')
      .then(({ platform }) => platform())
      .then((p) => {
        document.documentElement.classList.add(`platform-${p}`);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      setCanGoBack(false);
      setCanGoForward(false);
      return;
    }

    const historyState = window.history.state as { idx?: number } | null;
    const idx =
      historyState && typeof historyState.idx === 'number'
        ? historyState.idx
        : 0;
    const length = window.history.length;

    setCanGoBack(idx > 0);
    setCanGoForward(idx < length - 1);
  }, [location.key]);

  const handleMenuAction = useCallback((action: MenuActionId) => {
    switch (action) {
      case 'file_new':
      case 'file_open':
      case 'file_save':
      case 'file_save_as':
      case 'edit_undo':
      case 'edit_redo':
      case 'view_zoom_in':
      case 'view_zoom_out':
      case 'view_actual_size':
      case 'help_about':
        break;
      default:
        break;
    }
  }, []);

  const handleBack = useCallback(() => {
    if (!canGoBack) return;
    navigate(-1);
  }, [canGoBack, navigate]);

  const handleForward = useCallback(() => {
    if (!canGoForward) return;
    navigate(1);
  }, [canGoForward, navigate]);

  useMenuActions(handleMenuAction);
  const onOpenCommandPalette = useCallback(() => {
    window.dispatchEvent(new CustomEvent('open-command-palette'));
  }, []);
  useKeyboardShortcuts({ onOpenCommandPalette });

  return (
    <>
      <div className="flex h-screen w-screen flex-col overflow-hidden">
        <Titlebar
          onMenuAction={handleMenuAction}
          onBack={handleBack}
          onForward={handleForward}
          canGoBack={canGoBack}
          canGoForward={canGoForward}
        />
        <div className="desktop-content-area flex min-h-0 flex-1 flex-col overflow-hidden">
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <RootProviders theme={theme as 'light' | 'dark' | 'system' | undefined} language={'en'}>
              <Outlet />
            </RootProviders>
          </div>
        </div>
        <StatusBar />
      </div>
    </>
  );
}

export default function App({
  loaderData,
}: Route.ComponentProps) {
  const { className, theme } = loaderData ?? {};

  return (
    <html lang={'en'} className={cn(className, 'desktop-app')}>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link
          rel="apple-touch-icon"
          sizes="144x144"
          href="/images/favicon/apple-touch-icon.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="16x16"
          href="/images/favicon/favicon-16x16.png"
        />
        <link
          rel="icon"
          type="image/png"
          sizes="32x32"
          href="/images/favicon/favicon-32x32.png"
        />
        <link
          rel="mask-icon"
          href="/images/favicon/safari-pinned-tab.svg"
          color="#000000"
        />
        <Meta />
        <Links />
      </head>
      <body className="overflow-hidden">
        <AppContent className={className} theme={theme} />
        <Scripts />
      </body>
    </html>
  );
}

async function getTheme() {

  return appConfig.theme;
}

