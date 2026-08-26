import { beforeEach, describe, expect, it } from '@jest/globals';
import { fixture, hcp } from '../test/fixtures';
import { createFakeValidator } from '../test/fakeValidator';
import type { FakeValidator } from '../test/fakeValidator';
import { totalsAt } from '../domain/aggregate';
import type { GroupTotals } from '../domain/aggregate';
import { asCommandId, asOpId, asRowKey } from '../domain/identity';
import type { RowKey } from '../domain/identity';
import { applyCommand, describeCommand, writeEntries } from './commands';
import { createHcpStore } from './store';
import type { HcpStore } from './store';
import type { Command, EditEntry } from './types';

/**
 * FR-5 / FR-6 are **design deliverables and are not implemented** — there is no
 * bulk runner, no concurrency queue, and no selection UI (README §5, §7). What
 * this file tests is the one primitive those designs rest on, which *is* built:
 * that a command holding many entries is **exactly one undo step**, and that
 * inverting it returns both aggregate levels to their starting numbers.
 *
 * Why test it without the feature: README §5.2 claims the applied subset of a
 * partially-failed bulk operation becomes a single `bulk-edit` command that
 * undoes through `writeEntries(..., 'invert')` — the same function a single-cell
 * undo uses, no new code path. Every other test in this suite exercises
 * `cell-edit`, whose `entry` is a single object; nothing had constructed the
 * `bulk-edit` variant before, so the multi-entry claim was untested. It is now.
 *
 * The command below is hand-built exactly as `finalize(opId)` would build it: the
 * accepted values are already in `committed` (the design writes them per entry as
 * each is accepted, so subtotals climb during the operation), and only the
 * *history entry* is deferred to the end.
 */

let store: HcpStore;
let validator: FakeValidator;

/**
 * Seven rows spanning two regions and four territories, so the region rollup is
 * genuinely exercised rather than trivially equal to one territory.
 *
 *   0  West / T1     calls 10   applied  -> 11
 *   1  West / T1     calls 20   applied  -> 22
 *   2  West / T2     calls 30   applied  -> 33
 *   3  West / T2     calls 40   applied  -> 44
 *   4  Midwest / T1  calls 50   applied  -> 55
 *   5  Midwest / T1  calls 60   REJECTED (cap)       — never written
 *   6  Midwest / T2  calls 70   REJECTED (transient) — never written
 */
function makeStore(): { store: HcpStore; validator: FakeValidator } {
  const fake = createFakeValidator();
  return {
    store: createHcpStore(
      fixture([
        hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10, trx: 100 }),
        hcp({ id: 'HCP-000002', name: 'Omar Khan', region: 'West', territory: 'West / T1', calls: 20, trx: 200 }),
        hcp({ id: 'HCP-000003', name: 'Priya Rao', region: 'West', territory: 'West / T2', calls: 30, trx: 300 }),
        hcp({ id: 'HCP-000004', name: 'Chen Wang', region: 'West', territory: 'West / T2', calls: 40, trx: 400 }),
        hcp({ id: 'HCP-000005', name: 'Nina Das', region: 'Midwest', territory: 'Midwest / T1', calls: 50, trx: 500 }),
        hcp({ id: 'HCP-000006', name: 'Luis Garcia', region: 'Midwest', territory: 'Midwest / T1', calls: 60, trx: 600 }),
        hcp({ id: 'HCP-000007', name: 'Sara Smith', region: 'Midwest', territory: 'Midwest / T2', calls: 70, trx: 700 }),
      ]),
      fake,
    ),
    validator: fake,
  };
}

/** The five rows a "+10% calls" operation accepted. Row 5 and row 6 rejected. */
const APPLIED: readonly EditEntry[] = [
  { rowKey: asRowKey(0), before: 10, after: 11 },
  { rowKey: asRowKey(1), before: 20, after: 22 },
  { rowKey: asRowKey(2), before: 30, after: 33 },
  { rowKey: asRowKey(3), before: 40, after: 44 },
  { rowKey: asRowKey(4), before: 50, after: 55 },
];

const REJECTED_ROWS: readonly RowKey[] = [asRowKey(5), asRowKey(6)];

function bulkCommand(entries: readonly EditEntry[] = APPLIED): Command {
  return {
    kind: 'bulk-edit',
    id: asCommandId(1),
    label: '+10% calls',
    opId: asOpId(1),
    entries,
  };
}

/**
 * Every territory and region total, as plain values.
 *
 * Snapshotting `GroupTotals` rather than just `sumCalls` means the assertion also
 * covers `count`, `sumTrx`, `sumNrx`, `nullCalls` and the derived `cpi` — so an
 * undo that restored the sum but corrupted anything alongside it would still fail.
 */
function snapshotTotals(): { territory: GroupTotals[]; region: GroupTotals[] } {
  const { aggregates, groups } = store.getState();
  return {
    territory: Array.from({ length: groups.territoryCount }, (_unused, t) => totalsAt(aggregates.territory, t)),
    region: Array.from({ length: groups.regionCount }, (_unused, r) => totalsAt(aggregates.region, r)),
  };
}

/**
 * Land the accepted values and push the single command — what `finalize(opId)`
 * does.
 *
 * Deliberately built through the production `writeEntries` / store `set` path
 * rather than by hand-assigning state, so the test would break if either changed.
 */
function finalizeBulk(command: Command = bulkCommand()): void {
  const state = store.getState();
  const written = applyCommand(state, command);
  store.setState({
    committed: written.committed,
    aggregates: written.aggregates,
    history: { past: [...state.history.past, command], future: [] },
    nextCommandId: asCommandId(state.nextCommandId + 1),
  });
}

beforeEach(() => {
  ({ store, validator } = makeStore());
});

// ---------------------------------------------------------------------------

describe('a bulk-edit command is exactly ONE undo step (FR-5 §5.2 / FR-6)', () => {
  it('undoes all five entries with a single undo()', () => {
    finalizeBulk();

    // Precondition: the five accepted values really are in committed.
    expect(store.getState().committed.size).toBe(5);
    for (const entry of APPLIED) {
      expect(store.getState().committed.get(entry.rowKey)).toBe(entry.after);
    }
    expect(store.getState().history.past).toHaveLength(1);

    store.getState().undo();

    // (a) one undo reverted all five, not one of them.
    for (const entry of APPLIED) {
      expect(store.getState().committed.get(entry.rowKey)).toBeUndefined();
    }
    // (c) committed is a true diff again — every `before` equalled the source
    // value, so `writeEntries` deleted the keys rather than storing them.
    expect(store.getState().committed.size).toBe(0);

    // ...and it consumed exactly one history step, not five.
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().history.future).toHaveLength(1);
  });

  it('returns BOTH aggregate levels to their exact starting numbers', () => {
    const before = snapshotTotals();

    finalizeBulk();

    // The operation genuinely moved the numbers — otherwise the assertion below
    // would pass against a no-op.
    expect(snapshotTotals()).not.toEqual(before);

    store.getState().undo();

    // (b) territory AND region, byte-for-byte. Region totals are rolled up from
    // territories, so a delta applied at only one level would surface here.
    expect(snapshotTotals()).toEqual(before);
  });

  it('spreads the deltas across the right territories and regions while applied', () => {
    const { groups } = store.getState();
    const westT1 = groups.territoryKeys.indexOf('West / T1');
    const westT2 = groups.territoryKeys.indexOf('West / T2');
    const midwestT1 = groups.territoryKeys.indexOf('Midwest / T1');
    const midwestT2 = groups.territoryKeys.indexOf('Midwest / T2');
    const west = groups.regionKeys.indexOf('West');
    const midwest = groups.regionKeys.indexOf('Midwest');

    finalizeBulk();
    const { aggregates } = store.getState();

    // 10+20 -> 11+22, 30+40 -> 33+44, 50+60 -> 55+60 (row 5 rejected), 70 untouched.
    expect(totalsAt(aggregates.territory, westT1).sumCalls).toBe(33);
    expect(totalsAt(aggregates.territory, westT2).sumCalls).toBe(77);
    expect(totalsAt(aggregates.territory, midwestT1).sumCalls).toBe(115);
    expect(totalsAt(aggregates.territory, midwestT2).sumCalls).toBe(70);
    expect(totalsAt(aggregates.region, west).sumCalls).toBe(110);
    expect(totalsAt(aggregates.region, midwest).sumCalls).toBe(185);
  });

  it('leaves the rejected rows untouched — only the applied subset is in the command', () => {
    finalizeBulk();

    for (const rowKey of REJECTED_ROWS) {
      expect(store.getState().committed.has(rowKey)).toBe(false);
      expect(store.getState().cellState.get(rowKey)).toBeUndefined();
    }

    store.getState().undo();

    // Nothing was ever committed for them, so undo has nothing to give back —
    // the partial-failure case in §5.4 step 8.
    for (const rowKey of REJECTED_ROWS) {
      expect(store.getState().committed.has(rowKey)).toBe(false);
    }
  });

  it('redoes all five in one step too, and re-validates nothing', () => {
    finalizeBulk();
    const applied = snapshotTotals();

    store.getState().undo();
    store.getState().redo();

    expect(store.getState().committed.size).toBe(5);
    expect(snapshotTotals()).toEqual(applied);
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().history.future).toHaveLength(0);
    // FR-6: redo does not re-validate. Five spurious 503s on known-good values is
    // the failure this avoids — see the DECISION on `redo`.
    expect(validator.calls).toHaveLength(0);
  });

  it('survives a full apply -> undo -> redo -> undo round trip', () => {
    const start = snapshotTotals();
    finalizeBulk();
    const applied = snapshotTotals();

    store.getState().undo();
    expect(snapshotTotals()).toEqual(start);
    store.getState().redo();
    expect(snapshotTotals()).toEqual(applied);
    store.getState().undo();
    expect(snapshotTotals()).toEqual(start);
    expect(store.getState().committed.size).toBe(0);
  });

  it('is refused while ANY row in the command has an edit in flight', async () => {
    finalizeBulk();

    // Row 0 is one of the five. Start a single-cell edit on it and leave it pending.
    const inFlight = store.getState().commitEdit(asRowKey(0), '30');
    expect(store.getState().cellState.get(asRowKey(0))?.kind).toBe('pending');

    store.getState().undo();

    // The bulk command is still on the stack, and nothing was reverted: the
    // in-flight request will write `committed`, and ordering the two by latency
    // rather than by intent is exactly what this refusal prevents.
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().committed.get(asRowKey(0))).toBe(11);
    expect(store.getState().toasts[0]?.title).toBe('Cannot undo yet');

    validator.settleAll('ok');
    await inFlight;
  });

  it('describes itself with its entry count for the undo control', () => {
    expect(describeCommand(bulkCommand())).toBe('+10% calls (5 rows)');
  });

  it('pushes NO command when every entry failed — an undo step that undoes nothing is worse than none', () => {
    // §5.2: `if (entries.length === 0) { ... return; }`. Modelled here as the state
    // a finalize with an empty applied subset would leave behind.
    const state = store.getState();
    const written = writeEntries(state, [], 'apply');

    expect(written.committed.size).toBe(0);
    // Identity, not just equality: `applyCallsChange` returns the input unchanged
    // when nothing moved, so no subscriber is woken by an operation that did nothing.
    expect(written.aggregates).toBe(state.aggregates);
    expect(store.getState().history.past).toHaveLength(0);
  });
});
