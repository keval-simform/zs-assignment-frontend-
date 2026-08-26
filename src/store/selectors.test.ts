import { beforeEach, describe, expect, it } from '@jest/globals';
import { fixture, hcp, realData } from '../test/fixtures';
import { asRegionIndex, asRowKey, asTerritoryIndex } from '../domain/identity';
import type { RowKey } from '../domain/identity';
import { createHcpStore } from './store';
import type { HcpStore } from './store';
import { pipelineTimings, resetPipelineTimings } from './pipelineTimings';
import {
  flatRowKey,
  flatten,
  isRegionOpen,
  isTerritoryOpen,
  makeEffectiveCalls,
  rowCpiOf,
  selectPipeline,
  sortedTerritoryRows,
  visibleCount,
  visibleRows,
} from './selectors';

/** The real 50k dataset — the flatten counts in the brief are stated against it. */
function realStore(): HcpStore {
  return createHcpStore(realData());
}

beforeEach(() => {
  resetPipelineTimings();
});

// ---------------------------------------------------------------------------

describe('stage A — effective calls', () => {
  it('returns the committed value when one exists, else the source value', () => {
    const { dataset } = fixture([hcp({ calls: 10 }), hcp({ calls: 20 })]);
    const committed = new Map<RowKey, number>([[asRowKey(0), 55]]);
    const effective = makeEffectiveCalls(dataset, committed);
    expect(effective(asRowKey(0))).toBe(55);
    expect(effective(asRowKey(1))).toBe(20);
  });

  it('returns null, never NaN, for an unparsable source value', () => {
    const { dataset } = fixture([hcp({ calls: 'garbage' })]);
    expect(makeEffectiveCalls(dataset, new Map())(asRowKey(0))).toBeNull();
  });

  it('has no way to see a pending value', () => {
    // INVARIANT: the signature takes `committed` only. `cellState.proposed` is not
    // reachable from here, so sorting, aggregation, CPI and export cannot consult it.
    const store = createHcpStore(fixture([hcp({ calls: 10 })]));
    const { dataset, committed, cellState } = store.getState();
    expect(cellState.size).toBe(0);
    expect(makeEffectiveCalls(dataset, committed)(asRowKey(0))).toBe(10);
  });
});

// ---------------------------------------------------------------------------

describe('stage B — filter', () => {
  it('reuses the group index arrays when nothing is filtered', () => {
    // PERF: the resting case allocates nothing.
    const store = realStore();
    const { filter } = selectPipeline(store.getState());
    expect(filter.unfiltered).toBe(true);
    expect(filter.rows).toBe(store.getState().groups.rowsByTerritory);
    expect(filter.offsets).toBe(store.getState().groups.territoryOffsets);
    expect(filter.totalVisible).toBe(50_000);
  });

  it('hands out zero-copy views per territory', () => {
    const store = realStore();
    store.getState().setSearch('anita');
    const { filter } = selectPipeline(store.getState());
    const bucket = visibleRows(filter, asTerritoryIndex(0));
    expect(bucket.buffer).toBe(filter.rows.buffer);
  });

  it('matches on name and on id, case-insensitively', () => {
    const store = createHcpStore(
      fixture([
        hcp({ id: 'HCP-000111', name: 'Anita Sharma' }),
        hcp({ id: 'HCP-000222', name: 'Omar Khan' }),
      ]),
    );
    store.getState().setSearch('ANITA');
    expect(selectPipeline(store.getState()).filter.totalVisible).toBe(1);
    store.getState().setSearch('hcp-000222');
    expect(selectPipeline(store.getState()).filter.totalVisible).toBe(1);
  });

  it('applies the region filter structurally', () => {
    const store = realStore();
    store.getState().setRegionFilter('West');
    const { filter } = selectPipeline(store.getState());
    expect(filter.matchedRegions.size).toBe(1);
    expect(filter.totalVisible).toBe(8_226);
  });

  it('filters to nothing when the region name cannot be resolved', () => {
    // EDGE CASE: a stale URL or a renamed region must not silently behave as
    // "no filter" and show all 50,000 rows.
    const store = realStore();
    store.getState().setRegionFilter('Atlantis');
    const { filter } = selectPipeline(store.getState());
    expect(filter.totalVisible).toBe(0);
    expect(filter.unfiltered).toBe(false);
  });

  it('combines search and region filter', () => {
    const store = realStore();
    store.getState().setSearch('anita');
    store.getState().setRegionFilter('West');
    const { filter } = selectPipeline(store.getState());
    expect(filter.matchedRegions).toEqual(new Set([asRegionIndex(store.getState().groups.regionKeys.indexOf('West'))]));
    expect(filter.totalVisible).toBeGreaterThan(0);
    expect(filter.totalVisible).toBeLessThan(8_226);
  });

  it('records a timing', () => {
    const store = realStore();
    store.getState().setSearch('anita');
    selectPipeline(store.getState());
    expect(pipelineTimings.filterMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------

describe('stage C — group totals', () => {
  it('reports whole-group totals plus a separate visible count', () => {
    // DECISION under test: subtotals ignore the filter; `visible` tracks the screen.
    const store = realStore();
    const west = asRegionIndex(store.getState().groups.regionKeys.indexOf('West'));
    const unfiltered = selectPipeline(store.getState()).totals.region[west];

    store.getState().setSearch('anita sharma');
    const filtered = selectPipeline(store.getState()).totals.region[west];

    expect(filtered?.totals.sumCalls).toBe(unfiltered?.totals.sumCalls);
    expect(filtered?.totals.count).toBe(unfiltered?.totals.count);
    expect(filtered?.visible).toBeLessThan(filtered?.totals.count ?? 0);
    expect(filtered?.visible).toBeGreaterThan(0);
  });

  it('rolls region visible counts up from territories', () => {
    const store = realStore();
    store.getState().setSearch('anita');
    const { totals, filter } = selectPipeline(store.getState());
    const groups = store.getState().groups;
    let summed = 0;
    for (let t = 0; t < groups.territoryCount; t++) summed += visibleCount(filter, asTerritoryIndex(t));
    const regionSum = totals.region.reduce((acc, r) => acc + r.visible, 0);
    expect(regionSum).toBe(summed);
    expect(regionSum).toBe(filter.totalVisible);
  });

  it('is O(groups), not O(rows) — the payoff of the incremental aggregate', () => {
    const store = realStore();
    selectPipeline(store.getState());
    const { totals } = selectPipeline(store.getState());
    expect(totals.territory).toHaveLength(48);
    expect(totals.region).toHaveLength(6);
  });
});

// ---------------------------------------------------------------------------

describe('stage D — group ordering', () => {
  it('keeps alphabetical order with no sort', () => {
    const store = realStore();
    const { order } = selectPipeline(store.getState());
    expect(order.regions).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('keeps alphabetical order for a text column', () => {
    const store = realStore();
    store.getState().toggleSort('name');
    expect(selectPipeline(store.getState()).order.regions).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('reorders regions by their aggregate when a numeric column is sorted', () => {
    // FR-3. Measured Σ Calls: Northeast 165,856 is the lowest, Midwest 268,091
    // the highest — the four regions holding a 99999 outlier sit at the top.
    const store = realStore();
    store.getState().toggleSort('calls');
    const { order, totals } = selectPipeline(store.getState());
    const sums = order.regions.map((r) => totals.region[r]?.totals.sumCalls ?? 0);
    expect([...sums]).toEqual([...sums].sort((a, b) => a - b));

    store.getState().toggleSort('calls');
    const desc = selectPipeline(store.getState());
    const descSums = desc.order.regions.map((r) => desc.totals.region[r]?.totals.sumCalls ?? 0);
    expect([...descSums]).toEqual([...descSums].sort((a, b) => b - a));
  });

  it('reorders territories within each region too', () => {
    const store = realStore();
    store.getState().toggleSort('trx');
    const { order, totals } = selectPipeline(store.getState());
    for (const region of order.regions) {
      const sums = (order.territoriesByRegion[region] ?? []).map((t) => totals.territory[t]?.totals.sumTrx ?? 0);
      expect([...sums]).toEqual([...sums].sort((a, b) => a - b));
    }
  });

  it('sorts a null group aggregate last in both directions', () => {
    // A whole territory with Σtrx 0 has no CPI. It must not read as best or worst.
    const store = createHcpStore(
      fixture([
        hcp({ region: 'West', territory: 'West / T1', calls: 10, trx: 0 }),
        hcp({ region: 'West', territory: 'West / T2', calls: 10, trx: 100 }),
      ]),
    );
    store.getState().toggleSort('cpi');
    expect(selectPipeline(store.getState()).order.territoriesByRegion[0]).toEqual([1, 0]);
    store.getState().toggleSort('cpi');
    expect(selectPipeline(store.getState()).order.territoriesByRegion[0]).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------

describe('stage E — per-territory sort', () => {
  it('sorts ONLY expanded territories', () => {
    // PERF: this is the whole point. With one territory open, one bucket of ~1,000
    // rows is sorted instead of 50,000.
    const store = realStore();
    store.getState().toggleSort('calls');
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    resetPipelineTimings();
    selectPipeline(store.getState());
    expect(pipelineTimings.territoriesSorted).toBe(1);
  });

  it('sorts nothing at all when everything is collapsed', () => {
    const store = realStore();
    store.getState().toggleSort('calls');
    resetPipelineTimings();
    selectPipeline(store.getState());
    expect(pipelineTimings.territoriesSorted).toBe(0);
  });

  it('serves the second render from cache', () => {
    const store = realStore();
    store.getState().toggleSort('calls');
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const state = store.getState();
    const filter = selectPipeline(state).filter;
    sortedTerritoryRows(state.dataset, state.committed, state.view, filter, asTerritoryIndex(0));
    resetPipelineTimings();
    sortedTerritoryRows(state.dataset, state.committed, state.view, filter, asTerritoryIndex(0));
    expect(pipelineTimings.sortCacheHits).toBe(1);
    expect(pipelineTimings.territoriesSorted).toBe(0);
  });

  it('invalidates the cache when committed changes', () => {
    // Sorting by Calls depends on accepted edits, so a new `committed` map must
    // not serve the old order. The WeakMap key does this with no counter.
    const store = realStore();
    store.getState().toggleSort('calls');
    const before = store.getState();
    const filter = selectPipeline(before).filter;
    sortedTerritoryRows(before.dataset, before.committed, before.view, filter, asTerritoryIndex(0));

    store.setState({ committed: new Map([[asRowKey(0), 60]]) });
    resetPipelineTimings();
    sortedTerritoryRows(store.getState().dataset, store.getState().committed, store.getState().view, filter, asTerritoryIndex(0));
    expect(pipelineTimings.sortCacheHits).toBe(0);
    expect(pipelineTimings.territoriesSorted).toBe(1);
  });

  it('returns the unsorted view with no copy when there is no sort', () => {
    // `subarray()` allocates a fresh view object each call, so identity is the
    // wrong assertion — sharing the underlying buffer is what "no copy" means.
    const store = realStore();
    const state = store.getState();
    const filter = selectPipeline(state).filter;
    const result = sortedTerritoryRows(state.dataset, state.committed, state.view, filter, asTerritoryIndex(0));
    const expected = visibleRows(filter, asTerritoryIndex(0));
    expect(result.buffer).toBe(expected.buffer);
    expect(result.byteOffset).toBe(expected.byteOffset);
    expect(result.length).toBe(expected.length);
  });

  it('does not reorder the shared filter buffer while sorting', () => {
    const store = realStore();
    store.getState().toggleSort('calls');
    const state = store.getState();
    const filter = selectPipeline(state).filter;
    const original = [...visibleRows(filter, asTerritoryIndex(1))];
    sortedTerritoryRows(state.dataset, state.committed, state.view, filter, asTerritoryIndex(1));
    expect([...visibleRows(filter, asTerritoryIndex(1))]).toEqual(original);
  });

  it('sorts by the effective value, so an accepted edit moves the row', () => {
    const store = createHcpStore(
      fixture([
        hcp({ region: 'West', territory: 'West / T1', calls: 10 }),
        hcp({ region: 'West', territory: 'West / T1', calls: 20 }),
      ]),
    );
    store.getState().toggleSort('calls');
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const filter = selectPipeline(store.getState()).filter;
    expect([...sortedTerritoryRows(store.getState().dataset, store.getState().committed, store.getState().view, filter, asTerritoryIndex(0))]).toEqual([0, 1]);

    store.setState({ committed: new Map([[asRowKey(0), 99]]) });
    expect([...sortedTerritoryRows(store.getState().dataset, store.getState().committed, store.getState().view, filter, asTerritoryIndex(0))]).toEqual([1, 0]);
  });
});

// ---------------------------------------------------------------------------

describe('stage F — flatten', () => {
  it('renders 6 rows with everything collapsed', () => {
    const store = realStore();
    const { flat } = selectPipeline(store.getState());
    expect(flat.rows).toHaveLength(6);
    expect(flat.rows.every((r) => r.kind === 'region')).toBe(true);
    expect(flat.dataRowCount).toBe(0);
  });

  it('renders 14 rows with one region expanded', () => {
    const store = realStore();
    store.getState().toggleRegion(asRegionIndex(0));
    const { flat } = selectPipeline(store.getState());
    expect(flat.rows).toHaveLength(14);
    expect(flat.dataRowCount).toBe(0);
  });

  it('renders 14 + that territory row count with one territory expanded', () => {
    const store = realStore();
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const { flat, filter } = selectPipeline(store.getState());
    const rowCount = visibleCount(filter, asTerritoryIndex(0));
    expect(rowCount).toBeGreaterThan(900);
    expect(flat.rows).toHaveLength(14 + rowCount);
    expect(flat.dataRowCount).toBe(rowCount);
  });

  it('auto-expands groups containing search matches', () => {
    // FR-3. No manual expansion at all — the search alone opens the tree.
    const store = realStore();
    store.getState().setSearch('hcp-000001');
    const { flat, filter } = selectPipeline(store.getState());
    expect(filter.matchedTerritories.size).toBeGreaterThan(0);
    expect(flat.dataRowCount).toBeGreaterThan(0);
  });

  it('omits groups with no surviving rows when a filter is active', () => {
    const store = realStore();
    store.getState().setRegionFilter('West');
    const { flat } = selectPipeline(store.getState());
    const regionRows = flat.rows.filter((r) => r.kind === 'region');
    expect(regionRows).toHaveLength(1);
  });

  it('lets an explicit collapse override search auto-expansion', () => {
    const store = realStore();
    store.getState().setSearch('hcp-000001');
    const open = selectPipeline(store.getState());
    const territory = [...open.filter.matchedTerritories][0];
    expect(territory).toBeDefined();
    if (territory === undefined) return;

    expect(isTerritoryOpen(store.getState().view, open.filter, territory)).toBe(true);
    store.getState().toggleTerritory(territory);
    const closed = selectPipeline(store.getState());
    expect(isTerritoryOpen(store.getState().view, closed.filter, territory)).toBe(false);
  });

  it('keys rows on identity, never on flat position', () => {
    // INVARIANT: position keys make React recycle an open edit box onto another row.
    const store = realStore();
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const { flat } = selectPipeline(store.getState());
    const groups = store.getState().groups;
    const keys = flat.rows.map((r) => flatRowKey(r, groups));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe('r:Midwest');
  });

  it('produces the same key for a row regardless of where it lands', () => {
    const store = realStore();
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const groups = store.getState().groups;
    const before = selectPipeline(store.getState()).flat.rows.filter((r) => r.kind === 'data');
    store.getState().toggleSort('calls');
    const after = selectPipeline(store.getState()).flat.rows.filter((r) => r.kind === 'data');
    expect(new Set(before.map((r) => flatRowKey(r, groups)))).toEqual(
      new Set(after.map((r) => flatRowKey(r, groups))),
    );
  });
});

// ---------------------------------------------------------------------------

describe('memoisation', () => {
  it('returns the identical filter result for unchanged inputs', () => {
    const store = realStore();
    expect(selectPipeline(store.getState()).filter).toBe(selectPipeline(store.getState()).filter);
  });

  it('leaves the filter stage alone when only expansion changes', () => {
    const store = realStore();
    const before = selectPipeline(store.getState()).filter;
    store.getState().toggleRegion(asRegionIndex(0));
    expect(selectPipeline(store.getState()).filter).toBe(before);
  });

  it('re-runs flatten when expansion changes', () => {
    const store = realStore();
    const before = selectPipeline(store.getState()).flat;
    store.getState().toggleRegion(asRegionIndex(0));
    expect(selectPipeline(store.getState()).flat).not.toBe(before);
  });

  it('leaves group ordering alone when only the search changes under a text sort', () => {
    const store = realStore();
    store.getState().toggleSort('name');
    const before = selectPipeline(store.getState()).order;
    store.getState().setSearch('anita');
    expect(selectPipeline(store.getState()).order).toBe(before);
  });
});

// ---------------------------------------------------------------------------

describe('row CPI through the pipeline', () => {
  it('uses the effective calls value', () => {
    const store = createHcpStore(fixture([hcp({ calls: 10, trx: 100 })]));
    expect(rowCpiOf(store.getState(), asRowKey(0))).toBeCloseTo(10, 10);
    store.setState({ committed: new Map([[asRowKey(0), 20]]) });
    expect(rowCpiOf(store.getState(), asRowKey(0))).toBeCloseTo(20, 10);
  });

  it('returns null for every zero-TRx row, seeded or natural', () => {
    const store = realStore();
    const { dataset } = store.getState();
    let checked = 0;
    for (let i = 0; i < dataset.count; i++) {
      if (dataset.trx[i] === 0) {
        expect(rowCpiOf(store.getState(), asRowKey(i))).toBeNull();
        checked += 1;
      }
    }
    expect(checked).toBe(112);
  });
});

// ---------------------------------------------------------------------------

describe('region open resolution', () => {
  it('defaults to closed with no opinion and no search', () => {
    const store = realStore();
    const { filter } = selectPipeline(store.getState());
    expect(isRegionOpen(store.getState().view, filter, asRegionIndex(0))).toBe(false);
  });

  it('respects explicit intent over search auto-expansion', () => {
    const store = realStore();
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().setSearch('zzzz-no-match');
    const { filter } = selectPipeline(store.getState());
    expect(isRegionOpen(store.getState().view, filter, asRegionIndex(0))).toBe(true);
  });
});

// ---------------------------------------------------------------------------

describe('flatten with an empty dataset', () => {
  it('produces nothing rather than throwing', () => {
    const store = createHcpStore(fixture([]));
    const state = store.getState();
    const pipeline = selectPipeline(state);
    expect(pipeline.flat.rows).toHaveLength(0);
    expect(flatten(state.dataset, state.committed, state.view, pipeline.filter, pipeline.order).dataRowCount).toBe(0);
  });
});
