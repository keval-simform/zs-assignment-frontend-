import type { Dataset } from './normalize';
import { rowCpi } from './cpi';
import { asRowKey } from './identity';
import type { RowKey } from './identity';
import { readI32, readItem } from './typed';

export type ColumnId =
  | 'id'
  | 'name'
  | 'specialty'
  | 'region'
  | 'territory'
  | 'calls'
  | 'trx'
  | 'nrx'
  | 'cpi';

export type SortDirection = 'asc' | 'desc';

export interface SortSpec {
  readonly column: ColumnId;
  readonly direction: SortDirection;
}

/** Compares two RowKeys held as raw numbers, for `Array`/`TypedArray.sort`. */
export type RowComparator = (a: number, b: number) => number;

/**
 * FR-3: "when sorting a numeric column, groups reorder by their aggregate value
 * of that column". This is the set that triggers that behaviour.
 */
const NUMERIC_COLUMNS = new Set<ColumnId>(['calls', 'trx', 'nrx', 'cpi']);

export function isNumericColumn(column: ColumnId): boolean {
  return NUMERIC_COLUMNS.has(column);
}

/**
 * Everything a comparator needs that is not the row index itself.
 *
 * `callsOf` is injected rather than read from `dataset` because the sort must see
 * *effective* calls — committed edits included — and the committed map lives in
 * the store, which the domain layer must not import. This is the seam that keeps
 * comparators pure and unit-testable with a two-row fixture.
 */
export interface SortContext {
  readonly dataset: Dataset;
  /** Effective calls: the committed value if one exists, else the source value. */
  readonly callsOf: (rowKey: RowKey) => number | null;
}

/** Byte-order string compare. Returns -1, 0, or 1. */
function cmpText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Wrap a key extractor into a comparator with our two universal rules.
 *
 * DECISION 1 — nulls sort LAST in BOTH directions rather than flipping to the top
 * on descending. 515 measured rows have `specialty === null` and 112 have an
 * undefined CPI; flipping them means one click of "descending" buries the data the
 * user asked to see under several screens of em dashes. The cost is that the sort is
 * not a strict mirror image of itself, which we accept and document.
 * ASSUMPTIONS.md §B4.
 *
 * DECISION 2 — ties break on ascending row index regardless of direction, and the
 * tiebreak is NOT negated for `desc`. That makes the sort stable (FR-3 asks for
 * "stable within groups") and means toggling asc -> desc -> asc returns to a
 * byte-identical layout. Negating the tiebreak would look like equal rows
 * shuffling for no reason every time the user flipped direction.
 */
function comparator<T>(
  key: (rowKey: number) => T | null,
  cmp: (a: T, b: T) => number,
  direction: SortDirection,
): RowComparator {
  const sign = direction === 'asc' ? 1 : -1;
  return (a, b) => {
    const av = key(a);
    const bv = key(b);
    if (av === null) return bv === null ? a - b : 1;
    if (bv === null) return -1;
    const c = cmp(av, bv);
    return c !== 0 ? sign * c : a - b;
  };
}

/**
 * Build the comparator for one column and direction.
 *
 * PERF: the returned comparator re-extracts both keys on every comparison
 * (`2 · n log n` rather than `n`), accepted because `sortedTerritoryRows` sorts
 * **one territory at a time** (~1,042 rows), **only for expanded territories** —
 * ~0.5 ms per open group against ~37.7 ms for a 50,000-row global sort. Every
 * extractor here is a typed-array read or array index — no allocation, no string
 * work, since `nameLower` / `idLower` were lowercased once at load.
 *
 * Optimisation NOT taken: a Schwartzian transform (build an `n`-length key array
 * once, sort indices against it, discard it) would cut extractions to `n`, but
 * needs a per-column key buffer, a second code path for the null-last rule, and a
 * cache keyed the same way the result already is. The win it would buy sits under
 * the per-territory cache `sortedTerritoryRows` already serves repeat renders
 * from. Worth doing if row-level sorting ever moves above a territory — noted in
 * the README as a known, deliberate non-optimisation.
 *
 * EDGE CASE: `calls` compares numerically even for the 236 string-sourced rows,
 * because `parseCalls` ran once at load — string-vs-number comparison would put
 * "9" after 40.
 *
 * DECISION: text columns compare by UTF-16 code unit, not `localeCompare`. Every
 * name, specialty, and region here is ASCII from a fixed vocabulary, and
 * `Intl.Collator` is roughly an order of magnitude slower per comparison. Real
 * customer data with accents or non-Latin scripts would need a collator plus a
 * cached sort-key array — a known limitation, not pretended away. ASSUMPTIONS.md §B5.
 *
 * `region` and `territory` are constant inside a territory bucket, so sorting a
 * bucket by them degenerates to the index tiebreak. Still implemented because the
 * same comparators order groups in the pipeline's group-ordering stage.
 */
export function makeComparator(spec: SortSpec, ctx: SortContext): RowComparator {
  const { dataset } = ctx;
  const { direction } = spec;

  switch (spec.column) {
    case 'id':
      return comparator((k) => readItem(dataset.idLower, k), cmpText, direction);
    case 'name':
      return comparator((k) => readItem(dataset.nameLower, k), cmpText, direction);
    case 'specialty':
      // EDGE CASE: `specialty` is genuinely `string | null` in the source; the
      // null branch in `comparator` is what sends those 515 rows to the bottom.
      return comparator((k) => readItem(dataset.rows, k).specialty, cmpText, direction);
    case 'region':
      return comparator((k) => readItem(dataset.rows, k).region, cmpText, direction);
    case 'territory':
      return comparator((k) => readItem(dataset.rows, k).territory, cmpText, direction);
    case 'calls':
      return comparator((k) => ctx.callsOf(asRowKey(k)), (a, b) => a - b, direction);
    case 'trx':
      return comparator((k) => readI32(dataset.trx, k), (a, b) => a - b, direction);
    case 'nrx':
      return comparator((k) => readI32(dataset.nrx, k), (a, b) => a - b, direction);
    case 'cpi':
      // EDGE CASE: rows with trx === 0 yield null here and land at the bottom in
      // both directions, so an undefined ratio never masquerades as a high or low one.
      return comparator(
        (k) => rowCpi(ctx.callsOf(asRowKey(k)), readI32(dataset.trx, k)),
        (a, b) => a - b,
        direction,
      );
    default: {
      const unhandled: never = spec.column;
      throw new Error(`Unhandled sort column: ${String(unhandled)}`);
    }
  }
}
