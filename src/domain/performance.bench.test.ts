import { describe, expect, it } from '@jest/globals';
import { realData } from '../test/fixtures';
import { computeAggregates, applyCallsChange } from './aggregate';
import type { Aggregates } from './aggregate';
import { makeComparator } from './comparators';
import { territoryRows } from './grouping';
import { asRegionIndex, asRowKey, asTerritoryIndex } from './identity';
import { callsAt } from './normalize';
import type { RowKey } from './identity';
import { createHcpStore } from '../store/store';
import { createFakeValidator } from '../test/fakeValidator';
import { selectFilter, selectFlat, sortedTerritoryRows } from '../store/selectors';
import { pipelineTimings, resetPipelineTimings } from '../store/pipelineTimings';

/**
 * Measured performance, for the README.
 *
 * DECISION: this is a *measurement harness*, not a regression gate. Its assertions
 * are deliberately loose — orders of magnitude, not milliseconds — because a
 * wall-clock threshold in CI fails on a busy machine and teaches the team to
 * re-run rather than to read. The numbers in the README come from its log; the
 * assertions only guard the *shape* of the result (delta beats recompute; per-group
 * sorting beats global sorting).
 */

const NO_EDITS: ReadonlyMap<RowKey, number> = new Map();

/** Median of `runs` timings, which is far steadier than a single sample. */
function median(runs: number, fn: () => void): number {
  const samples: number[] = [];
  for (let i = 0; i < runs; i++) {
    const started = performance.now();
    fn();
    samples.push(performance.now() - started);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0;
}

describe('measured performance', () => {
  it('logs the numbers quoted in the README', () => {
    const loaded = realData();
    const { dataset, groups } = loaded;
    const lines: string[] = [];
    // Sub-millisecond figures are reported in microseconds: "0.00 ms" for the
    // O(1) delta hides the entire point of measuring it.
    const say = (label: string, ms: number, note: string): void => {
      const value = ms < 0.05 ? `${(ms * 1000).toFixed(1).padStart(8)} µs` : `${ms.toFixed(2).padStart(8)} ms`;
      lines.push(`  ${label.padEnd(38)} ${value}   ${note}`);
    };

    // --- load ---
    say('dataset build (generate+project+group)', loaded.buildMs, `${String(dataset.count)} rows, once`);

    // --- aggregates: full recompute vs O(1) delta ---
    const fullRecompute = median(5, () => {
      computeAggregates(dataset, groups, NO_EDITS);
    });
    say('aggregates: FULL recompute', fullRecompute, '50,000-row scan + 48-group rollup');

    let aggs: Aggregates = computeAggregates(dataset, groups, NO_EDITS);
    const deltaBatch = 1000;
    const deltaTotal = median(5, () => {
      for (let i = 0; i < deltaBatch; i++) {
        aggs = applyCallsChange(aggs, groups, asRowKey(i), callsAt(dataset, asRowKey(i)), 20);
      }
    });
    const perDelta = deltaTotal / deltaBatch;
    say('aggregates: ONE accepted edit (delta)', perDelta, `${String(Math.round(fullRecompute / perDelta))}x cheaper than recompute`);

    // --- sorting: per-territory vs global ---
    const effective = (k: RowKey): number | null => callsAt(dataset, k);
    const comparator = makeComparator({ column: 'calls', direction: 'asc' }, { dataset, callsOf: effective });

    const allIndices = new Uint32Array(dataset.count);
    for (let i = 0; i < dataset.count; i++) allIndices[i] = i;
    const globalSort = median(3, () => {
      allIndices.slice().sort(comparator);
    });
    say('sort: ALL 50,000 rows at once', globalSort, 'what a flat grid would do');

    const oneBucket = territoryRows(groups, asTerritoryIndex(0));
    const perTerritory = median(20, () => {
      oneBucket.slice().sort(comparator);
    });
    say('sort: ONE territory (~1,042 rows)', perTerritory, 'what we actually do per open group');
    say('sort: all 48 territories', perTerritory * 48, `vs ${globalSort.toFixed(1)} ms global`);

    // --- pipeline stages through the store ---
    const store = createHcpStore(loaded, createFakeValidator());
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));

    let searchTerm = 0;
    const searchRun = median(7, () => {
      searchTerm += 1;
      store.getState().setSearch(`anita ${String(searchTerm)}`);
      selectFilter(store.getState());
      selectFlat(store.getState());
    });
    say('keystroke: filter + flatten, 1 group open', searchRun, 'whole pipeline, 50,000 rows scanned');
    say('  last stage B (filter) sample', pipelineTimings.filterMs, 'precomputed lowercase arrays');
    say('  last stage F (flatten) sample', pipelineTimings.flattenMs, 'display list only');

    // Stage E only consults its cache when a sort is active — without one it returns
    // the filter view untouched, which is a different (faster) path.
    store.getState().setSearch('');
    store.getState().toggleSort('calls');
    const sortInputs = (): Parameters<typeof sortedTerritoryRows> => [
      store.getState().dataset,
      store.getState().committed,
      store.getState().view,
      selectFilter(store.getState()),
      asTerritoryIndex(0),
    ];
    resetPipelineTimings();
    sortedTerritoryRows(...sortInputs()); // populate
    const firstSort = pipelineTimings.sortMs;
    const cached = median(50, () => {
      sortedTerritoryRows(...sortInputs());
    });
    say('stage E: first sort of a territory', firstSort, 'cold');
    say('stage E: cache hit', cached, `${String(pipelineTimings.sortCacheHits)} hits recorded`);

    console.log(`\nMEASURED PERFORMANCE — generateRows(42, 50000)\n${lines.join('\n')}\n`);

    // Shape assertions only. See the note at the top of this file.
    expect(perDelta).toBeLessThan(fullRecompute / 10);
    expect(perTerritory).toBeLessThan(globalSort);
    expect(pipelineTimings.sortCacheHits).toBeGreaterThan(40);
    // One cold sort, then nothing but cache hits.
    expect(pipelineTimings.territoriesSorted).toBe(1);
  });
});
