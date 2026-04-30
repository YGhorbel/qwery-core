import { NavLink, Outlet } from 'react-router';
import {
  Database,
  FlaskConical,
  LayoutDashboard,
  Coins,
} from 'lucide-react';
import { cn } from '@qwery/ui/utils';
import type { Route } from './+types/_layout';

const navItems = [
  { to: '/', label: 'Databases', icon: LayoutDashboard, end: true },
  { to: '/benchmark', label: 'Benchmark', icon: FlaskConical },
  { to: '/tokens', label: 'Token Usage', icon: Coins },
];

export function loader() {
  return { storageDir: process.env.QWERY_STORAGE_DIR ?? 'qwery.db' };
}

export default function Layout({ loaderData }: Route.ComponentProps) {
  const { storageDir } = loaderData;
  return (
    <div className="flex h-screen overflow-hidden">
      <aside className="w-56 shrink-0 border-r bg-sidebar flex flex-col">
        <div className="flex items-center gap-2 px-4 py-4 border-b">
          <Database className="h-5 w-5 text-primary" />
          <span className="font-semibold text-sm">Qwery Background</span>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {navItems.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  'flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors',
                  isActive
                    ? 'bg-sidebar-accent text-sidebar-accent-foreground font-medium'
                    : 'text-sidebar-foreground hover:bg-sidebar-accent/60',
                )
              }
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="p-3 border-t text-xs text-muted-foreground truncate" title={storageDir}>
          {storageDir}
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
