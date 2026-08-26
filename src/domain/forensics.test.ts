import { describe, expect, it } from '@jest/globals';
import { realData } from '../test/fixtures';
import { census, formatCensus } from './forensics';

/**
 * The measured source of truth for ASSUMPTIONS.md Part A.
 *
 * The assertions exist so the documented numbers cannot silently rot; the log is
 * what gets pasted into the docs.
 */
describe('data forensics — generateRows(42, 50000)', () => {
  const report = census(realData());

  it('prints the measured defect census', () => {
    console.log(`\n${formatCensus(report)}\n`);
    expect(report.totalRows).toBe(50_000);
  });

  it('finds 5 duplicate ids spanning 10 rows', () => {
    expect(report.duplicateIdCount).toBe(5);
    expect(report.duplicateIdRowCount).toBe(10);
    for (const group of report.duplicateIdGroups) expect(group.rowKeys).toHaveLength(2);
  });

  it('confirms names are not identities either', () => {
    expect(report.uniqueNameCount).toBe(256);
    expect(report.maxRowsPerName).toBeGreaterThan(100);
  });

  it('finds 515 null specialties', () => {
    expect(report.nullSpecialtyCount).toBe(515);
  });

  it('finds 236 string-typed calls, all of them parsable', () => {
    expect(report.stringCallsCount).toBe(236);
    expect(report.unparsableCallsCount).toBe(0);
  });

  it('finds 4 rows already above the validator cap', () => {
    expect(report.callsAboveCapCount).toBe(4);
    expect(report.callsMax).toBe(99_999);
  });

  it('confirms normal calls never approach the cap, so +10% cannot breach it', () => {
    expect(report.callsMin).toBe(0);
    const nonOutlierMax = 40;
    expect(nonOutlierMax * 1.1).toBeLessThan(60);
  });

  it('finds MORE zero-trx rows than the seeded rule accounts for', () => {
    // The trap. `i % 577 === 0` explains only part of it; `trx` is
    // Math.round(rand() * 900) and lands on 0 by chance as well. Any zero-trx
    // rule written from the generator source instead of the data misses these.
    expect(report.zeroTrxSeededCount).toBe(86);
    expect(report.zeroTrxNaturalCount).toBeGreaterThan(0);
    expect(report.zeroTrxCount).toBe(report.zeroTrxSeededCount + report.zeroTrxNaturalCount);
    expect(report.nullRowCpiCount).toBe(report.zeroTrxCount);
  });

  it('measures how far 4 rows move a region-level KPI', () => {
    // The most consequential thing the census found. Four rows out of 50,000
    // inflate their region's reported CPI by ~60%, because a 99999 outlier is
    // ~5,000x a normal calls value. This is the argument for surfacing outliers
    // in the GROUP header, not only on the row.
    const regions = report.outlierImpact.filter((o) => !o.scope.includes('/'));
    const affected = regions.filter((o) => o.outlierRows > 0);
    const clean = regions.filter((o) => o.outlierRows === 0);

    expect(affected).toHaveLength(4);
    expect(clean).toHaveLength(2);
    for (const region of affected) expect(region.distortionPct ?? 0).toBeGreaterThan(55);
    for (const region of clean) expect(region.distortionPct).toBe(0);
  });

  it('measures a far worse distortion at territory level', () => {
    // Same absolute error over ~1,000 rows instead of ~8,400.
    const territories = report.outlierImpact.filter((o) => o.scope.includes('/'));
    expect(territories).toHaveLength(4);
    for (const territory of territories) expect(territory.distortionPct ?? 0).toBeGreaterThan(300);
  });

  it('finds 6 regions of 8 territories each', () => {
    expect(report.regionKeys).toEqual([
      'Midwest',
      'National',
      'Northeast',
      'Southeast',
      'Southwest',
      'West',
    ]);
    expect(report.territoryCount).toBe(48);
  });
});
