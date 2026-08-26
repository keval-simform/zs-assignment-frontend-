import { beforeEach, describe, expect, it } from '@jest/globals';
import { fixture, hcp } from '../test/fixtures';
import { createFakeValidator, CAP_REJECTION } from '../test/fakeValidator';
import type { FakeValidator } from '../test/fakeValidator';
import { totalsAt } from '../domain/aggregate';
import { asRegionIndex, asRowKey, asTerritoryIndex } from '../domain/identity';
import type { RowKey } from '../domain/identity';
import { createHcpStore } from './store';
import type { HcpStore } from './store';
import { isRegionOpen, isTerritoryOpen, selectFilter } from './selectors';

/**
 * FR-4: undo/redo as a command history, "correct regardless of the current sort,
 * filter, or grouping state".
 */

let store: HcpStore;
let validator: FakeValidator;

/**
 *   0  Anita Sharma  West / T1     calls 10
 *   1  Omar Khan     West / T1     calls 20
 *   2  Priya Rao     Midwest / T1  calls 30
 */
function makeStore(): { store: HcpStore; validator: FakeValidator } {
  const fake = createFakeValidator();
  return {
    store: createHcpStore(
      fixture([
        hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10 }),
        hcp({ id: 'HCP-000002', name: 'Omar Khan', region: 'West', territory: 'West / T1', calls: 20 }),
        hcp({ id: 'HCP-000003', name: 'Priya Rao', region: 'Midwest', territory: 'Midwest / T1', calls: 30 }),
      ]),
      fake,
    ),
    validator: fake,
  };
}

/** Commit an edit and let it succeed. */
async function accept(rowKey: RowKey, value: string): Promise<void> {
  const inFlight = store.getState().commitEdit(rowKey, value);
  const call = validator.inFlight[0];
  if (call === undefined) throw new Error('no validator call was made');
  validator.settle(call.id, 'ok');
  await inFlight;
}

function westT1Calls(): number {
  const t = asTerritoryIndex(store.getState().groups.territoryKeys.indexOf('West / T1'));
  return totalsAt(store.getState().aggregates.territory, t).sumCalls;
}

beforeEach(() => {
  ({ store, validator } = makeStore());
});

// ---------------------------------------------------------------------------

describe('apply / invert symmetry', () => {
  it('undo restores the previous value and the previous aggregate', async () => {
    const rowKey = asRowKey(0);
    expect(westT1Calls()).toBe(30);

    await accept(rowKey, '40');
    expect(store.getState().committed.get(rowKey)).toBe(40);
    expect(westT1Calls()).toBe(60);

    store.getState().undo();
    expect(store.getState().committed.has(rowKey)).toBe(false);
    expect(westT1Calls()).toBe(30);
  });

  it('redo re-applies it', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    store.getState().undo();
    store.getState().redo();
    expect(store.getState().committed.get(rowKey)).toBe(40);
    expect(westT1Calls()).toBe(60);
  });

  it('survives a full round trip through several edits', async () => {
    await accept(asRowKey(0), '40');
    await accept(asRowKey(1), '50');
    await accept(asRowKey(0), '45');
    expect(westT1Calls()).toBe(95);

    store.getState().undo();
    store.getState().undo();
    store.getState().undo();
    expect(westT1Calls()).toBe(30);
    expect(store.getState().committed.size).toBe(0);

    store.getState().redo();
    store.getState().redo();
    store.getState().redo();
    expect(westT1Calls()).toBe(95);
  });

  it('makes NO validator call on undo or redo', async () => {
    // The `before` value was accepted when it was written. Re-validating would add
    // latency and a 10% chance of a spurious 503 to an operation whose whole job is
    // restoring a known-good state — a user would watch their own accepted edit get
    // rejected, with no way to tell the rejection was noise.
    await accept(asRowKey(0), '40');
    expect(validator.calls).toHaveLength(1);

    store.getState().undo();
    store.getState().redo();
    store.getState().undo();
    expect(validator.calls).toHaveLength(1);
  });

  it('clears the saved badge, which would otherwise assert something false', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    expect(store.getState().cellState.get(rowKey)?.kind).toBe('saved');
    store.getState().undo();
    expect(store.getState().cellState.has(rowKey)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('what does and does not enter history', () => {
  it('a rejected edit never enters history', async () => {
    const inFlight = store.getState().commitEdit(asRowKey(0), '75');
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;
    // Nothing was committed, so there is nothing to undo.
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('a no-op edit never enters history', async () => {
    await store.getState().commitEdit(asRowKey(0), '10');
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('an unparsable edit never enters history', async () => {
    await store.getState().commitEdit(asRowKey(0), 'nope');
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('a new edit clears the redo stack', async () => {
    await accept(asRowKey(0), '40');
    store.getState().undo();
    expect(store.getState().history.future).toHaveLength(1);

    await accept(asRowKey(1), '50');
    // The undone future branched off a state that no longer exists.
    expect(store.getState().history.future).toHaveLength(0);
  });

  it('caps history at 100 commands', async () => {
    // Each bulk command can hold thousands of entries, so an uncapped history is
    // unbounded memory rather than a slowly growing array.
    for (let i = 0; i < 105; i++) {
      await accept(asRowKey(0), String(i % 2 === 0 ? 41 : 42));
    }
    expect(store.getState().history.past).toHaveLength(100);
  });
});

// ---------------------------------------------------------------------------

describe('STRICT LIFO', () => {
  it('undoes only the most recent command', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '20'); // 10 -> 20
    await accept(rowKey, '30'); // 20 -> 30

    store.getState().undo();
    // Not 10: LIFO means the second command inverts first.
    expect(store.getState().committed.get(rowKey)).toBe(20);
    store.getState().undo();
    expect(store.getState().committed.has(rowKey)).toBe(false);
  });

  it('is what stops a stale `before` from clobbering a newer value', async () => {
    // Out-of-order undo would write the first command's `before: 10` over a cell
    // that currently holds 30, silently discarding the second edit. LIFO makes that
    // conflict impossible by construction rather than by a merge rule.
    const rowKey = asRowKey(0);
    await accept(rowKey, '20');
    await accept(rowKey, '30');
    const [first] = store.getState().history.past;
    expect(first).toMatchObject({ entry: { before: 10, after: 20 } });
    // There is no API that could apply it out of order.
    store.getState().undo();
    expect(store.getState().committed.get(rowKey)).toBe(20);
  });
});

// ---------------------------------------------------------------------------

describe('undo is refused while an edit is in flight', () => {
  it('refuses and explains, rather than ignoring the keystroke', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');

    // A second edit on the same row, left pending.
    void store.getState().commitEdit(rowKey, '45');
    expect(store.getState().cellState.get(rowKey)?.kind).toBe('pending');

    store.getState().undo();
    // The in-flight request will settle and write `committed`. If undo ran first the
    // two writes would order by latency rather than by intent.
    expect(store.getState().committed.get(rowKey)).toBe(40);
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().toasts[0]?.title).toBe('Cannot undo yet');
  });

  it('allows undo once the in-flight edit settles', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    const second = store.getState().commitEdit(rowKey, '45');
    store.getState().undo();
    expect(store.getState().committed.get(rowKey)).toBe(40);

    validator.settle(2, 'ok');
    await second;
    store.getState().undo();
    expect(store.getState().committed.get(rowKey)).toBe(40);
  });

  it('refuses redo the same way', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    store.getState().undo();
    void store.getState().commitEdit(rowKey, '55');
    store.getState().redo();
    expect(store.getState().history.future).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------

describe('undo is independent of sort, filter and grouping (FR-4)', () => {
  it('reverts the value and reveals the row after a re-sort and a hiding filter', async () => {
    // The intersection case: the row is edited, then the view is rearranged and the
    // row filtered out of sight, and undo still has to be correct.
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    expect(westT1Calls()).toBe(60);

    store.getState().toggleSort('calls');
    store.getState().toggleSort('calls');
    store.getState().setSearch('priya'); // excludes Anita Sharma entirely

    expect(selectFilter(store.getState()).totalVisible).toBe(1);

    store.getState().undo();

    // The change is applied regardless of what the view is showing.
    expect(store.getState().committed.has(rowKey)).toBe(false);
    expect(westT1Calls()).toBe(30);
    // And the view says so, rather than silently doing nothing visible.
    expect(store.getState().reveal).toMatchObject({ rowKey, blockedBy: 'search' });
    expect(store.getState().toasts[0]?.action).toEqual({ kind: 'show' });
    expect(store.getState().toasts[0]?.detail).toContain('search');
  });

  it('"Show it" drops only the filter that was in the way', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    store.getState().setSearch('priya');
    store.getState().setRegionFilter('West');
    store.getState().undo();

    store.getState().showHiddenRow(rowKey);
    // The search excluded the row; the region filter did not, so it survives.
    expect(store.getState().view.search).toBe('');
    expect(store.getState().view.regionFilter).toBe('West');
    expect(store.getState().reveal).toMatchObject({ rowKey, blockedBy: null });
  });

  it('expands both ancestor groups when the row is inside a collapsed group', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '40');
    const filter = selectFilter(store.getState());
    const region = asRegionIndex(store.getState().groups.regionOf[0] ?? 0);
    const territory = asTerritoryIndex(store.getState().groups.territoryOf[0] ?? 0);
    expect(isRegionOpen(store.getState().view, filter, region)).toBe(false);

    store.getState().undo();

    const after = selectFilter(store.getState());
    expect(isRegionOpen(store.getState().view, after, region)).toBe(true);
    expect(isTerritoryOpen(store.getState().view, after, territory)).toBe(true);
    expect(store.getState().flashRowKeys.has(rowKey)).toBe(true);
  });

  it('issues a fresh reveal each time, so undoing twice into one row still fires', async () => {
    const rowKey = asRowKey(0);
    await accept(rowKey, '20');
    await accept(rowKey, '30');

    store.getState().undo();
    const first = store.getState().reveal;
    store.getState().consumeReveal();
    store.getState().undo();
    const second = store.getState().reveal;

    expect(first?.nonce).toBeDefined();
    expect(second?.nonce).toBe((first?.nonce ?? 0) + 1);
  });

  it('undo works while a completely different region is expanded', async () => {
    await accept(asRowKey(2), '99'); // Midwest
    store.getState().toggleRegion(asRegionIndex(store.getState().groups.regionKeys.indexOf('West')));
    store.getState().undo();
    expect(store.getState().committed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('aggregate integrity across undo', () => {
  it('returns aggregates to exactly their starting numbers', async () => {
    const territory = asTerritoryIndex(store.getState().groups.territoryKeys.indexOf('West / T1'));
    const before = totalsAt(store.getState().aggregates.territory, territory);

    await accept(asRowKey(0), '40');
    await accept(asRowKey(1), '55');
    store.getState().undo();
    store.getState().undo();

    const after = totalsAt(store.getState().aggregates.territory, territory);
    expect(after).toEqual(before);
  });

  it('moves the region level in step with the territory level', async () => {
    const west = asRegionIndex(store.getState().groups.regionKeys.indexOf('West'));
    const before = totalsAt(store.getState().aggregates.region, west).sumCalls;
    await accept(asRowKey(0), '40');
    expect(totalsAt(store.getState().aggregates.region, west).sumCalls).toBe(before + 30);
    store.getState().undo();
    expect(totalsAt(store.getState().aggregates.region, west).sumCalls).toBe(before);
  });
});
