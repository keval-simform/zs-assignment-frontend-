import { create } from 'zustand';
import type { StoreApi, UseBoundStore } from 'zustand';
import { computeAggregates } from '../domain/aggregate';
import type { RowKey } from '../domain/identity';
import type { LoadedData } from '../domain/normalize';
import { createEditSlice } from './editSlice';
import { vendorValidatorClient } from '../services/validatorClient';
import type { ValidatorClient } from '../services/validatorClient';
import { createHistorySlice } from './historySlice';
import { createThemeSlice } from './themeSlice';
import { DEFAULT_RESOLVED } from '../features/theme/sanitizeTheme';
import type { ResolvedTheme } from '../features/theme/types';
import { createViewSlice } from './viewSlice';
import type { Store } from './types';

const NO_EDITS: ReadonlyMap<RowKey, number> = new Map();

export type HcpStore = UseBoundStore<StoreApi<Store>>;

/**
 * Build a store over a given dataset.
 *
 * DECISION: a factory with the app's singleton built from it, rather than a bare
 * module singleton. Tests get an isolated store over a three-row fixture instead
 * of sharing one 50,000-row global whose state leaks between cases — the kind of
 * leak that makes a suite pass in isolation and fail in order. It's also the seam
 * `ValidatorClient` arrives through: dependencies enter as arguments, not module
 * imports reached for inside an action, which lets a test drive resolution order
 * by hand instead of waiting on a 300–900 ms timer that fails randomly 10% of
 * the time.
 *
 * One `create` call, four slices. See `slices.ts` for why this is one store and
 * not four, and the `committed` / `cellState` INVARIANT in `types.ts` for the
 * property the whole aggregation story rests on.
 */
export function createHcpStore(
  loaded: LoadedData,
  validator: ValidatorClient = vendorValidatorClient,
  initialTheme: ResolvedTheme = DEFAULT_RESOLVED,
): HcpStore {
  const aggregates = computeAggregates(loaded.dataset, loaded.groups, NO_EDITS);
  return create<Store>()((...args) => ({
    dataset: loaded.dataset,
    groups: loaded.groups,
    ...createViewSlice(...args),
    ...createEditSlice(aggregates, validator)(...args),
    ...createHistorySlice(...args),
    ...createThemeSlice(initialTheme)(...args),
  }));
}
