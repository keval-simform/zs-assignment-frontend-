import type { HcpRecord } from '../vendor/data-generator';
import { asRegionIndex, asTerritoryIndex } from './identity';
import type { RegionIndex, RowKey, TerritoryIndex } from './identity';
import { readItem, readU32, readU8 } from './typed';

/**
 * The immutable Region -> Territory index.
 *
 * DECISION: built once at load and never rebuilt. Region and territory are not
 * editable (only Calls is), so grouping structure is a constant — only which
 * groups are *expanded* and which rows survive the filter change, and both are
 * cheap overlays on this fixed skeleton. Alternative rejected: recomputing
 * grouping as a derived selector, re-bucketing 50,000 rows on every keystroke.
 *
 * The row buckets use a CSR (compressed sparse row) layout — one flat
 * `Uint32Array` of every RowKey ordered by territory, plus an offsets array —
 * so `territoryRows()` hands out a zero-copy `subarray` view instead of
 * allocating 48 arrays.
 */
export interface GroupIndex {
  /** Region names, sorted alphabetically. Indexed by RegionIndex. */
  readonly regionKeys: readonly string[];
  /**
   * Territory names, sorted by (region, name). Indexed by TerritoryIndex.
   *
   * EDGE CASE: the generator builds `territory` as `region + " / T" + n`, so a
   * territory name already embeds its region and is therefore globally unique.
   * That is convenient — we can key territories by name alone with no risk of
   * "T3" in the West colliding with "T3" in the Midwest.
   */
  readonly territoryKeys: readonly string[];
  /** Display-only short label ("T3"), with the region prefix stripped. */
  readonly territoryLabels: readonly string[];

  /** RowKey -> RegionIndex. */
  readonly regionOf: Uint8Array;
  /** RowKey -> TerritoryIndex. */
  readonly territoryOf: Uint8Array;
  /** TerritoryIndex -> RegionIndex. */
  readonly territoryRegion: Uint8Array;

  /**
   * RegionIndex -> half-open range of TerritoryIndex, length regionCount + 1.
   *
   * INVARIANT: `territoryKeys` is sorted by region first, so every region's
   * territories are contiguous and a pair of offsets is enough. Sorting
   * `territoryKeys` by anything else would break this and silently mis-associate
   * territories with regions.
   */
  readonly regionTerritoryOffsets: Uint32Array;

  /** CSR values: every RowKey, bucketed by territory, ascending within a bucket. */
  readonly rowsByTerritory: Uint32Array;
  /** CSR offsets, length territoryCount + 1. */
  readonly territoryOffsets: Uint32Array;

  readonly regionCount: number;
  readonly territoryCount: number;
}

/**
 * Every RowKey in territory `t`, in ascending source order.
 *
 * PERF: returns a `subarray` — a view over the shared CSR buffer, not a copy.
 * Callers that need to reorder must copy first (`.slice()`); mutating the view
 * would corrupt the index.
 */
export function territoryRows(g: GroupIndex, t: TerritoryIndex): Uint32Array {
  return g.rowsByTerritory.subarray(readU32(g.territoryOffsets, t), readU32(g.territoryOffsets, t + 1));
}

/** Number of rows in territory `t`, without materialising the bucket. */
export function territoryRowCount(g: GroupIndex, t: TerritoryIndex): number {
  return readU32(g.territoryOffsets, t + 1) - readU32(g.territoryOffsets, t);
}

/** Half-open `[start, end)` range of TerritoryIndex values belonging to region `r`. */
export function regionTerritoryRange(g: GroupIndex, r: RegionIndex): readonly [number, number] {
  return [readU32(g.regionTerritoryOffsets, r), readU32(g.regionTerritoryOffsets, r + 1)];
}

/**
 * The region a row belongs to.
 *
 * PERF: brands the result, which costs two integer checks. Hot full-dataset
 * scans read `g.regionOf` directly instead; this accessor is for the ~40 rows
 * on screen and for group-level code, where the type safety is worth more than
 * the nanoseconds.
 */
export function regionOfRow(g: GroupIndex, k: RowKey): RegionIndex {
  return asRegionIndex(readU8(g.regionOf, k));
}

/** The territory a row belongs to. See `regionOfRow` for the branding cost note. */
export function territoryOfRow(g: GroupIndex, k: RowKey): TerritoryIndex {
  return asTerritoryIndex(readU8(g.territoryOf, k));
}

/**
 * Strip the `"<region> / "` prefix from a territory key for display.
 * Falls back to the full key if the prefix is absent, so a generator change that
 * drops the convention degrades to a longer label rather than an empty one.
 */
function shortLabel(territoryKey: string, regionKey: string): string {
  const prefix = `${regionKey} / `;
  return territoryKey.startsWith(prefix) ? territoryKey.slice(prefix.length) : territoryKey;
}

/**
 * Bucket every row by region and territory.
 *
 * PERF: three linear passes over the source (~50k each, single-digit ms total)
 * and no per-row object allocation. Two passes are unavoidable for a CSR build
 * (count, then fill); the first exists to discover and sort the key sets so that
 * indices are assigned in display order and never need remapping later.
 *
 * @throws RangeError if the dataset has more than 256 regions or territories,
 *   which would overflow the Uint8Array lookups. The generator produces 6 and 48;
 *   the check exists so a contract change fails loudly instead of aliasing rows
 *   into the wrong group.
 */
export function buildGroupIndex(rows: readonly HcpRecord[]): GroupIndex {
  const n = rows.length;

  // Pass 1 — discover the key sets and each territory's owning region.
  const regionSet = new Set<string>();
  const territoryToRegion = new Map<string, string>();
  for (const row of rows) {
    regionSet.add(row.region);
    if (!territoryToRegion.has(row.territory)) territoryToRegion.set(row.territory, row.region);
  }

  const regionKeys = [...regionSet].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const regionIdOf = new Map<string, number>();
  regionKeys.forEach((key, i) => regionIdOf.set(key, i));

  // Sort by (region index, territory name) so each region's territories land in
  // one contiguous run — the invariant regionTerritoryOffsets depends on.
  const territoryKeys = [...territoryToRegion.keys()].sort((a, b) => {
    const ra = regionIdOf.get(territoryToRegion.get(a) ?? '') ?? 0;
    const rb = regionIdOf.get(territoryToRegion.get(b) ?? '') ?? 0;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  if (regionKeys.length > 256 || territoryKeys.length > 256) {
    throw new RangeError(
      `Uint8Array group lookups support at most 256 keys; found ${regionKeys.length} regions / ${territoryKeys.length} territories`,
    );
  }

  const territoryIdOf = new Map<string, number>();
  territoryKeys.forEach((key, i) => territoryIdOf.set(key, i));

  const territoryCount = territoryKeys.length;
  const regionCount = regionKeys.length;

  const territoryRegion = new Uint8Array(territoryCount);
  const territoryLabels: string[] = new Array<string>(territoryCount);
  const regionTerritoryOffsets = new Uint32Array(regionCount + 1);
  for (let t = 0; t < territoryCount; t++) {
    const tKey = readItem(territoryKeys, t);
    const rKey = territoryToRegion.get(tKey) ?? '';
    const r = regionIdOf.get(rKey) ?? 0;
    territoryRegion[t] = r;
    territoryLabels[t] = shortLabel(tKey, rKey);
    regionTerritoryOffsets[r + 1] = t + 1; // last territory seen for this region
  }
  // Forward-fill so empty regions (none in this dataset, but cheap to be correct)
  // produce an empty range rather than a zero-length hole at the wrong offset.
  for (let r = 1; r <= regionCount; r++) {
    const prev = readU32(regionTerritoryOffsets, r - 1);
    if (readU32(regionTerritoryOffsets, r) < prev) regionTerritoryOffsets[r] = prev;
  }

  // Pass 2 — per-row group ids and per-territory counts.
  const regionOf = new Uint8Array(n);
  const territoryOf = new Uint8Array(n);
  const territoryOffsets = new Uint32Array(territoryCount + 1);
  for (let i = 0; i < n; i++) {
    const row = readItem(rows, i);
    const t = territoryIdOf.get(row.territory) ?? 0;
    regionOf[i] = regionIdOf.get(row.region) ?? 0;
    territoryOf[i] = t;
    territoryOffsets[t + 1] = readU32(territoryOffsets, t + 1) + 1;
  }
  for (let t = 0; t < territoryCount; t++) {
    territoryOffsets[t + 1] = readU32(territoryOffsets, t + 1) + readU32(territoryOffsets, t);
  }

  // Pass 3 — fill the CSR buckets. Ascending `i` means each bucket comes out
  // sorted by RowKey, which is the stable baseline order the comparators tie-break to.
  const rowsByTerritory = new Uint32Array(n);
  const cursor = Uint32Array.from(territoryOffsets.subarray(0, territoryCount));
  for (let i = 0; i < n; i++) {
    const t = readU8(territoryOf, i);
    rowsByTerritory[readU32(cursor, t)] = i;
    cursor[t] = readU32(cursor, t) + 1;
  }

  return {
    regionKeys,
    territoryKeys,
    territoryLabels,
    regionOf,
    territoryOf,
    territoryRegion,
    regionTerritoryOffsets,
    rowsByTerritory,
    territoryOffsets,
    regionCount,
    territoryCount,
  };
}
