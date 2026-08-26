import { describe, expect, it } from '@jest/globals';
import { fixture, hcp, realData } from '../test/fixtures';
import { asRegionIndex, asRowKey, asTerritoryIndex } from './identity';
import {
  buildGroupIndex,
  regionOfRow,
  regionTerritoryRange,
  territoryOfRow,
  territoryRowCount,
  territoryRows,
} from './grouping';
import { rowAt } from './normalize';

describe('buildGroupIndex on the real dataset', () => {
  it('discovers 6 regions and 48 territories', () => {
    const { groups } = realData();
    expect(groups.regionCount).toBe(6);
    expect(groups.territoryCount).toBe(48);
  });

  it('treats "National" as a peer region, not a rollup', () => {
    // EDGE CASE: the name invites special-casing. It is one of six sibling
    // regions with its own 8 territories and its own subtotal.
    const { groups } = realData();
    expect(groups.regionKeys).toContain('National');
    const [start, end] = regionTerritoryRange(groups, asRegionIndex(groups.regionKeys.indexOf('National')));
    expect(end - start).toBe(8);
  });

  it('sorts region keys alphabetically', () => {
    const { groups } = realData();
    expect([...groups.regionKeys]).toEqual([...groups.regionKeys].sort());
  });

  it('buckets every row exactly once', () => {
    const { dataset, groups } = realData();
    let total = 0;
    for (let t = 0; t < groups.territoryCount; t++) total += territoryRowCount(groups, asTerritoryIndex(t));
    expect(total).toBe(dataset.count);
  });

  it('gives every region exactly 8 contiguous territories', () => {
    const { groups } = realData();
    for (let r = 0; r < groups.regionCount; r++) {
      const [start, end] = regionTerritoryRange(groups, asRegionIndex(r));
      expect(end - start).toBe(8);
      for (let t = start; t < end; t++) expect(groups.territoryRegion[t]).toBe(r);
    }
  });

  it('assigns each row to the territory its record names', () => {
    const { dataset, groups } = realData();
    for (let i = 0; i < dataset.count; i += 997) {
      const k = asRowKey(i);
      const row = rowAt(dataset, k);
      expect(groups.territoryKeys[territoryOfRow(groups, k)]).toBe(row.territory);
      expect(groups.regionKeys[regionOfRow(groups, k)]).toBe(row.region);
    }
  });

  it('hands out a zero-copy view of a bucket, not a copy', () => {
    // PERF: 48 subarrays over one buffer instead of 48 allocations.
    const { groups } = realData();
    const bucket = territoryRows(groups, asTerritoryIndex(0));
    expect(bucket.buffer).toBe(groups.rowsByTerritory.buffer);
  });

  it('orders rows ascending inside each bucket', () => {
    // This is the stable baseline the comparators tie-break back to.
    const { groups } = realData();
    for (let t = 0; t < groups.territoryCount; t++) {
      const bucket = territoryRows(groups, asTerritoryIndex(t));
      for (let i = 1; i < bucket.length; i++) {
        expect(bucket[i]).toBeGreaterThan(bucket[i - 1] ?? -1);
      }
    }
  });

  it('shortens territory labels to Tn for display', () => {
    const { groups } = realData();
    for (const label of groups.territoryLabels) expect(label).toMatch(/^T[1-8]$/);
  });
});

describe('buildGroupIndex edge cases', () => {
  it('keeps identically-named territories in different regions apart', () => {
    // They cannot collide because the generator embeds the region in the name,
    // but the index must not assume that.
    const { groups } = fixture([
      hcp({ region: 'West', territory: 'West / T1' }),
      hcp({ region: 'Midwest', territory: 'Midwest / T1' }),
    ]);
    expect(groups.territoryCount).toBe(2);
    expect(groups.regionCount).toBe(2);
  });

  it('fails loudly rather than aliasing rows when the key count overflows Uint8', () => {
    const rows = Array.from({ length: 300 }, (_unused, i) =>
      hcp({ region: 'West', territory: `West / T${i}` }),
    );
    expect(() => buildGroupIndex(rows)).toThrow(/at most 256 keys/);
  });

  it('handles a single-row dataset', () => {
    const { groups } = fixture([hcp()]);
    expect(groups.regionCount).toBe(1);
    expect(territoryRowCount(groups, asTerritoryIndex(0))).toBe(1);
  });
});
