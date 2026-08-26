import type { ColumnId } from '../domain/comparators';
import { territoryRows } from '../domain/grouping';
import { asRowKey } from '../domain/identity';
import type { RegionIndex, RowKey, TerritoryIndex } from '../domain/identity';
import { filterRows, isRegionOpen, isTerritoryOpen } from './selectors';
import type { Slice } from './slices';
import { nextSortDirection } from './types';
import type { LastOp, Store, StoreActions, ViewState } from './types';

export interface ViewSlice {
  readonly view: ViewState;
  readonly selection: ReadonlySet<RowKey>;
  readonly lastOp: LastOp;
  setSearch: StoreActions['setSearch'];
  setRegionFilter: StoreActions['setRegionFilter'];
  toggleSort: StoreActions['toggleSort'];
  clearSort: StoreActions['clearSort'];
  toggleRegion: StoreActions['toggleRegion'];
  toggleTerritory: StoreActions['toggleTerritory'];
  toggleRowSelection: StoreActions['toggleRowSelection'];
  selectTerritoryRows: StoreActions['selectTerritoryRows'];
  clearSelection: StoreActions['clearSelection'];
}

export const INITIAL_VIEW: ViewState = {
  search: '',
  regionFilter: null,
  sort: null,
  userExpanded: { regions: new Map(), territories: new Map() },
  editing: null,
  filterVersion: 0,
};

/**
 * Flip one group's expansion intent.
 *
 * `intent.get(key) ?? searchExpanded` is how effective state is resolved (see
 * `ExpansionIntent`), so toggling has to record an explicit boolean rather than
 * add to or remove from a set. `currentlyOpen` is passed in because only the
 * caller knows whether the search is currently forcing this group open — without
 * it, toggling a search-expanded group would write `true` and appear to do
 * nothing.
 */
function flipIntent<K>(intent: ReadonlyMap<K, boolean>, key: K, currentlyOpen: boolean): Map<K, boolean> {
  const next = new Map(intent);
  next.set(key, !currentlyOpen);
  return next;
}

export const createViewSlice: Slice<ViewSlice> = (set, get) => ({
  view: INITIAL_VIEW,
  selection: new Set(),
  lastOp: { label: 'load', ms: 0 },

  setSearch: (search) => {
    if (get().view.search === search) return;
    // PERF: filterVersion is what the per-territory sort cache keys on. Bumping
    // it here, rather than hashing the search string at every cache lookup,
    // reduces the check to an integer compare.
    set((state) => ({
      view: { ...state.view, search, filterVersion: state.view.filterVersion + 1 },
      lastOp: { label: search === '' ? 'clear search' : 'search', ms: 0 },
    }));
  },

  setRegionFilter: (regionFilter) => {
    if (get().view.regionFilter === regionFilter) return;
    set((state) => ({
      view: { ...state.view, regionFilter, filterVersion: state.view.filterVersion + 1 },
      lastOp: { label: regionFilter === null ? 'clear region filter' : 'region filter', ms: 0 },
    }));
  },

  // FR-3: three-state cycle. A different column restarts at ascending rather
  // than inheriting the previous column's direction — "descending" is a
  // statement about a specific column, and carrying it over surprises the user.
  toggleSort: (column: ColumnId) => {
    set((state) => {
      const current = state.view.sort;
      const direction = nextSortDirection(current?.column === column ? current.direction : null);
      return {
        view: { ...state.view, sort: direction === null ? null : { column, direction } },
        lastOp: { label: direction === null ? `unsort ${column}` : `sort ${column} ${direction}`, ms: 0 },
      };
    });
  },

  clearSort: () => {
    if (get().view.sort === null) return;
    set((state) => ({
      view: { ...state.view, sort: null },
      lastOp: { label: 'clear sort', ms: 0 },
    }));
  },

  toggleRegion: (region: RegionIndex) => {
    set((state) => ({
      view: {
        ...state.view,
        userExpanded: {
          ...state.view.userExpanded,
          regions: flipIntent(state.view.userExpanded.regions, region, isRegionOpenNow(get(), region)),
        },
      },
      lastOp: { label: 'toggle region', ms: 0 },
    }));
  },

  toggleTerritory: (territory: TerritoryIndex) => {
    set((state) => ({
      view: {
        ...state.view,
        userExpanded: {
          ...state.view.userExpanded,
          territories: flipIntent(
            state.view.userExpanded.territories,
            territory,
            isTerritoryOpenNow(get(), territory),
          ),
        },
      },
      lastOp: { label: 'toggle territory', ms: 0 },
    }));
  },

  toggleRowSelection: (rowKey: RowKey) => {
    set((state) => {
      const next = new Set(state.selection);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return { selection: next };
    });
  },

  // FR-5: rows can be selected individually or per-territory. Selects the whole
  // territory, not just its currently-visible rows — a selection that silently
  // changed size when the user typed in the search box would be a trap.
  selectTerritoryRows: (territory: TerritoryIndex, selected: boolean) => {
    set((state) => {
      const next = new Set(state.selection);
      for (const rowKey of territoryRows(state.groups, territory)) {
        if (selected) next.add(asRowKey(rowKey));
        else next.delete(asRowKey(rowKey));
      }
      return { selection: next };
    });
  },

  clearSelection: () => {
    if (get().selection.size === 0) return;
    set({ selection: new Set() });
  },
});

/**
 * Whether a group is open *right now*, search auto-expansion included.
 *
 * A toggle needs to know the *effective* state, not just the recorded intent:
 * flipping a group the search has auto-expanded must record `false`, or it would
 * record `true` and appear to do nothing.
 *
 * PERF: `filterRows` is memoised on its inputs, so calling it here costs a
 * four-way identity check — the pipeline has already run for this state during
 * the render that produced the click.
 */
function isRegionOpenNow(store: Store, region: RegionIndex): boolean {
  const filter = filterRows(store.dataset, store.groups, store.view.search, store.view.regionFilter);
  return isRegionOpen(store.view, filter, region);
}

function isTerritoryOpenNow(store: Store, territory: TerritoryIndex): boolean {
  const filter = filterRows(store.dataset, store.groups, store.view.search, store.view.regionFilter);
  return isTerritoryOpen(store.view, filter, territory);
}
