import { describe, expect, it } from '@jest/globals';
import { fixture, hcp, realData, seededRandom } from '../test/fixtures';
import { applyCallsChange, computeAggregates, totalsAt } from './aggregate';
import type { AggregateTable, Aggregates } from './aggregate';
import { asRegionIndex, asRowKey, asTerritoryIndex } from './identity';
import type { RowKey } from './identity';
import { regionTerritoryRange } from './grouping';
import { callsAt } from './normalize';

const NO_EDITS: ReadonlyMap<RowKey, number> = new Map();

/** Copy the numbers out of an aggregate table — see the INVARIANT on applyCallsChange. */
function snapshot(t: AggregateTable): readonly number[] {
  return [...t.count, ...t.sumCalls, ...t.sumTrx, ...t.sumNrx, ...t.nullCalls];
}

describe('computeAggregates', () => {
  it('counts every row exactly once across regions', () => {
    const { dataset, groups } = realData();
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    let total = 0;
    for (let r = 0; r < groups.regionCount; r++) total += totalsAt(aggs.region, r).count;
    expect(total).toBe(dataset.count);
  });

  it('derives each region from its territories, so headers always agree', () => {
    const { dataset, groups } = realData();
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    for (let r = 0; r < groups.regionCount; r++) {
      const [start, end] = regionTerritoryRange(groups, asRegionIndex(r));
      let calls = 0;
      let trx = 0;
      let count = 0;
      for (let t = start; t < end; t++) {
        const sub = totalsAt(aggs.territory, t);
        calls += sub.sumCalls;
        trx += sub.sumTrx;
        count += sub.count;
      }
      const region = totalsAt(aggs.region, r);
      expect(region.sumCalls).toBe(calls);
      expect(region.sumTrx).toBe(trx);
      expect(region.count).toBe(count);
    }
  });

  it('sums exactly the parsed calls, string-sourced rows included', () => {
    const { dataset, groups } = realData();
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    let expected = 0;
    for (let i = 0; i < dataset.count; i++) expected += callsAt(dataset, asRowKey(i)) ?? 0;
    let actual = 0;
    for (let r = 0; r < groups.regionCount; r++) actual += totalsAt(aggs.region, r).sumCalls;
    expect(actual).toBe(expected);
  });

  it('excludes unparsable rows from Σcalls and counts them separately', () => {
    const { dataset, groups } = fixture([
      hcp({ calls: 10, territory: 'West / T1' }),
      hcp({ calls: 'garbage', territory: 'West / T1' }),
    ]);
    const totals = totalsAt(computeAggregates(dataset, groups, NO_EDITS).territory, 0);
    expect(totals.sumCalls).toBe(10);
    expect(totals.nullCalls).toBe(1);
    expect(totals.count).toBe(2);
  });

  it('applies committed edits and nothing else', () => {
    const { dataset, groups } = fixture([hcp({ calls: 10 }), hcp({ calls: 20 })]);
    const committed = new Map<RowKey, number>([[asRowKey(0), 55]]);
    const totals = totalsAt(computeAggregates(dataset, groups, committed).territory, 0);
    expect(totals.sumCalls).toBe(55 + 20);
  });

  it('cannot see a pending value, because there is nowhere to put one', () => {
    // FR-4's "aggregates must not include pending edits" is enforced by this
    // signature, not by a conditional: `computeAggregates` accepts `committed`
    // only. The behavioural race test arrives with the store in Phase 5.
    const { dataset, groups } = fixture([hcp({ calls: 10 })]);
    const pendingButNotCommitted = new Map<RowKey, number>([[asRowKey(0), 60]]);
    const withoutPending = snapshot(computeAggregates(dataset, groups, NO_EDITS).territory);
    // The pending map is deliberately never passed anywhere.
    expect(pendingButNotCommitted.size).toBe(1);
    expect(withoutPending).toEqual(snapshot(computeAggregates(dataset, groups, NO_EDITS).territory));
    expect(totalsAt(computeAggregates(dataset, groups, NO_EDITS).territory, 0).sumCalls).toBe(10);
  });

  it('handles an empty dataset without dividing by anything', () => {
    const { dataset, groups } = fixture([]);
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    expect(aggs.territory.count.length).toBe(0);
    expect(aggs.region.count.length).toBe(0);
  });
});

describe('applyCallsChange', () => {
  it('moves both levels by exactly the delta', () => {
    const { dataset, groups } = realData();
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    const rowKey = asRowKey(0);
    const t = asTerritoryIndex(groups.territoryOf[0] ?? 0);
    const r = asRegionIndex(groups.regionOf[0] ?? 0);

    const beforeCalls = callsAt(dataset, rowKey);
    const beforeTerritory = totalsAt(aggs.territory, t).sumCalls;
    const beforeRegion = totalsAt(aggs.region, r).sumCalls;

    const next = applyCallsChange(aggs, groups, rowKey, beforeCalls, 55);
    const delta = 55 - (beforeCalls ?? 0);

    expect(totalsAt(next.territory, t).sumCalls).toBe(beforeTerritory + delta);
    expect(totalsAt(next.region, r).sumCalls).toBe(beforeRegion + delta);
  });

  it('bumps version so memo layers see the in-place mutation', () => {
    const { dataset, groups } = fixture([hcp({ calls: 10 })]);
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    expect(applyCallsChange(aggs, groups, asRowKey(0), 10, 20).version).toBe(aggs.version + 1);
  });

  it('is a no-op, version included, when nothing actually changes', () => {
    const { dataset, groups } = fixture([hcp({ calls: 10 })]);
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    expect(applyCallsChange(aggs, groups, asRowKey(0), 10, 10)).toBe(aggs);
  });

  it('leaves count and Σtrx untouched — only Calls is editable', () => {
    const { dataset, groups } = fixture([hcp({ calls: 10, trx: 100, nrx: 50 })]);
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    const before = totalsAt(aggs.territory, 0);
    const after = totalsAt(applyCallsChange(aggs, groups, asRowKey(0), 10, 30).territory, 0);
    expect(after.count).toBe(before.count);
    expect(after.sumTrx).toBe(before.sumTrx);
    expect(after.sumNrx).toBe(before.sumNrx);
  });

  it('moves a row out of nullCalls when an edit makes it parsable', () => {
    const { dataset, groups } = fixture([hcp({ calls: 'garbage' })]);
    const aggs = computeAggregates(dataset, groups, NO_EDITS);
    expect(totalsAt(aggs.territory, 0).nullCalls).toBe(1);
    const after = totalsAt(applyCallsChange(aggs, groups, asRowKey(0), null, 12).territory, 0);
    expect(after.nullCalls).toBe(0);
    expect(after.sumCalls).toBe(12);
  });

  it('moves a row back into nullCalls when an edit is undone to unknown', () => {
    const { dataset, groups } = fixture([hcp({ calls: 'garbage' })]);
    let aggs: Aggregates = computeAggregates(dataset, groups, NO_EDITS);
    aggs = applyCallsChange(aggs, groups, asRowKey(0), null, 12);
    aggs = applyCallsChange(aggs, groups, asRowKey(0), 12, null);
    const totals = totalsAt(aggs.territory, 0);
    expect(totals.nullCalls).toBe(1);
    expect(totals.sumCalls).toBe(0);
  });

  it('agrees with a full recompute after a long run of deltas', () => {
    // The delta path is only trustworthy if it cannot drift from the oracle.
    const { dataset, groups } = realData();
    let aggs: Aggregates = computeAggregates(dataset, groups, NO_EDITS);
    const committed = new Map<RowKey, number>();

    for (let n = 0; n < 500; n++) {
      const rowKey = asRowKey((n * 97) % dataset.count);
      const before = committed.get(rowKey) ?? callsAt(dataset, rowKey);
      const after = (n * 7) % 61;
      aggs = applyCallsChange(aggs, groups, rowKey, before, after);
      committed.set(rowKey, after);
    }

    const oracle = computeAggregates(dataset, groups, committed);
    expect(snapshot(aggs.territory)).toEqual(snapshot(oracle.territory));
    expect(snapshot(aggs.region)).toEqual(snapshot(oracle.region));
  });

  it('leaves the previous snapshot completely untouched', () => {
    // The useSyncExternalStore contract: getSnapshot() must return an immutable
    // value. If this fails, selectors that read an aggregate without also reading
    // `version` get a stale-but-reference-equal result and skip their re-render.
    const { dataset, groups } = fixture([hcp({ calls: 10 })]);
    const before = computeAggregates(dataset, groups, NO_EDITS);
    const beforeNumbers = snapshot(before.territory);

    const after = applyCallsChange(before, groups, asRowKey(0), 10, 40);

    expect(after).not.toBe(before);
    expect(after.territory).not.toBe(before.territory);
    expect(after.territory.sumCalls).not.toBe(before.territory.sumCalls);
    expect(snapshot(before.territory)).toEqual(beforeNumbers);
    expect(totalsAt(before.territory, 0).sumCalls).toBe(10);
    expect(totalsAt(after.territory, 0).sumCalls).toBe(40);
  });

  it.each([1, 7, 42, 1337, 90210])(
    'matches a fresh full recompute after 200 randomised edits (seed %i)',
    (seed) => {
      // The delta path is only trustworthy if it cannot drift from the oracle.
      // Seeds are fixed and named so a failure reproduces exactly.
      const { dataset, groups } = realData();
      const rand = seededRandom(seed);
      let aggs: Aggregates = computeAggregates(dataset, groups, NO_EDITS);
      const committed = new Map<RowKey, number>();

      for (let n = 0; n < 200; n++) {
        const rowKey = asRowKey(Math.floor(rand() * dataset.count));
        const before = committed.get(rowKey) ?? callsAt(dataset, rowKey);
        const after = Math.floor(rand() * 61);
        aggs = applyCallsChange(aggs, groups, rowKey, before, after);
        committed.set(rowKey, after);
      }

      const oracle = computeAggregates(dataset, groups, committed);
      expect(snapshot(aggs.territory)).toEqual(snapshot(oracle.territory));
      expect(snapshot(aggs.region)).toEqual(snapshot(oracle.region));
    },
  );

  it('is exact: integer deltas cannot drift in Float64', () => {
    const { dataset, groups } = fixture([hcp({ calls: 0 })]);
    let aggs: Aggregates = computeAggregates(dataset, groups, NO_EDITS);
    for (let n = 0; n < 2000; n++) {
      aggs = applyCallsChange(aggs, groups, asRowKey(0), n % 2 === 0 ? 0 : 37, n % 2 === 0 ? 37 : 0);
    }
    expect(totalsAt(aggs.territory, 0).sumCalls).toBe(0);
  });
});
