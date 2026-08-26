import type { StateCreator } from 'zustand';
import type { Store } from './types';

/**
 * A slice of the single store.
 *
 * DECISION: one Zustand store composed of slices, not several stores. Features
 * intersect constantly — `commitEdit` reads `view.editing`, writes `cellState`
 * and `committed`, deltas `aggregates`, and pushes to `history`, all in one
 * transition. Across separate stores, that's four subscriptions that could
 * observe an intermediate state where the edit is committed but the history
 * entry isn't pushed yet, leaving undo with nothing to undo. Slices give
 * file-level separation without giving up the single atomic transition.
 *
 * Slices receive the whole `Store` in `get()` on purpose — it's what lets
 * `commitEdit` push history without the edit slice owning the history state.
 */
export type Slice<T> = StateCreator<Store, [], [], T>;
