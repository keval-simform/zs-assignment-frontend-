import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { useStoreSelector } from '../../store/StoreContext';
import type { TenantTheme } from '../../vendor/theme-config';

/**
 * The CSS custom properties the theme drives.
 *
 * INVARIANT: this list and the `:root` block in `index.css` must agree. The
 * stylesheet defaults let the app render correctly before this effect has run once.
 *
 * Not listed: the `--state-*` tokens used by `CallsCell`. Those are fixed on
 * purpose, so no tenant palette can make a pending cell indistinguishable from a
 * saved one (FR-8's cross-theme requirement).
 */
const PROPERTY_MAP: readonly (readonly [string, (t: TenantTheme) => string])[] = [
  ['--tenant-primary', (t) => t.primary],
  ['--tenant-on-primary', (t) => t.onPrimary],
  ['--tenant-background', (t) => t.background],
  ['--tenant-surface', (t) => t.surface],
  ['--tenant-text', (t) => t.text],
  ['--tenant-radius', (t) => `${String(t.radius)}px`],
];

/**
 * FR-8: re-skin at runtime, with no rebuild.
 *
 * DECISION: CSS custom properties on `document.documentElement`, not a rebuild-time
 * theme and not inline styles threaded through the component tree.
 *
 * Against a rebuild: the requirement is explicit that re-skinning happens at
 * runtime, ruling out anything resolved at build time.
 *
 * Against inline styles or a React theme context: those re-render every themed
 * component on a theme change, but colour is a property of the *document*, not of
 * any component's state. Writing six custom properties on the root repaints the
 * whole app with **zero React re-renders** — the browser recomputes style, React
 * isn't involved. It's also why `Grid.module.css` can reference
 * `var(--tenant-primary)` in a `color-mix()` without knowing a theme system exists.
 *
 * Against Tailwind: its model compiles a fixed set of utility classes from a
 * config — a build-time decision. Runtime theming there means shipping every
 * tenant's classes, or driving Tailwind's colours from CSS variables, at which point
 * the variables do the work and Tailwind is overhead. CSS Modules plus custom
 * properties is the same mechanism without the indirection.
 */
export function ThemeProvider({ children }: { children: ReactNode }): JSX.Element {
  const theme = useStoreSelector((s) => s.theme.theme);

  useEffect(() => {
    const root = document.documentElement;
    for (const [property, read] of PROPERTY_MAP) root.style.setProperty(property, read(theme));
    // Tab title is part of white-labelling too; already sanitised and length-capped.
    document.title = theme.appName;
  }, [theme]);

  return <>{children}</>;
}
