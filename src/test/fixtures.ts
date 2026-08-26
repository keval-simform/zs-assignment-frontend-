import type { HcpRecord } from '../vendor/data-generator';
import type { LoadedData } from '../domain/normalize';
import { buildDataset, projectRows } from '../domain/normalize';

/**
 * A single record with sensible defaults, so a fixture only states the field the
 * test is actually about.
 */
export function hcp(overrides: Partial<HcpRecord> = {}): HcpRecord {
  return {
    id: 'HCP-000001',
    name: 'Anita Sharma',
    specialty: 'Oncology',
    region: 'West',
    territory: 'West / T1',
    calls: 10,
    trx: 100,
    nrx: 50,
    ...overrides,
  };
}

/** Build a real `Dataset` + `GroupIndex` from hand-written records. */
export function fixture(rows: readonly HcpRecord[]): LoadedData {
  return projectRows(rows, 0);
}

let cached: LoadedData | null = null;

/**
 * The actual seed-42 dataset, built once and shared across the suite.
 *
 * PERF: generation plus projection plus grouping is a few tens of milliseconds;
 * memoising it keeps the whole domain suite well under a second while still
 * asserting against real data rather than a stand-in.
 */
export function realData(): LoadedData {
  cached ??= buildDataset(42, 50_000);
  return cached;
}

/**
 * A tiny deterministic PRNG for property tests.
 *
 * DECISION: seeded rather than `Math.random()`. A property test that fails once
 * in fifty runs and cannot be reproduced is worse than no test — it trains you to
 * re-run CI instead of reading the failure. Every seed used in the suite is
 * written into the test name so a failure names its own reproduction.
 */
export function seededRandom(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
