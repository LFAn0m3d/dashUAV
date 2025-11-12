import type { ComponentType } from 'react';
import { NavLink } from 'react-router-dom';
import clsx from 'clsx';
import {
  Activity,
  Map as MapIcon,
  Radar,
  Database,
  Settings as SettingsIcon,
  ShieldAlert,
} from 'lucide-react';
import useUiStore, { Route } from '../stores/useUiStore';

const NAV_ITEMS: Array<{ label: string; to: string; icon: ComponentType<{ className?: string }>; route: Route }> = [
  { label: 'Dashboard', to: '/', icon: Activity, route: 'dashboard' },
  { label: 'Map', to: '/map', icon: MapIcon, route: 'map' },
  { label: 'Threats', to: '/threats', icon: ShieldAlert, route: 'threats' },
  { label: 'Data', to: '/data', icon: Database, route: 'data' },
  { label: 'Settings', to: '/settings', icon: SettingsIcon, route: 'settings' },
  { label: 'Auth', to: '/auth', icon: Radar, route: 'auth' },
];

function SideNav() {
  const { sideNavOpen, setRoute } = useUiStore((state) => ({
    sideNavOpen: state.sideNavOpen,
    setRoute: state.setRoute,
  }));

  return (
    <aside
      className={clsx(
        'border-r border-slate-800 bg-surface/60 px-4 py-6 backdrop-blur transition-all duration-300 md:translate-x-0',
        sideNavOpen ? 'translate-x-0' : '-translate-x-full md:w-64 md:translate-x-0',
        'md:w-64 md:static md:flex md:flex-col md:gap-2',
      )}
    >
      <nav className="flex flex-col gap-2 text-sm">
        {NAV_ITEMS.map(({ label, to, icon: Icon, route }) => (
          <NavLink
            key={to}
            to={to}
            onClick={() => setRoute(route)}
            className={({ isActive }) =>
              clsx(
                'inline-flex items-center gap-3 rounded-md px-3 py-2 font-medium transition-colors',
                isActive
                  ? 'bg-primary/20 text-primary'
                  : 'text-slate-300 hover:bg-slate-800/80 hover:text-slate-50',
              )
            }
            end={to === '/'}
          >
            <Icon className="h-4 w-4" />
            {label}
          </NavLink>
        ))}
      </nav>
    </aside>
  );
}

export default SideNav;
