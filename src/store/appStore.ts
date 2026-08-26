import { buildDataset } from '../domain/normalize';
import { resolveTenant } from '../features/theme/sanitizeTheme';
import { tenantFromLocation } from '../features/theme/TenantSwitcher';
import { vendorValidatorClient } from '../services/validatorClient';
import { createHcpStore } from './store';
import type { HcpStore } from './store';

/**
 * The application's single store instance.
 *
 * DECISION: the singleton lives here, not in `store.ts` beside the factory.
 * Building 50,000 rows is a module side effect; keeping it out of `createHcpStore`
 * means test files that import the factory don't pay ~75 ms for a global they
 * don't use.
 *
 * DECISION: module scope rather than `useMemo`. StrictMode double-invokes render
 * in development, so a `useMemo` would generate 50,000 rows twice per mount. More
 * importantly the store must outlive the component tree — a validator result
 * landing after its row has scrolled out of the DOM needs somewhere to go.
 */
function buildAppStore(): { store: HcpStore; initialMs: number } {
  const started = performance.now();
  const loaded = buildDataset(42, 50_000);
  const storeStarted = performance.now();
  // FR-8: tenant comes from the URL at boot, read here so the store factory
  // stays free of `window` and testable in isolation.
  const theme = resolveTenant(tenantFromLocation(window.location.search));
  const store = createHcpStore(loaded, vendorValidatorClient, theme);
  const aggregateMs = performance.now() - storeStarted;
  const initialMs = performance.now() - started;

  console.info(
    `[hcp] store ready in ${initialMs.toFixed(1)} ms ` +
      `(generate ${loaded.generateMs.toFixed(1)} + project/group ${loaded.projectMs.toFixed(1)} + ` +
      `aggregate ${aggregateMs.toFixed(1)}) — ` +
      `${loaded.dataset.count.toLocaleString()} rows, ` +
      `${loaded.groups.regionCount} regions / ${loaded.groups.territoryCount} territories`,
  );

  return { store, initialMs };
}

const app = buildAppStore();

export const useStore: HcpStore = app.store;

/** Wall-clock cost of the initial state build, for the README and the footer. */
export const INITIAL_BUILD_MS = app.initialMs;
