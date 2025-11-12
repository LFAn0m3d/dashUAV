import { Menu } from 'lucide-react';
import useUiStore from '../stores/useUiStore';

function Navbar() {
  const toggleSideNav = useUiStore((state) => state.toggleSideNav);

  return (
    <header className="flex items-center justify-between border-b border-slate-800 bg-surface/80 px-4 py-3 backdrop-blur">
      <button
        type="button"
        className="inline-flex h-10 w-10 items-center justify-center rounded-md border border-slate-700 text-slate-200 transition hover:border-primary hover:text-primary md:hidden"
        onClick={toggleSideNav}
        aria-label="Toggle navigation"
      >
        <Menu className="h-5 w-5" />
      </button>
      <div>
        <p className="text-xs uppercase tracking-wide text-slate-400">DashUAV</p>
        <h1 className="text-lg font-semibold text-white">Unified Airspace Operations</h1>
      </div>
      <div className="flex items-center gap-3 text-sm text-slate-400">
        <span className="rounded-full bg-slate-800 px-3 py-1 text-xs uppercase tracking-wide text-slate-300">
          Live
        </span>
        <span>Sector 7G</span>
      </div>
    </header>
  );
}

export default Navbar;
