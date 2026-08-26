import { describe, expect, it } from '@jest/globals';
import { EM_DASH, formatCpi, groupCpi, rowCpi } from './cpi';

describe('rowCpi', () => {
  it('computes calls / trx * 100', () => {
    expect(rowCpi(10, 100)).toBeCloseTo(10, 10);
    expect(rowCpi(3, 8)).toBeCloseTo(37.5, 10);
  });

  it('returns null, not Infinity, when trx is 0', () => {
    // EDGE CASE: the seeded `i % 577` rows plus the naturally-occurring zeros.
    expect(rowCpi(25, 0)).toBeNull();
  });

  it('returns null when calls are unknown', () => {
    expect(rowCpi(null, 100)).toBeNull();
  });

  it('distinguishes "zero calls" from "unknown calls"', () => {
    // 0 calls against real prescriptions is a real, meaningful CPI of 0.
    expect(rowCpi(0, 100)).toBe(0);
    expect(rowCpi(null, 100)).toBeNull();
  });

  it('never leaks NaN or Infinity for any combination', () => {
    const callValues: readonly (number | null)[] = [null, 0, 1, 40, 99999];
    const trxValues: readonly number[] = [0, 1, 900];
    for (const calls of callValues) {
      for (const trx of trxValues) {
        const result = rowCpi(calls, trx);
        if (result !== null) expect(Number.isFinite(result)).toBe(true);
      }
    }
  });
});

describe('groupCpi', () => {
  it('is a ratio of sums, not a mean of ratios', () => {
    // Fixture chosen so the two definitions visibly disagree.
    //   row A: calls 1,  trx 1   -> CPI 100
    //   row B: calls 10, trx 100 -> CPI  10
    // mean of ratios  = (100 + 10) / 2 = 55
    // ratio of sums   = 11 / 101 * 100 = 10.891...
    const meanOfRatios = 55;
    const result = groupCpi(1 + 10, 1 + 100);
    expect(result).toBeCloseTo(10.891, 3);
    expect(result).not.toBeCloseTo(meanOfRatios, 1);
  });

  it('composes: a region equals its combined territories', () => {
    // This property is what licenses the O(1) delta update in aggregate.ts.
    const t1 = { calls: 120, trx: 800 };
    const t2 = { calls: 45, trx: 300 };
    const combined = groupCpi(t1.calls + t2.calls, t1.trx + t2.trx);
    expect(combined).toBeCloseTo(((120 + 45) / (800 + 300)) * 100, 10);
  });

  it('worked example: 41,203 calls over 612,480 TRx is 6.73', () => {
    // A ratio-of-sums reference point at realistic magnitudes, taken from the
    // illustrative figures in the assignment wireframe.
    //
    // NOTE: these are NOT this dataset's numbers and must not be read as a
    // cross-check of our aggregation. Seed 42's Northeast region totals are
    // 165,856 calls / 3,700,723 TRx (CPI 4.48); the wireframe's figures do not
    // correspond to any region or territory in the generated data. The test
    // earns its place as a magnitude check on the formula, nothing more.
    expect(groupCpi(41_203, 612_480)).toBeCloseTo(6.73, 2);
  });

  it('returns null when the whole group has no prescriptions', () => {
    expect(groupCpi(400, 0)).toBeNull();
  });

  it('counts zero-trx rows into Σcalls rather than excluding them', () => {
    // A group of two rows where one has trx 0: its calls still count, so the
    // header's Σ Calls matches the visible Calls column.
    expect(groupCpi(10 + 5, 100 + 0)).toBeCloseTo(15, 10);
  });
});

describe('formatCpi', () => {
  it('renders an em dash for undefined values', () => {
    expect(formatCpi(null)).toBe(EM_DASH);
  });

  it('renders an em dash rather than passing NaN to the DOM', () => {
    expect(formatCpi(Number.NaN)).toBe(EM_DASH);
    expect(formatCpi(Number.POSITIVE_INFINITY)).toBe(EM_DASH);
  });

  it('renders one decimal place by default', () => {
    expect(formatCpi(10.891089)).toBe('10.9');
    expect(formatCpi(0)).toBe('0.0');
  });
});
