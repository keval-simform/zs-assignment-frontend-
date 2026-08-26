import { createContext, useContext } from 'react';
import type { ReactNode } from 'react';
import { useStore as useZustand } from 'zustand';
import type { HcpStore } from './store';
import type { Store } from './types';

const StoreContext = createContext<HcpStore | null>(null);

/**
 * Supplies the store to the component tree.
 *
 * DECISION: a context provider rather than components importing the app singleton
 * directly. Direct imports would mean every component test constructs the real
 * 50,000-row dataset — a second per test file — and shares mutable state between
 * cases. With a provider, a test renders the grid over a four-row fixture and
 * gets exact expected values instead of "greater than 900".
 *
 * The store still lives outside React (see `appStore.ts`); this only decides
 * which store a subtree reads, it does not own the state.
 */
export function StoreProvider({ store, children }: { store: HcpStore; children: ReactNode }): JSX.Element {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

/** The store instance for this subtree. */
export function useHcpStore(): HcpStore {
  const store = useContext(StoreContext);
  // No `!` (HARD CONSTRAINT 4). A missing provider should name itself rather than
  // surface as a null-property error three frames deep.
  if (store === null) throw new Error('useHcpStore must be used inside a <StoreProvider>');
  return store;
}

/**
 * Subscribe to a slice of store state.
 *
 * INVARIANT: the selector must return a primitive or a stable reference. Zustand
 * subscribes via `useSyncExternalStore`, which compares snapshots by reference,
 * so a selector that allocates — `s => ({ a: s.a })`, `s => s.rows.filter(...)` —
 * returns a new object every render and loops forever.
 */
export function useStoreSelector<T>(selector: (state: Store) => T): T {
  return useZustand(useHcpStore(), selector);
}

/** Read the store without subscribing — for event handlers and effects. */
export function useStoreActions(): Store {
  return useHcpStore().getState();
}
