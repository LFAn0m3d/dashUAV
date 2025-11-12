import { create } from 'zustand';

type Route = 'dashboard' | 'map' | 'threats' | 'data' | 'settings' | 'auth';

interface UiState {
  sideNavOpen: boolean;
  activeRoute: Route;
  toggleSideNav: () => void;
  setRoute: (route: Route) => void;
}

const useUiStore = create<UiState>((set) => ({
  sideNavOpen: true,
  activeRoute: 'dashboard',
  toggleSideNav: () =>
    set((state) => ({
      sideNavOpen: !state.sideNavOpen,
    })),
  setRoute: (route) => set({ activeRoute: route }),
}));

export type { Route };
export default useUiStore;
