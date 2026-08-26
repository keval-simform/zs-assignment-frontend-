import { DEFAULT_RESOLVED, resolveTenant } from '../features/theme/sanitizeTheme';
import type { Slice } from './slices';
import type { ResolvedTheme } from '../features/theme/types';
import type { StoreActions } from './types';

export interface ThemeSlice {
  readonly theme: ResolvedTheme;
  setTenant: StoreActions['setTenant'];
}

/**
 * FR-8: runtime white-labelling.
 *
 * DECISION: the resolved theme is store state, and applying it to the DOM is a
 * separate effect (`ThemeProvider`). Switching tenants is therefore a single state
 * transition that a test can assert against with no DOM, and the CSS custom property
 * writes happen once per change rather than per component.
 */
export const createThemeSlice =
  (initial: ResolvedTheme = DEFAULT_RESOLVED): Slice<ThemeSlice> =>
  (set, get) => ({
    theme: initial,

    setTenant: (tenantId) => {
      if (get().theme.tenantId === tenantId) return;
      set({ theme: resolveTenant(tenantId), lastOp: { label: 'switch tenant', ms: 0 } });
    },
  });
