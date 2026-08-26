import { beforeEach, describe, expect, it } from '@jest/globals';
import { fixture, hcp, realData } from '../test/fixtures';
import { createFakeValidator, CAP_REJECTION, TRANSIENT_REJECTION } from '../test/fakeValidator';
import type { FakeValidator } from '../test/fakeValidator';
import { totalsAt } from '../domain/aggregate';
import type { AggregateTable } from '../domain/aggregate';
import { asRowKey, asTerritoryIndex } from '../domain/identity';
import type { RowKey } from '../domain/identity';
import { createHcpStore } from './store';
import type { HcpStore } from './store';
import { isRetryable } from './types';

/**
 * FR-4's graded centre: the cell lifecycle under latency.
 *
 * Every case here drives the validator by hand. The real one settles after
 * 300–900 ms and rejects 10% of the time at random, so the interesting assertions —
 * that a superseded result is dropped, that aggregates hold still while pending —
 * would be coin flips against it.
 */

let store: HcpStore;
let validator: FakeValidator;

/**
 *   0  West / T1   calls 10  trx 100
 *   1  West / T1   calls 20  trx 100
 *   2  West / T2   calls 30  trx 100
 */
function makeStore(): { store: HcpStore; validator: FakeValidator } {
  const fake = createFakeValidator();
  return {
    store: createHcpStore(
      fixture([
        hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10 }),
        hcp({ id: 'HCP-000002', name: 'Omar Khan', region: 'West', territory: 'West / T1', calls: 20 }),
        hcp({ id: 'HCP-000003', name: 'Priya Rao', region: 'West', territory: 'West / T2', calls: 30 }),
      ]),
      fake,
    ),
    validator: fake,
  };
}

/** Copy the numbers out of an aggregate table — snapshots must not be references. */
function snapshot(t: AggregateTable): readonly number[] {
  return [...t.count, ...t.sumCalls, ...t.sumTrx, ...t.sumNrx, ...t.nullCalls];
}

function allAggregates(s: HcpStore): { territory: readonly number[]; region: readonly number[] } {
  return {
    territory: snapshot(s.getState().aggregates.territory),
    region: snapshot(s.getState().aggregates.region),
  };
}

beforeEach(() => {
  ({ store, validator } = makeStore());
});

// ---------------------------------------------------------------------------

describe('happy path', () => {
  it('goes pending, then saved, and moves the aggregate by exactly the delta', async () => {
    const rowKey = asRowKey(0);
    const before = totalsAt(store.getState().aggregates.territory, 0).sumCalls;

    const inFlight = store.getState().commitEdit(rowKey, '40');
    expect(store.getState().cellState.get(rowKey)).toMatchObject({ kind: 'pending', proposed: 40 });
    expect(validator.calls).toEqual([{ id: 1, value: 40 }]);

    validator.settle(1, 'ok');
    await inFlight;

    expect(store.getState().cellState.get(rowKey)).toMatchObject({ kind: 'saved', value: 40 });
    expect(store.getState().committed.get(rowKey)).toBe(40);
    expect(totalsAt(store.getState().aggregates.territory, 0).sumCalls).toBe(before + 30);
  });

  it('moves the region aggregate by the same delta', async () => {
    const inFlight = store.getState().commitEdit(asRowKey(0), '40');
    validator.settle(1, 'ok');
    await inFlight;
    // West holds all three rows: 10 + 20 + 30 = 60, then 40 + 20 + 30 = 90.
    expect(totalsAt(store.getState().aggregates.region, 0).sumCalls).toBe(90);
  });

  it('pushes exactly one history entry', async () => {
    const inFlight = store.getState().commitEdit(asRowKey(0), '40');
    validator.settle(1, 'ok');
    await inFlight;
    expect(store.getState().history.past).toHaveLength(1);
    expect(store.getState().history.past[0]).toMatchObject({
      kind: 'cell-edit',
      entry: { rowKey: 0, before: 10, after: 40 },
    });
  });

  it('keeps committed a true diff: reverting to the source value removes the key', async () => {
    const rowKey = asRowKey(0);
    let inFlight = store.getState().commitEdit(rowKey, '40');
    validator.settle(1, 'ok');
    await inFlight;
    expect(store.getState().committed.size).toBe(1);

    inFlight = store.getState().commitEdit(rowKey, '10');
    validator.settle(2, 'ok');
    await inFlight;
    // Back at the generated value, so it is no longer an edit.
    expect(store.getState().committed.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------

describe('PENDING EXCLUSION (FR-2 + FR-4)', () => {
  it('leaves EVERY aggregate byte-identical while an edit is in flight', async () => {
    const rowKey = asRowKey(0);
    const before = allAggregates(store);

    const inFlight = store.getState().commitEdit(rowKey, '55');

    // The cell says pending and carries the proposal...
    expect(store.getState().cellState.get(rowKey)).toMatchObject({ kind: 'pending', proposed: 55 });
    // ...and not one number anywhere has moved.
    expect(allAggregates(store)).toEqual(before);
    // Because `committed` was never written. This is the mechanism, not a side effect.
    expect(store.getState().committed.size).toBe(0);

    validator.settle(1, 'ok');
    await inFlight;

    const after = allAggregates(store);
    expect(after).not.toEqual(before);
    expect(totalsAt(store.getState().aggregates.territory, 0).sumCalls).toBe(30 + 45);
  });

  it('excludes a pending edit from the row CPI too', () => {
    // The same rule, one level down: an unvalidated value must not move a computed
    // column any more than it moves a subtotal.
    const rowKey = asRowKey(0);
    void store.getState().commitEdit(rowKey, '50');
    expect(store.getState().cellState.get(rowKey)?.kind).toBe('pending');
    expect(store.getState().committed.get(rowKey)).toBeUndefined();
  });

  it('holds aggregates still across several concurrent pending edits', () => {
    const before = allAggregates(store);
    void store.getState().commitEdit(asRowKey(0), '11');
    void store.getState().commitEdit(asRowKey(1), '22');
    void store.getState().commitEdit(asRowKey(2), '33');
    expect(validator.inFlight).toHaveLength(3);
    expect(allAggregates(store)).toEqual(before);
  });
});

// ---------------------------------------------------------------------------

describe('rejection', () => {
  it('reverts on a cap violation and records NOTHING in history', async () => {
    const rowKey = asRowKey(0);
    const before = allAggregates(store);

    const inFlight = store.getState().commitEdit(rowKey, '75');
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;

    const cell = store.getState().cellState.get(rowKey);
    expect(cell).toMatchObject({ kind: 'rejected', attempted: 75 });
    expect(store.getState().committed.has(rowKey)).toBe(false);
    expect(allAggregates(store)).toEqual(before);
    // Nothing was committed, so there is nothing to undo.
    expect(store.getState().history.past).toHaveLength(0);
  });

  it('classifies a cap violation as NOT retryable', async () => {
    const inFlight = store.getState().commitEdit(asRowKey(0), '75');
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;

    const cell = store.getState().cellState.get(asRowKey(0));
    expect(cell?.kind).toBe('rejected');
    if (cell?.kind !== 'rejected') return;
    expect(cell.reason.kind).toBe('cap');
    expect(isRetryable(cell.reason)).toBe(false);
    expect(store.getState().toasts[0]?.action).toBeNull();
  });

  it('classifies a 503 as retryable and offers the retry', async () => {
    const rowKey = asRowKey(0);
    let inFlight = store.getState().commitEdit(rowKey, '40');
    validator.settle(1, { reject: TRANSIENT_REJECTION });
    await inFlight;

    const cell = store.getState().cellState.get(rowKey);
    expect(cell?.kind).toBe('rejected');
    if (cell?.kind !== 'rejected') return;
    expect(cell.reason.kind).toBe('transient');
    expect(isRetryable(cell.reason)).toBe(true);
    expect(store.getState().toasts[0]?.action).toEqual({ kind: 'retry' });

    // The retry resends the same value and can then succeed.
    inFlight = store.getState().retryEdit(rowKey);
    expect(validator.inFlight).toHaveLength(1);
    validator.settle(2, 'ok');
    await inFlight;
    expect(store.getState().committed.get(rowKey)).toBe(40);
  });

  it('refuses to retry a cap violation', async () => {
    const rowKey = asRowKey(0);
    const inFlight = store.getState().commitEdit(rowKey, '75');
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;

    await store.getState().retryEdit(rowKey);
    // No second call: retrying a deterministic failure would just fail again.
    expect(validator.calls).toHaveLength(1);
  });

  it('surfaces the rejection in a toast as well as on the cell', async () => {
    // A virtualized row can leave the DOM during the validator's 300-900ms, so a
    // cell-only error would never be seen.
    const inFlight = store.getState().commitEdit(asRowKey(0), '75');
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;

    expect(store.getState().toasts).toHaveLength(1);
    expect(store.getState().toasts[0]?.title).toContain('Anita Sharma');
    expect(store.getState().toasts[0]?.detail).toContain('call cap');
    expect(store.getState().toasts[0]?.rowKey).toBe(0);
  });

  it('handles a rejection that is not a string at all', async () => {
    // The validator is a black box; assuming its rejection type is exactly the
    // mistake this narrows against.
    const inFlight = store.getState().commitEdit(asRowKey(0), '40');
    validator.settle(1, { reject: TRANSIENT_REJECTION });
    await inFlight;
    expect(store.getState().toasts[0]?.detail).toContain('503');
  });
});

// ---------------------------------------------------------------------------

describe('OUT-OF-ORDER RESOLUTION', () => {
  it('drops a superseded result that settles after the newer one', async () => {
    // The validator cannot be cancelled, so req1 WILL settle — up to 900ms after it
    // has been superseded. Without the reqId guard it would overwrite req2's answer.
    const rowKey = asRowKey(0);

    const first = store.getState().commitEdit(rowKey, '40');
    // Reject req1 so the cell leaves `pending` and a second edit is permitted.
    validator.settle(1, { reject: TRANSIENT_REJECTION });
    await first;
    expect(store.getState().cellState.get(rowKey)?.kind).toBe('rejected');

    const second = store.getState().commitEdit(rowKey, '55');
    expect(store.getState().cellState.get(rowKey)).toMatchObject({ kind: 'pending', proposed: 55 });

    validator.settle(2, 'ok');
    await second;
    expect(store.getState().committed.get(rowKey)).toBe(55);
    expect(store.getState().history.past).toHaveLength(1);
  });

  it('drops a late result whose cell is no longer pending on its ticket', async () => {
    const rowKey = asRowKey(0);

    // Start an edit, then take the cell out of `pending` behind the request's back —
    // exactly what an undo, a retry, or a superseding edit does.
    const inFlight = store.getState().commitEdit(rowKey, '40');
    const reqId = 1;
    store.setState({ cellState: new Map() });

    validator.settle(reqId, 'ok');
    await inFlight;

    // The stale result was discarded in full: nothing committed, nothing in history,
    // no aggregate movement. Safe precisely because step (d) wrote nothing.
    expect(store.getState().committed.size).toBe(0);
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().cellState.size).toBe(0);
  });

  it('drops a stale REJECTION as well as a stale success', async () => {
    // The guard has to be on both paths, or a superseded failure would paint an
    // error over a cell that has since succeeded.
    const rowKey = asRowKey(0);
    const inFlight = store.getState().commitEdit(rowKey, '40');
    store.setState({ cellState: new Map() });
    validator.settle(1, { reject: CAP_REJECTION });
    await inFlight;

    expect(store.getState().cellState.size).toBe(0);
    expect(store.getState().toasts).toHaveLength(0);
  });

  it('never reuses a reqId', async () => {
    const inFlight = store.getState().commitEdit(asRowKey(0), '40');
    validator.settle(1, 'ok');
    await inFlight;
    const second = store.getState().commitEdit(asRowKey(1), '41');
    validator.settle(2, 'ok');
    await second;
    // A recycled ticket could let a superseded result pass the guard.
    expect(store.getState().nextReqId).toBe(3);
  });
});

// ---------------------------------------------------------------------------

describe('the pending lock (FR-4)', () => {
  it('refuses a second edit while the first is in flight, and fires no second call', async () => {
    const rowKey = asRowKey(0);
    const inFlight = store.getState().commitEdit(rowKey, '40');
    expect(validator.calls).toHaveLength(1);

    await store.getState().commitEdit(rowKey, '55');
    expect(validator.calls).toHaveLength(1);
    expect(store.getState().cellState.get(rowKey)).toMatchObject({ proposed: 40 });

    validator.settle(1, 'ok');
    await inFlight;
    expect(store.getState().committed.get(rowKey)).toBe(40);
  });

  it('refuses to even open the editor on a pending cell', () => {
    const rowKey = asRowKey(0);
    void store.getState().commitEdit(rowKey, '40');
    store.getState().beginEdit(rowKey);
    // A cell that looked editable and then swallowed the keystrokes would be worse
    // than one that plainly will not open.
    expect(store.getState().view.editing).toBeNull();
  });

  it('allows an edit on a DIFFERENT row while one is pending', () => {
    void store.getState().commitEdit(asRowKey(0), '40');
    void store.getState().commitEdit(asRowKey(1), '41');
    expect(validator.inFlight).toHaveLength(2);
  });

  it('will not dismiss a pending cell state', () => {
    const rowKey = asRowKey(0);
    void store.getState().commitEdit(rowKey, '40');
    store.getState().acknowledgeCell(rowKey);
    expect(store.getState().cellState.get(rowKey)?.kind).toBe('pending');
  });
});

// ---------------------------------------------------------------------------

describe('no-op and invalid edits', () => {
  it('makes zero validator calls and zero history entries for a no-op', async () => {
    await store.getState().commitEdit(asRowKey(0), '10');
    expect(validator.calls).toHaveLength(0);
    expect(store.getState().history.past).toHaveLength(0);
    expect(store.getState().cellState.size).toBe(0);
  });

  it('treats a no-op against a COMMITTED value as a no-op too', async () => {
    const rowKey = asRowKey(0);
    const inFlight = store.getState().commitEdit(rowKey, '40');
    validator.settle(1, 'ok');
    await inFlight;

    await store.getState().commitEdit(rowKey, '40');
    // Re-committing the accepted value must not spend a validator call — with a 10%
    // random 503 rate, that would fail on an unchanged value one time in ten.
    expect(validator.calls).toHaveLength(1);
    expect(store.getState().history.past).toHaveLength(1);
  });

  it('ignores surrounding whitespace and leading zeros when detecting a no-op', async () => {
    await store.getState().commitEdit(asRowKey(0), ' 010 ');
    expect(validator.calls).toHaveLength(0);
  });

  it('rejects an unparsable draft inline without calling the validator', async () => {
    const rowKey = asRowKey(0);
    store.getState().beginEdit(rowKey);
    await store.getState().commitEdit(rowKey, '12abc');
    expect(validator.calls).toHaveLength(0);
    expect(store.getState().view.editing?.inputError).toMatch(/Whole numbers only/);
    expect(store.getState().cellState.size).toBe(0);
  });

  it('does NOT reject a value above the cap locally — the server must say no', () => {
    // D13: short-circuiting the business rule here would hide the rejection path.
    // Deliberately not awaited: the point is that the request was *sent*, and the
    // fake validator only settles when a test tells it to.
    void store.getState().commitEdit(asRowKey(0), '75');
    expect(validator.calls).toEqual([{ id: 1, value: 75 }]);
  });
});

// ---------------------------------------------------------------------------

describe('DUPLICATE-ID ISOLATION', () => {
  it('edits row 9973 without touching row 9972, which shares its id', async () => {
    // The test that proves the row-identity choice. These two rows carry the same
    // `id`; anything keyed on it would write both.
    const fake = createFakeValidator();
    const real = createHcpStore(realData(), fake);
    const target = asRowKey(9973);
    const twin = asRowKey(9972);

    const { dataset } = real.getState();
    expect(dataset.rows[9972]?.id).toBe(dataset.rows[9973]?.id);
    const twinBefore = dataset.rows[9972]?.calls;

    const inFlight = real.getState().commitEdit(target, '7');
    fake.settle(1, 'ok');
    await inFlight;

    expect(real.getState().committed.get(target)).toBe(7);
    expect(real.getState().committed.has(twin)).toBe(false);
    expect(real.getState().cellState.has(twin)).toBe(false);
    expect(real.getState().dataset.rows[9972]?.calls).toBe(twinBefore);
  });

  it('keeps the two colliding rows in the same territory aggregate exactly once', async () => {
    const fake = createFakeValidator();
    const real = createHcpStore(realData(), fake);
    const target = asRowKey(9973);
    const territory = asTerritoryIndex(real.getState().groups.territoryOf[9973] ?? 0);
    const before = totalsAt(real.getState().aggregates.territory, territory);

    const inFlight = real.getState().commitEdit(target, '7');
    fake.settle(1, 'ok');
    await inFlight;

    const after = totalsAt(real.getState().aggregates.territory, territory);
    expect(after.count).toBe(before.count);
    const sourceValue = Number(real.getState().dataset.rows[9973]?.calls);
    expect(after.sumCalls).toBe(before.sumCalls + (7 - sourceValue));
  });
});

// ---------------------------------------------------------------------------

describe('editing state', () => {
  it('seeds the draft with the current effective value', async () => {
    const rowKey = asRowKey(0);
    store.getState().beginEdit(rowKey);
    expect(store.getState().view.editing).toEqual({ rowKey, draft: '10', inputError: null });

    const inFlight = store.getState().commitEdit(rowKey, '40');
    validator.settle(1, 'ok');
    await inFlight;

    store.getState().beginEdit(rowKey);
    expect(store.getState().view.editing?.draft).toBe('40');
  });

  it('seeds an empty draft when the source value is unparsable', () => {
    const fake = createFakeValidator();
    const odd = createHcpStore(fixture([hcp({ calls: 'garbage' })]), fake);
    odd.getState().beginEdit(asRowKey(0));
    expect(odd.getState().view.editing?.draft).toBe('');
  });

  it('clears the input error on the next keystroke', async () => {
    const rowKey = asRowKey(0);
    store.getState().beginEdit(rowKey);
    await store.getState().commitEdit(rowKey, 'nope');
    expect(store.getState().view.editing?.inputError).not.toBeNull();
    store.getState().updateDraft('4');
    expect(store.getState().view.editing?.inputError).toBeNull();
  });

  it('cancelEdit leaves committed and cellState untouched', () => {
    const rowKey = asRowKey(0);
    store.getState().beginEdit(rowKey);
    store.getState().updateDraft('999');
    store.getState().cancelEdit();
    expect(store.getState().view.editing).toBeNull();
    expect(store.getState().committed.size).toBe(0);
    expect(store.getState().cellState.size).toBe(0);
  });

  it('closes the editor when a commit goes pending', () => {
    const rowKey = asRowKey(0);
    store.getState().beginEdit(rowKey);
    void store.getState().commitEdit(rowKey, '40');
    expect(store.getState().view.editing).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('toasts', () => {
  it('dismisses one toast without touching the others', async () => {
    for (const [row, value] of [
      [asRowKey(0), '75'],
      [asRowKey(1), '76'],
    ] as const) {
      const inFlight = store.getState().commitEdit(row, value);
      validator.settle(validator.inFlight[0]?.id ?? 0, { reject: CAP_REJECTION });
      await inFlight;
    }
    expect(store.getState().toasts).toHaveLength(2);
    const first = store.getState().toasts[0];
    expect(first).toBeDefined();
    if (first === undefined) return;
    store.getState().dismissToast(first.id);
    expect(store.getState().toasts).toHaveLength(1);
  });

  it('caps the retained list rather than growing forever', async () => {
    const fake = createFakeValidator();
    const rows: RowKey[] = Array.from({ length: 25 }, (_unused, i) => asRowKey(i % 3));
    const many = createHcpStore(
      fixture([hcp({ calls: 1 }), hcp({ calls: 2 }), hcp({ calls: 3 })]),
      fake,
    );
    for (const [i, rowKey] of rows.entries()) {
      const inFlight = many.getState().commitEdit(rowKey, String(70 + i));
      const call = fake.inFlight[0];
      if (call !== undefined) fake.settle(call.id, { reject: CAP_REJECTION });
      await inFlight;
      many.getState().acknowledgeCell(rowKey);
    }
    expect(many.getState().toasts.length).toBeLessThanOrEqual(20);
  });
});
