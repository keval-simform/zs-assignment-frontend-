import type { Dataset } from './normalize';
import type { GroupIndex } from './grouping';
import type { RowKey } from './identity';
import { groupCpi } from './cpi';
import { readF64, readI32, readU32, readU8 } from './typed';

/**
 * Group totals in column layout — one typed array per measure, indexed by group.
 *
 * DECISION: typed arrays rather than an array of 48 plain objects. Group header
 * rows read these on every frame while scrolling, and an accepted edit has to
 * touch two of them; contiguous storage keeps both cheap and allocates nothing
 * per edit. The trade-off is spelled out on `applyCallsChange`.
 */
export interface AggregateTable {
  readonly count: Uint32Array;
  readonly sumCalls: Float64Array;
  readonly sumTrx: Float64Array;
  readonly sumNrx: Float64Array;
  /**
   * Rows in this group whose `calls` could not be parsed at all. Zero for seed 42,
   * but tracked so a header can honestly say "Σ over 998 of 1000 rows" rather than
   * quietly under-reporting.
   */
  readonly nullCalls: Uint32Array;
}

/**
 * FR-2: live subtotals at both grouping levels.
 *
 * INVARIANT: the only edits reflected here are ones the validator has accepted.
 * `computeAggregates` takes the `committed` map and has no access to `cellState`,
 * so a pending edit is not merely excluded by a conditional — it is not reachable
 * from this code at all. Merging the two maps would make FR-4's "aggregates must
 * not include edits that are still pending validation" a rule someone has to
 * remember instead of a fact about the type signature.
 */
export interface Aggregates {
  readonly territory: AggregateTable;
  readonly region: AggregateTable;
  /**
   * Bumped on every applied change. Diagnostic only — reference inequality is the
   * change signal, because every mutation produces a whole new snapshot. Kept
   * because "how many aggregate updates has this session applied" is a useful
   * number in the footer and in a bug report.
   */
  readonly version: number;
}

/** A single group's totals, materialised for rendering. */
export interface GroupTotals {
  readonly count: number;
  readonly sumCalls: number;
  readonly sumTrx: number;
  readonly sumNrx: number;
  readonly nullCalls: number;
  readonly cpi: number | null;
}

/**
 * PERF: `TypedArray.prototype.slice` on 48- and 6-element arrays. Ten allocations
 * totalling under 2 KB, which is why the immutability below is free.
 */
function cloneTable(t: AggregateTable): AggregateTable {
  return {
    count: t.count.slice(),
    sumCalls: t.sumCalls.slice(),
    sumTrx: t.sumTrx.slice(),
    sumNrx: t.sumNrx.slice(),
    nullCalls: t.nullCalls.slice(),
  };
}

function emptyTable(size: number): AggregateTable {
  return {
    count: new Uint32Array(size),
    sumCalls: new Float64Array(size),
    sumTrx: new Float64Array(size),
    sumNrx: new Float64Array(size),
    nullCalls: new Uint32Array(size),
  };
}

/** Read one group's totals, including its aggregate CPI. */
export function totalsAt(table: AggregateTable, group: number): GroupTotals {
  const sumCalls = readF64(table.sumCalls, group);
  const sumTrx = readF64(table.sumTrx, group);
  return {
    count: readU32(table.count, group),
    sumCalls,
    sumTrx,
    sumNrx: readF64(table.sumNrx, group),
    nullCalls: readU32(table.nullCalls, group),
    cpi: groupCpi(sumCalls, sumTrx),
  };
}

/**
 * Full recompute of both aggregate levels from committed state.
 *
 * Called once at load and never again in normal operation — accepted edits go
 * through `applyCallsChange` instead. It stays exported because it is the oracle
 * the delta path is tested against: any drift between the two is a bug in the
 * delta arithmetic.
 *
 * PERF: one linear pass with zero Map probes per row, then a pass over
 * `committed` only (which is empty at load and small in practice), then a
 * 48-entry rollup. The naive shape — `committed.get(k)` inside the row loop —
 * would add 50,000 hash probes to a scan that otherwise touches only typed arrays.
 *
 * INVARIANT: region totals are derived by rolling up territory totals, never by
 * summing rows a second time. That is what guarantees a region header always
 * equals the sum of its expanded territory headers on screen.
 */
export function computeAggregates(
  d: Dataset,
  g: GroupIndex,
  committed: ReadonlyMap<RowKey, number>,
): Aggregates {
  const territory = emptyTable(g.territoryCount);
  const region = emptyTable(g.regionCount);

  for (let i = 0; i < d.count; i++) {
    const t = readU8(g.territoryOf, i);
    territory.count[t] = readU32(territory.count, t) + 1;
    territory.sumTrx[t] = readF64(territory.sumTrx, t) + readI32(d.trx, i);
    territory.sumNrx[t] = readF64(territory.sumNrx, t) + readI32(d.nrx, i);
    const calls = readF64(d.callsNum, i);
    if (Number.isNaN(calls)) territory.nullCalls[t] = readU32(territory.nullCalls, t) + 1;
    else territory.sumCalls[t] = readF64(territory.sumCalls, t) + calls;
  }

  // Overlay accepted edits. Identical arithmetic to `applyCallsChange`, which is
  // why the two paths cannot diverge in how they treat an unparsable base value.
  for (const [rowKey, after] of committed) {
    const t = readU8(g.territoryOf, rowKey);
    const base = readF64(d.callsNum, rowKey);
    if (Number.isNaN(base)) {
      territory.nullCalls[t] = readU32(territory.nullCalls, t) - 1;
      territory.sumCalls[t] = readF64(territory.sumCalls, t) + after;
    } else {
      territory.sumCalls[t] = readF64(territory.sumCalls, t) + (after - base);
    }
  }

  for (let t = 0; t < g.territoryCount; t++) {
    const r = readU8(g.territoryRegion, t);
    region.count[r] = readU32(region.count, r) + readU32(territory.count, t);
    region.sumCalls[r] = readF64(region.sumCalls, r) + readF64(territory.sumCalls, t);
    region.sumTrx[r] = readF64(region.sumTrx, r) + readF64(territory.sumTrx, t);
    region.sumNrx[r] = readF64(region.sumNrx, r) + readF64(territory.sumNrx, t);
    region.nullCalls[r] = readU32(region.nullCalls, r) + readU32(territory.nullCalls, t);
  }

  return { territory, region, version: 0 };
}

/**
 * FR-2 + FR-4: fold one accepted Calls change into both aggregate levels.
 *
 * Returns a **new** snapshot; the input is never touched.
 *
 * DECISION: clone the tables rather than mutate them in place and bump a version.
 * Zustand subscribes through `useSyncExternalStore`, whose contract requires
 * `getSnapshot()` to return an immutable value. Under in-place mutation, a
 * selector that reads an aggregate without *also* reading the version gets a
 * stale-but-reference-equal result and silently skips its re-render — a group
 * header showing the wrong Σ Calls with no way to notice. It can also tear under
 * concurrent rendering: a render already in progress would read pre-edit values
 * for rows it has passed and post-edit values for rows it has not, producing a
 * frame whose subtotals match no coherent state. The rejected alternative bought
 * nothing: cloning is microseconds, and accepted edits arrive at human speed.
 *
 * PERF: the delta stays **O(1) in rows** — two array writes per level, not a
 * 50,000-row rescan — while the returned snapshot is fully immutable. The clone
 * is O(groups), i.e. 54 numbers, not O(rows). All values are integers well below
 * 2^53, so Float64 addition is exact and a long run of deltas cannot drift from a
 * full recompute; asserted against `computeAggregates` over randomised edits.
 *
 * @param before the previous effective calls value, or `null` if unparsable.
 * @param after the newly accepted value, or `null` to revert to unknown.
 * @returns a new `Aggregates`, or the input unchanged when nothing moved.
 */
export function applyCallsChange(
  aggs: Aggregates,
  g: GroupIndex,
  rowKey: RowKey,
  before: number | null,
  after: number | null,
): Aggregates {
  const delta = (after ?? 0) - (before ?? 0);
  const nullDelta = (after === null ? 1 : 0) - (before === null ? 1 : 0);
  // Returning the identical reference is the correct signal for "nothing changed":
  // every subscriber's equality check short-circuits and no render is scheduled.
  if (delta === 0 && nullDelta === 0) return aggs;

  const t = readU8(g.territoryOf, rowKey);
  const r = readU8(g.regionOf, rowKey);

  const territory = cloneTable(aggs.territory);
  const region = cloneTable(aggs.region);

  territory.sumCalls[t] = readF64(territory.sumCalls, t) + delta;
  region.sumCalls[r] = readF64(region.sumCalls, r) + delta;

  if (nullDelta !== 0) {
    territory.nullCalls[t] = readU32(territory.nullCalls, t) + nullDelta;
    region.nullCalls[r] = readU32(region.nullCalls, r) + nullDelta;
  }

  return { territory, region, version: aggs.version + 1 };
}
