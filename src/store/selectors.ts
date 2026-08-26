import { totalsAt } from '../domain/aggregate';
import type { AggregateTable, Aggregates, GroupTotals } from '../domain/aggregate';
import { makeComparator } from '../domain/comparators';
import { isNumericColumn } from '../domain/comparators';
import type { ColumnId, SortSpec } from '../domain/comparators';
import { regionTerritoryRange, territoryRows } from '../domain/grouping';
import type { GroupIndex } from '../domain/grouping';
import { rowCpi } from '../domain/cpi';
import { asRegionIndex, asRowKey, asTerritoryIndex } from '../domain/identity';
import type { RegionIndex, RowKey, TerritoryIndex } from '../domain/identity';
import { callsAt, trxAt } from '../domain/normalize';
import type { Dataset } from '../domain/normalize';
import { readItem, readU32, readU8 } from '../domain/typed';
import { memo1 } from './memo';
import { pipelineTimings } from './pipelineTimings';
import type { Store } from './types';

// ---------------------------------------------------------------------------
// STAGE A — effective calls
// ---------------------------------------------------------------------------

/**
 * The value all arithmetic sees for one row: the accepted edit if there is one,
 * otherwise the source value.
 *
 * INVARIANT — note what is deliberately absent: `cellState`, and in particular
 * `cellState.proposed`. A pending value is a **visual overlay only**. Sorting,
 * aggregation, CPI, and export all route through here, so none of them can see a
 * value the validator hasn't accepted — FR-2's pending-exclusion rule expressed
 * as a data dependency rather than a rule to remember.
 *
 * @returns `null` when the source value was unparsable — never `NaN`.
 */
export const makeEffectiveCalls = memo1(
  (dataset: Dataset, committed: ReadonlyMap<RowKey, number>) =>
    (rowKey: RowKey): number | null =>
      committed.get(rowKey) ?? callsAt(dataset, rowKey),
);

// ---------------------------------------------------------------------------
// STAGE B — per-territory visible rows
// ---------------------------------------------------------------------------

/**
 * Which rows survive the search and region filter, bucketed by territory.
 *
 * CSR layout, same as the group index: one flat buffer plus offsets, so
 * `visibleRows()` hands out a zero-copy `subarray` per territory instead of
 * allocating 48 arrays.
 */
export interface FilterResult {
  readonly rows: Uint32Array;
  /** length territoryCount + 1 */
  readonly offsets: Uint32Array;
  /** Territories holding at least one surviving row. Drives FR-3 auto-expansion. */
  readonly matchedTerritories: ReadonlySet<TerritoryIndex>;
  readonly matchedRegions: ReadonlySet<RegionIndex>;
  /** True when no filter is active, so every group is shown whether it matches or not. */
  readonly unfiltered: boolean;
  /**
   * True when a *search term* is active, as distinct from a region filter.
   *
   * DECISION: only a search auto-expands groups. FR-3 says searching auto-expands
   * groups containing matches — a search narrows to a handful of rows that are
   * useless while collapsed, whereas a region filter narrows six regions to one
   * and auto-expanding it would dump ~8,000 rows on the user unasked. Both still
   * hide groups with no surviving rows — that's `unfiltered`, a separate question
   * from whether to open them.
   */
  readonly searchActive: boolean;
  readonly totalVisible: number;
}

/** Rows of territory `t` that pass the current filter, as a zero-copy view. */
export function visibleRows(filter: FilterResult, t: TerritoryIndex): Uint32Array {
  return filter.rows.subarray(readU32(filter.offsets, t), readU32(filter.offsets, t + 1));
}

/** How many rows of territory `t` pass the current filter. */
export function visibleCount(filter: FilterResult, t: TerritoryIndex): number {
  return readU32(filter.offsets, t + 1) - readU32(filter.offsets, t);
}

export const filterRows = memo1(
  (dataset: Dataset, groups: GroupIndex, search: string, regionFilter: string | null): FilterResult => {
    const started = performance.now();
    const needle = search.trim().toLowerCase();
    const unfiltered = needle === '' && regionFilter === null;

    // PERF: the resting case reuses the group index's own CSR arrays instead of
    // copying 50,000 indices to produce an identical result — typing then
    // clearing a search returns to zero allocation.
    if (unfiltered) {
      pipelineTimings.filterMs = performance.now() - started;
      return {
        rows: groups.rowsByTerritory,
        offsets: groups.territoryOffsets,
        matchedTerritories: NO_MATCH_SET_NEEDED_TERRITORIES,
        matchedRegions: NO_MATCH_SET_NEEDED_REGIONS,
        unfiltered: true,
        searchActive: false,
        totalVisible: dataset.count,
      };
    }

    const regionIndex = regionFilter === null ? -1 : groups.regionKeys.indexOf(regionFilter);
    // EDGE CASE: an unknown region name (a stale URL, a renamed region) filters to
    // nothing rather than silently behaving as "no filter" — showing all 50,000
    // rows because a filter failed to resolve would misrepresent what's applied.
    const regionUnresolvable = regionFilter !== null && regionIndex === -1;

    // DECISION: one fresh full-size buffer per pass, not a reused scratch array.
    // 200 KB per filter pass is cheap; a shared buffer would let the next
    // keystroke overwrite a result a component is still rendering from.
    const rows = new Uint32Array(dataset.count);
    const offsets = new Uint32Array(groups.territoryCount + 1);
    const matchedTerritories = new Set<TerritoryIndex>();
    const matchedRegions = new Set<RegionIndex>();

    let cursor = 0;
    if (!regionUnresolvable) {
      for (let t = 0; t < groups.territoryCount; t++) {
        offsets[t] = cursor;
        if (regionIndex !== -1 && readU8(groups.territoryRegion, t) !== regionIndex) continue;

        for (const rowKey of territoryRows(groups, asTerritoryIndex(t))) {
          // PERF: `includes` over the arrays lowercased once at load. Calling
          // `.toLowerCase()` here would allocate two strings per row per
          // keystroke — 100,000 allocations for one character typed.
          if (
            needle !== '' &&
            !readItem(dataset.nameLower, rowKey).includes(needle) &&
            !readItem(dataset.idLower, rowKey).includes(needle)
          ) {
            continue;
          }
          rows[cursor] = rowKey;
          cursor += 1;
        }

        if (cursor > readU32(offsets, t)) {
          matchedTerritories.add(asTerritoryIndex(t));
          matchedRegions.add(asRegionIndex(readU8(groups.territoryRegion, t)));
        }
      }
    }
    offsets[groups.territoryCount] = cursor;

    pipelineTimings.filterMs = performance.now() - started;
    return {
      rows,
      offsets,
      matchedTerritories,
      matchedRegions,
      unfiltered: false,
      searchActive: needle !== '',
      totalVisible: cursor,
    };
  },
);

/**
 * Placeholders for the unfiltered fast path.
 *
 * Empty rather than fully populated because nothing reads them: every consumer
 * guards on `filter.unfiltered` first (see `isRegionOpen`, `flatten`).
 */
const NO_MATCH_SET_NEEDED_TERRITORIES: ReadonlySet<TerritoryIndex> = new Set();
const NO_MATCH_SET_NEEDED_REGIONS: ReadonlySet<RegionIndex> = new Set();

// ---------------------------------------------------------------------------
// STAGE C — group totals and visible counts
// ---------------------------------------------------------------------------

/**
 * What a group header renders.
 *
 * DECISION — the load-bearing ambiguity in FR-2: **`totals` are for the whole
 * group and ignore the current search and filter; `visible` counts what is on
 * screen.** Both are shown, so the header reads "1,042 HCPs (3 matching)".
 *
 * Rejected: recomputing subtotals over only the filtered rows. (1) A subtotal is
 * a property of the territory, not the query — the same territory would report
 * different Σ Calls depending on what's typed in the search box. (2) FR-3
 * reorders groups by their aggregate; filtered totals would rearrange group
 * order on every keystroke. (3) It would forfeit the O(1) delta — an accepted
 * edit would have to rescan the filtered set instead of adding two integers.
 *
 * The honest cost: with a search active, Σ Calls in the header does not equal
 * the sum of the Calls column on screen. The `(N matching)` annotation makes
 * that legible rather than confusing.
 */
export interface GroupView {
  readonly totals: GroupTotals;
  readonly visible: number;
}

export interface GroupTotalsResult {
  readonly territory: readonly GroupView[];
  readonly region: readonly GroupView[];
}

export const groupTotals = memo1(
  (groups: GroupIndex, aggregates: Aggregates, filter: FilterResult): GroupTotalsResult => {
    const started = performance.now();

    const territory: GroupView[] = new Array<GroupView>(groups.territoryCount);
    const regionVisible = new Uint32Array(groups.regionCount);
    for (let t = 0; t < groups.territoryCount; t++) {
      const visible = visibleCount(filter, asTerritoryIndex(t));
      territory[t] = { totals: totalsAt(aggregates.territory, t), visible };
      const r = readU8(groups.territoryRegion, t);
      regionVisible[r] = readU32(regionVisible, r) + visible;
    }

    const region: GroupView[] = new Array<GroupView>(groups.regionCount);
    for (let r = 0; r < groups.regionCount; r++) {
      region[r] = { totals: totalsAt(aggregates.region, r), visible: readU32(regionVisible, r) };
    }

    // PERF: O(groups) — 54 iterations — not O(rows), because `aggregates` is
    // maintained incrementally by `applyCallsChange`; a derived recompute here
    // would be 50,000 rows on every accepted edit.
    pipelineTimings.aggregateMs = performance.now() - started;
    return { territory, region };
  },
);

// ---------------------------------------------------------------------------
// STAGE D — group ordering
// ---------------------------------------------------------------------------

export interface GroupOrder {
  readonly regions: readonly RegionIndex[];
  /** Indexed by RegionIndex: that region's territories in display order. */
  readonly territoriesByRegion: readonly (readonly TerritoryIndex[])[];
}

/**
 * Pick the aggregate a numeric sort column orders groups by.
 * @returns `null` when the group has no defined value for that column, which
 *   sorts last in both directions — the same rule as row-level nulls (§B4).
 */
function groupSortKey(totals: GroupTotals, column: ColumnId): number | null {
  switch (column) {
    case 'calls':
      return totals.sumCalls;
    case 'trx':
      return totals.sumTrx;
    case 'nrx':
      return totals.sumNrx;
    case 'cpi':
      return totals.cpi;
    case 'id':
    case 'name':
    case 'specialty':
    case 'region':
    case 'territory':
      return null;
    default: {
      const unhandled: never = column;
      throw new Error(`Unhandled group sort column: ${String(unhandled)}`);
    }
  }
}

/** Order group indices by a numeric aggregate, nulls last, alphabetical tiebreak. */
function orderByAggregate(indices: readonly number[], table: AggregateTable, spec: SortSpec): number[] {
  const sign = spec.direction === 'asc' ? 1 : -1;
  return [...indices].sort((a, b) => {
    const av = groupSortKey(totalsAt(table, a), spec.column);
    const bv = groupSortKey(totalsAt(table, b), spec.column);
    if (av === null) return bv === null ? a - b : 1;
    if (bv === null) return -1;
    return av !== bv ? sign * (av - bv) : a - b;
  });
}

/**
 * FR-3: when sorting a numeric column, groups reorder by their aggregate value of
 * that column.
 *
 * A text column or no sort keeps alphabetical order, which is the index order —
 * `regionKeys` and `territoryKeys` are sorted at build time (§D5), so the default
 * costs nothing.
 *
 * DECISION: takes `Aggregates` directly, not stage C's `GroupTotalsResult`. Stage
 * C carries per-group *visible* counts, so it produces a new object on every
 * keystroke — consuming it here would recompute group order on every keystroke to
 * arrive at an identical answer, invalidating every memo downstream. Group order
 * depends only on whole-group aggregates, which change only when an edit is
 * accepted; there's a test asserting the reference survives a search.
 */
export const orderGroups = memo1(
  (groups: GroupIndex, aggregates: Aggregates, sort: SortSpec | null): GroupOrder => {
    const alphabeticalRegions = Array.from({ length: groups.regionCount }, (_unused, r) => asRegionIndex(r));
    const alphabeticalTerritories = alphabeticalRegions.map((r) => {
      const [start, end] = regionTerritoryRange(groups, r);
      return Array.from({ length: end - start }, (_unused, i) => asTerritoryIndex(start + i));
    });

    if (sort === null || !isNumericColumn(sort.column)) {
      return { regions: alphabeticalRegions, territoriesByRegion: alphabeticalTerritories };
    }

    const regions = orderByAggregate(alphabeticalRegions, aggregates.region, sort).map(asRegionIndex);
    const territoriesByRegion = alphabeticalTerritories.map((territories) =>
      orderByAggregate(territories, aggregates.territory, sort).map(asTerritoryIndex),
    );
    return { regions, territoriesByRegion };
  },
);

// ---------------------------------------------------------------------------
// STAGE E — sorted rows per expanded territory
// ---------------------------------------------------------------------------

/**
 * Sorted row order for the territories that are actually expanded.
 *
 * PERF: 48 sorts of ~1,000 rows instead of one sort of 50,000. `n log n` is
 * superlinear, so splitting the work is cheaper even before the second saving:
 * only **expanded** territories are sorted at all, so the common case — a few
 * groups open — sorts a few thousand rows rather than fifty thousand. It also
 * delivers FR-3's "stable within groups" for free, since rows never cross a
 * territory boundary during a sort.
 *
 * The cache is a `WeakMap` keyed on the `committed` map, holding a string key of
 * `${territory}|${column}|${dir}|${filterVersion}`.
 *
 * DECISION: keyed on the `committed` reference rather than a version integer.
 * Sorting by Calls or CPI depends on accepted edits, so the cache must invalidate
 * when they change — a `WeakMap` does that with no counter to keep in sync and no
 * stale entries to evict, since a superseded `committed` map becomes unreachable
 * and takes its cache with it.
 */
const sortCache = new WeakMap<ReadonlyMap<RowKey, number>, Map<string, Uint32Array>>();

export function sortedTerritoryRows(
  dataset: Dataset,
  committed: ReadonlyMap<RowKey, number>,
  view: Store['view'],
  filter: FilterResult,
  territory: TerritoryIndex,
): Uint32Array {
  const base = visibleRows(filter, territory);
  const { sort } = view;
  if (sort === null) return base;

  let cache = sortCache.get(committed);
  if (cache === undefined) {
    cache = new Map();
    sortCache.set(committed, cache);
  }
  const key = `${territory}|${sort.column}|${sort.direction}|${view.filterVersion}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    pipelineTimings.sortCacheHits += 1;
    return cached;
  }

  const started = performance.now();
  const effectiveCalls = makeEffectiveCalls(dataset, committed);
  const comparator = makeComparator(sort, { dataset, callsOf: effectiveCalls });
  // `base` is a view over a shared buffer — copy before sorting, or it would
  // reorder the filter result other territories are still reading from.
  const sorted = base.slice().sort(comparator);
  pipelineTimings.sortMs += performance.now() - started;
  pipelineTimings.territoriesSorted += 1;

  cache.set(key, sorted);
  return sorted;
}

// ---------------------------------------------------------------------------
// STAGE F — flatten
// ---------------------------------------------------------------------------

export type FlatRow =
  | { readonly kind: 'region'; readonly region: RegionIndex }
  | { readonly kind: 'territory'; readonly territory: TerritoryIndex; readonly region: RegionIndex }
  | { readonly kind: 'data'; readonly rowKey: RowKey; readonly territory: TerritoryIndex };

/**
 * The React key for a flat row.
 *
 * INVARIANT: never the flat-list position. Position-based keys make React recycle
 * component state onto a different row as the window scrolls — an open edit box
 * would appear on the wrong doctor, and a pending spinner would follow the
 * viewport instead of the cell it belongs to.
 */
export function flatRowKey(row: FlatRow, groups: GroupIndex): string {
  switch (row.kind) {
    case 'region':
      return `r:${readItem(groups.regionKeys, row.region)}`;
    case 'territory':
      return `t:${readItem(groups.territoryKeys, row.territory)}`;
    case 'data':
      return `d:${row.rowKey}`;
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled flat row kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Whether a region is open, resolving user intent against search auto-expansion. */
export function isRegionOpen(
  view: Store['view'],
  filter: FilterResult,
  region: RegionIndex,
): boolean {
  return view.userExpanded.regions.get(region) ?? (filter.searchActive && filter.matchedRegions.has(region));
}

/** Whether a territory is open, resolving user intent against search auto-expansion. */
export function isTerritoryOpen(
  view: Store['view'],
  filter: FilterResult,
  territory: TerritoryIndex,
): boolean {
  return (
    view.userExpanded.territories.get(territory) ??
    (filter.searchActive && filter.matchedTerritories.has(territory))
  );
}

export interface FlattenResult {
  readonly rows: readonly FlatRow[];
  /** Data rows only — the FR-1 footer's denominator. */
  readonly dataRowCount: number;
}

/**
 * FR-1 + FR-2: the display list — region headers, territory headers, and the data
 * rows of expanded territories, in group order.
 *
 * DECISION: every input is passed as a separate argument rather than the store
 * state object. State identity changes on *every* `set()`, so a memo keyed on it
 * would re-flatten 50,000 rows when the user toggled a checkbox. Keyed on the
 * five things flatten actually reads, an unrelated change is a no-op. `groups` is
 * deliberately not among them: `order` already encodes the group structure.
 *
 * DECISION: when a filter is active, groups with zero surviving rows are omitted.
 * Rejected: always showing all 6 regions and 48 territories, which after a search
 * for one name leaves 47 empty headers to scroll past to reach the match.
 */
export const flatten = memo1(
  (
    dataset: Dataset,
    committed: ReadonlyMap<RowKey, number>,
    view: Store['view'],
    filter: FilterResult,
    order: GroupOrder,
  ): FlattenResult => {
    const started = performance.now();
    const rows: FlatRow[] = [];
    let dataRowCount = 0;

    for (const region of order.regions) {
      if (!filter.unfiltered && !filter.matchedRegions.has(region)) continue;
      rows.push({ kind: 'region', region });
      if (!isRegionOpen(view, filter, region)) continue;

      for (const territory of readItem(order.territoriesByRegion, region)) {
        if (!filter.unfiltered && !filter.matchedTerritories.has(territory)) continue;
        rows.push({ kind: 'territory', territory, region });
        if (!isTerritoryOpen(view, filter, territory)) continue;

        for (const rowKey of sortedTerritoryRows(dataset, committed, view, filter, territory)) {
          rows.push({ kind: 'data', rowKey: asRowKey(rowKey), territory });
          dataRowCount += 1;
        }
      }
    }

    pipelineTimings.flattenMs = performance.now() - started;
    return { rows, dataRowCount };
  },
);

// ---------------------------------------------------------------------------
// Composed entry point
// ---------------------------------------------------------------------------

export interface Pipeline {
  readonly filter: FilterResult;
  readonly totals: GroupTotalsResult;
  readonly order: GroupOrder;
  readonly flat: FlattenResult;
  readonly effectiveCalls: (rowKey: RowKey) => number | null;
}

/**
 * Run the whole pipeline for a store state.
 *
 * Each stage is memoised on its own inputs, so a change only re-runs what actually
 * depends on it:
 *
 *   A effectiveCalls  <- dataset, committed
 *   B filter          <- dataset, groups, search, regionFilter
 *   C groupTotals     <- groups, aggregates, B
 *   D orderGroups     <- groups, aggregates, sort          (NOT C — see the note there)
 *   E sortedRows      <- dataset, committed, sort, filterVersion, B  (expanded only)
 *   F flatten         <- view, B, D, E
 *
 * So: toggling expansion re-runs only F. Typing in the search box re-runs B, C and
 * F, and leaves group ordering alone. Accepting an edit re-runs C (54 iterations),
 * D, E for expanded territories, and F — and never touches the filter.
 */
export function selectPipeline(store: Store): Pipeline {
  return {
    filter: selectFilter(store),
    totals: selectTotals(store),
    order: selectOrder(store),
    flat: selectFlat(store),
    effectiveCalls: makeEffectiveCalls(store.dataset, store.committed),
  };
}

/**
 * The narrow entry points below each return a **memoised reference**, which is
 * what makes them safe inside `useStoreSelector`.
 *
 * INVARIANT: `selectPipeline` allocates its wrapper object and must never be used
 * as a selector — under `useSyncExternalStore`'s reference comparison it would
 * return a new object every render and loop forever. Components select the
 * specific stage they need.
 */
export function selectFilter(store: Store): FilterResult {
  return filterRows(store.dataset, store.groups, store.view.search, store.view.regionFilter);
}

export function selectTotals(store: Store): GroupTotalsResult {
  return groupTotals(store.groups, store.aggregates, selectFilter(store));
}

export function selectOrder(store: Store): GroupOrder {
  return orderGroups(store.groups, store.aggregates, store.view.sort);
}

export function selectFlat(store: Store): FlattenResult {
  return flatten(store.dataset, store.committed, store.view, selectFilter(store), selectOrder(store));
}

/**
 * Per-region visible row counts, as a typed array.
 *
 * Exists so a region header can read its own count as a **number** rather than
 * select an object: `useStoreSelector` compares by reference, so a selector
 * returning `{ visible, totals }` would allocate per render and loop.
 */
export const visibleByRegion = memo1((groups: GroupIndex, filter: FilterResult): Uint32Array => {
  const counts = new Uint32Array(groups.regionCount);
  for (let t = 0; t < groups.territoryCount; t++) {
    const r = readU8(groups.territoryRegion, t);
    counts[r] = readU32(counts, r) + visibleCount(filter, asTerritoryIndex(t));
  }
  return counts;
});

/** Visible row count for one region. */
export function selectRegionVisible(store: Store, region: RegionIndex): number {
  return readU32(visibleByRegion(store.groups, selectFilter(store)), region);
}

/**
 * Whether a single row passes the current search and region filter.
 *
 * PERF: O(1) — two substring tests against the precomputed lowercase arrays and
 * one integer compare. The alternative, scanning the filter result's territory
 * bucket for the row, is O(territory size) and runs on every undo.
 *
 * @returns which filter is excluding the row, or `null` if it is visible.
 */
export function rowFilterBlock(store: Store, rowKey: RowKey): 'search' | 'region' | 'both' | null {
  const needle = store.view.search.trim().toLowerCase();
  const bySearch =
    needle !== '' &&
    !readItem(store.dataset.nameLower, rowKey).includes(needle) &&
    !readItem(store.dataset.idLower, rowKey).includes(needle);

  const { regionFilter } = store.view;
  const byRegion =
    regionFilter !== null &&
    readItem(store.groups.regionKeys, readU8(store.groups.regionOf, rowKey)) !== regionFilter;

  if (bySearch && byRegion) return 'both';
  if (bySearch) return 'search';
  if (byRegion) return 'region';
  return null;
}

/**
 * Where a row sits in the current flattened list, or `-1` if it is not there.
 *
 * O(flat length) — bounded by what is displayed, not by the dataset — and runs
 * once per reveal, not per frame.
 */
export function flatIndexOfRow(store: Store, rowKey: RowKey): number {
  return selectFlat(store).rows.findIndex((row) => row.kind === 'data' && row.rowKey === rowKey);
}

/** Visible row count for one territory. */
export function selectTerritoryVisible(store: Store, territory: TerritoryIndex): number {
  return visibleCount(selectFilter(store), territory);
}

/**
 * The row-level CPI a cell renders, computed from the *effective* calls value so an
 * accepted edit moves the CPI column with it.
 *
 * EDGE CASE: routes through `rowCpi`, so `trx === 0` yields `null` rather than
 * `Infinity` — for all 112 such rows, seeded and natural alike.
 */
export function rowCpiOf(store: Pick<Store, 'dataset' | 'committed'>, rowKey: RowKey): number | null {
  return rowCpi(makeEffectiveCalls(store.dataset, store.committed)(rowKey), trxAt(store.dataset, rowKey));
}
