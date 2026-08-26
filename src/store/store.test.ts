import { beforeEach, describe, expect, it } from '@jest/globals';
import { fixture, hcp } from '../test/fixtures';
import { totalsAt } from '../domain/aggregate';
import { asRegionIndex, asRowKey, asTerritoryIndex } from '../domain/identity';
import { createHcpStore } from './store';
import type { HcpStore } from './store';
import { nextSortDirection } from './types';

/**
 * A four-row, two-region fixture. Small enough that every assertion names an
 * exact expected value rather than a shape.
 *
 *   0  Anita Sharma   West / T1      calls 10
 *   1  Omar Khan      West / T2      calls 20
 *   2  Priya Rao      Midwest / T1   calls 30
 *   3  Anita Sharma   Midwest / T1   calls 40   (duplicate name, distinct row)
 */
function makeStore(): HcpStore {
  return createHcpStore(
    fixture([
      hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10 }),
      hcp({ id: 'HCP-000002', name: 'Omar Khan', region: 'West', territory: 'West / T2', calls: 20 }),
      hcp({ id: 'HCP-000003', name: 'Priya Rao', region: 'Midwest', territory: 'Midwest / T1', calls: 30 }),
      hcp({ id: 'HCP-000004', name: 'Anita Sharma', region: 'Midwest', territory: 'Midwest / T1', calls: 40 }),
    ]),
  );
}

let store: HcpStore;
beforeEach(() => {
  store = makeStore();
});

describe('initial state', () => {
  it('holds the dataset and group index immutably', () => {
    const s = store.getState();
    expect(s.dataset.count).toBe(4);
    expect(s.groups.regionCount).toBe(2);
    expect(s.groups.territoryCount).toBe(3);
  });

  it('seeds aggregates from committed, which starts empty', () => {
    const s = store.getState();
    expect(s.committed.size).toBe(0);
    // Midwest / T1 holds rows 2 and 3.
    const midwestT1 = asTerritoryIndex(s.groups.territoryKeys.indexOf('Midwest / T1'));
    expect(totalsAt(s.aggregates.territory, midwestT1).sumCalls).toBe(70);
    expect(totalsAt(s.aggregates.territory, midwestT1).count).toBe(2);
  });

  it('keeps committed and cellState as two distinct maps', () => {
    // INVARIANT: the structural basis for "aggregates cannot see pending edits".
    const s = store.getState();
    expect(s.committed).not.toBe(s.cellState);
    expect(s.committed.size).toBe(0);
    expect(s.cellState.size).toBe(0);
  });

  it('starts reqId and commandId at 1 so 0 is never a valid ticket', () => {
    expect(store.getState().nextReqId).toBe(1);
    expect(store.getState().nextCommandId).toBe(1);
  });

  it('starts with the built-in default theme and no issues', () => {
    expect(store.getState().theme.tenantId).toBeNull();
    expect(store.getState().theme.theme.appName).toBe('HCP Data Explorer');
    expect(store.getState().theme.issues).toEqual([]);
  });
});

describe('setSearch', () => {
  it('stores the text and bumps filterVersion', () => {
    const before = store.getState().view.filterVersion;
    store.getState().setSearch('anita');
    expect(store.getState().view.search).toBe('anita');
    expect(store.getState().view.filterVersion).toBe(before + 1);
  });

  it('is a no-op for an unchanged value, so the sort cache is not invalidated', () => {
    store.getState().setSearch('anita');
    const version = store.getState().view.filterVersion;
    store.getState().setSearch('anita');
    expect(store.getState().view.filterVersion).toBe(version);
  });

  it('labels the operation for the footer', () => {
    store.getState().setSearch('anita');
    expect(store.getState().lastOp.label).toBe('search');
    store.getState().setSearch('');
    expect(store.getState().lastOp.label).toBe('clear search');
  });
});

describe('setRegionFilter', () => {
  it('stores the region name and bumps filterVersion', () => {
    const before = store.getState().view.filterVersion;
    store.getState().setRegionFilter('West');
    expect(store.getState().view.regionFilter).toBe('West');
    expect(store.getState().view.filterVersion).toBe(before + 1);
  });

  it('treats null as "no filter", not as a missing value', () => {
    store.getState().setRegionFilter('West');
    store.getState().setRegionFilter(null);
    expect(store.getState().view.regionFilter).toBeNull();
    expect(store.getState().lastOp.label).toBe('clear region filter');
  });
});

describe('toggleSort', () => {
  it('cycles asc -> desc -> none on the same column', () => {
    // FR-3 three-state sorting.
    store.getState().toggleSort('calls');
    expect(store.getState().view.sort).toEqual({ column: 'calls', direction: 'asc' });
    store.getState().toggleSort('calls');
    expect(store.getState().view.sort).toEqual({ column: 'calls', direction: 'desc' });
    store.getState().toggleSort('calls');
    expect(store.getState().view.sort).toBeNull();
  });

  it('restarts at asc when a different column is clicked', () => {
    // Carrying "descending" over to a new column surprises the user: descending is
    // a statement about a specific column, not a global mode.
    store.getState().toggleSort('calls');
    store.getState().toggleSort('calls');
    expect(store.getState().view.sort?.direction).toBe('desc');
    store.getState().toggleSort('name');
    expect(store.getState().view.sort).toEqual({ column: 'name', direction: 'asc' });
  });

  it('clearSort drops the sort instead of advancing it', () => {
    // toggleSort cycles, so a "reset" built from toggleSort would move asc -> desc.
    store.getState().toggleSort('calls');
    store.getState().clearSort();
    expect(store.getState().view.sort).toBeNull();
    expect(store.getState().lastOp.label).toBe('clear sort');
  });

  it('clearSort is a no-op when nothing is sorted', () => {
    const before = store.getState().view;
    store.getState().clearSort();
    expect(store.getState().view).toBe(before);
  });

  it('exposes the cycle as a pure function with an exhaustive switch', () => {
    expect(nextSortDirection(null)).toBe('asc');
    expect(nextSortDirection('asc')).toBe('desc');
    expect(nextSortDirection('desc')).toBeNull();
  });
});

describe('expansion intent', () => {
  it('records an explicit boolean rather than adding to a set', () => {
    const region = asRegionIndex(0);
    store.getState().toggleRegion(region);
    expect(store.getState().view.userExpanded.regions.get(region)).toBe(true);
    store.getState().toggleRegion(region);
    expect(store.getState().view.userExpanded.regions.get(region)).toBe(false);
  });

  it('starts with no opinion, which resolves to closed', () => {
    expect(store.getState().view.userExpanded.regions.size).toBe(0);
    expect(store.getState().view.userExpanded.territories.size).toBe(0);
  });

  it('lets a user CLOSE a group that the search auto-expanded', () => {
    // The case a two-Set model gets wrong: with `userExpanded` and
    // `searchExpanded` as separate sets, this toggle writes `true` to the user set
    // and the group stays open, so the chevron appears broken.
    store.getState().setSearch('anita');
    const territory = asTerritoryIndex(store.getState().groups.territoryKeys.indexOf('West / T1'));
    store.getState().toggleTerritory(territory);
    expect(store.getState().view.userExpanded.territories.get(territory)).toBe(false);
  });

  it('survives clearing the search, so manual expansion is not destroyed', () => {
    const region = asRegionIndex(0);
    store.getState().toggleRegion(region);
    store.getState().setSearch('anita');
    store.getState().setSearch('');
    expect(store.getState().view.userExpanded.regions.get(region)).toBe(true);
  });
});

describe('selection', () => {
  it('toggles an individual row', () => {
    const rowKey = asRowKey(0);
    store.getState().toggleRowSelection(rowKey);
    expect(store.getState().selection.has(rowKey)).toBe(true);
    store.getState().toggleRowSelection(rowKey);
    expect(store.getState().selection.has(rowKey)).toBe(false);
  });

  it('selects a whole territory regardless of the current filter', () => {
    // FR-5: a selection that silently changed size when the user typed in the
    // search box would be a trap.
    const midwestT1 = asTerritoryIndex(store.getState().groups.territoryKeys.indexOf('Midwest / T1'));
    store.getState().setSearch('anita');
    store.getState().selectTerritoryRows(midwestT1, true);
    expect(store.getState().selection).toEqual(new Set([asRowKey(2), asRowKey(3)]));
  });

  it('deselects a whole territory', () => {
    const midwestT1 = asTerritoryIndex(store.getState().groups.territoryKeys.indexOf('Midwest / T1'));
    store.getState().selectTerritoryRows(midwestT1, true);
    store.getState().selectTerritoryRows(midwestT1, false);
    expect(store.getState().selection.size).toBe(0);
  });

  it('clears without allocating when already empty', () => {
    const before = store.getState().selection;
    store.getState().clearSelection();
    expect(store.getState().selection).toBe(before);
  });
});

describe('history at rest', () => {
  it.each([
    ['undo', (s: HcpStore) => {
      s.getState().undo();
    }],
    ['redo', (s: HcpStore) => {
      s.getState().redo();
    }],
  ])('%s is a no-op with an empty history', (_label, call) => {
    const before = store.getState().history;
    call(store);
    expect(store.getState().history).toBe(before);
    expect(store.getState().committed.size).toBe(0);
  });

  it('commitEdit is implemented — its lifecycle is covered in editLifecycle.test.ts', async () => {
    // The default store uses the real vendor validator, so this only asserts the
    // action exists and does not throw synchronously. Every behavioural assertion
    // about the lifecycle uses an injected fake validator.
    await expect(store.getState().commitEdit(asRowKey(0), '10')).resolves.toBeUndefined();
  });
});

describe('store isolation', () => {
  it('gives each factory call independent state', () => {
    const other = makeStore();
    store.getState().setSearch('anita');
    expect(other.getState().view.search).toBe('');
  });
});
