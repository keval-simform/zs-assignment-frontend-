import { describe, expect, it } from '@jest/globals';
import { fixture, hcp } from '../test/fixtures';
import { isNumericColumn, makeComparator } from './comparators';
import type { ColumnId, SortContext, SortDirection } from './comparators';
import type { HcpRecord } from '../vendor/data-generator';
import { asRowKey } from './identity';
import type { RowKey } from './identity';
import { callsAt } from './normalize';

const ALL_COLUMNS: readonly ColumnId[] = [
  'id',
  'name',
  'specialty',
  'region',
  'territory',
  'calls',
  'trx',
  'nrx',
  'cpi',
];

/** Sort row indices with the comparator under test. */
function order(
  rows: readonly HcpRecord[],
  column: ColumnId,
  direction: SortDirection,
  committed: ReadonlyMap<RowKey, number> = new Map(),
): number[] {
  const { dataset } = fixture(rows);
  const ctx: SortContext = {
    dataset,
    callsOf: (k) => committed.get(k) ?? callsAt(dataset, k),
  };
  const cmp = makeComparator({ column, direction }, ctx);
  return rows.map((_row, i) => i).sort(cmp);
}

describe('numeric columns', () => {
  it('compares string-sourced calls numerically, not lexically', () => {
    // EDGE CASE: lexical order would put '40' before '9'.
    const rows = [hcp({ calls: '9' }), hcp({ calls: 40 }), hcp({ calls: '100' })];
    expect(order(rows, 'calls', 'asc')).toEqual([0, 1, 2]);
    expect(order(rows, 'calls', 'desc')).toEqual([2, 1, 0]);
  });

  it('sorts by the committed value, not the source value', () => {
    const rows = [hcp({ calls: 10 }), hcp({ calls: 20 })];
    const committed = new Map<RowKey, number>([[asRowKey(0), 99]]);
    expect(order(rows, 'calls', 'asc', committed)).toEqual([1, 0]);
  });

  it('sends unparsable calls last in BOTH directions', () => {
    const rows = [hcp({ calls: 5 }), hcp({ calls: 'garbage' }), hcp({ calls: 50 })];
    expect(order(rows, 'calls', 'asc')).toEqual([0, 2, 1]);
    expect(order(rows, 'calls', 'desc')).toEqual([2, 0, 1]);
  });

  it('sorts trx and nrx numerically', () => {
    const rows = [hcp({ trx: 900, nrx: 1 }), hcp({ trx: 90, nrx: 300 })];
    expect(order(rows, 'trx', 'asc')).toEqual([1, 0]);
    expect(order(rows, 'nrx', 'asc')).toEqual([0, 1]);
  });
});

describe('cpi column', () => {
  it('orders by the computed ratio', () => {
    // 10/100 = 10.0, 3/8 = 37.5, 1/100 = 1.0
    const rows = [hcp({ calls: 10, trx: 100 }), hcp({ calls: 3, trx: 8 }), hcp({ calls: 1, trx: 100 })];
    expect(order(rows, 'cpi', 'asc')).toEqual([2, 0, 1]);
  });

  it('sends undefined CPI (trx === 0) last in BOTH directions', () => {
    const rows = [hcp({ calls: 10, trx: 100 }), hcp({ calls: 25, trx: 0 }), hcp({ calls: 3, trx: 8 })];
    expect(order(rows, 'cpi', 'asc')).toEqual([0, 2, 1]);
    expect(order(rows, 'cpi', 'desc')).toEqual([2, 0, 1]);
  });
});

describe('text columns', () => {
  it('sends a null specialty last in BOTH directions', () => {
    // DECISION under test: 515 blank rows never get promoted to the top by a
    // single click of "descending".
    const rows = [hcp({ specialty: 'Cardiology' }), hcp({ specialty: null }), hcp({ specialty: 'Oncology' })];
    expect(order(rows, 'specialty', 'asc')).toEqual([0, 2, 1]);
    expect(order(rows, 'specialty', 'desc')).toEqual([2, 0, 1]);
  });

  it('sorts name case-insensitively via the precomputed lowercase array', () => {
    const rows = [hcp({ name: 'omar Khan' }), hcp({ name: 'Anita Sharma' })];
    expect(order(rows, 'name', 'asc')).toEqual([1, 0]);
  });

  it('keeps rows sharing a duplicate id adjacent and deterministic', () => {
    const rows = [hcp({ id: 'HCP-000005' }), hcp({ id: 'HCP-000009' }), hcp({ id: 'HCP-000005' })];
    expect(order(rows, 'id', 'asc')).toEqual([0, 2, 1]);
    expect(order(rows, 'id', 'desc')).toEqual([1, 0, 2]);
  });
});

describe('stability', () => {
  it('breaks ties on ascending row index in BOTH directions', () => {
    // Toggling asc -> desc -> asc must return a byte-identical layout; equal rows
    // shuffling on every direction flip would look like a bug to the user.
    const rows = [hcp({ calls: 10 }), hcp({ calls: 10 }), hcp({ calls: 10 })];
    expect(order(rows, 'calls', 'asc')).toEqual([0, 1, 2]);
    expect(order(rows, 'calls', 'desc')).toEqual([0, 1, 2]);
  });

  it('is stable within equal groups of a partially-tied column', () => {
    const rows = [hcp({ trx: 5 }), hcp({ trx: 1 }), hcp({ trx: 5 }), hcp({ trx: 1 })];
    expect(order(rows, 'trx', 'asc')).toEqual([1, 3, 0, 2]);
    expect(order(rows, 'trx', 'desc')).toEqual([0, 2, 1, 3]);
  });

  it('breaks all-null ties on row index too', () => {
    const rows = [hcp({ specialty: null }), hcp({ specialty: null })];
    expect(order(rows, 'specialty', 'asc')).toEqual([0, 1]);
    expect(order(rows, 'specialty', 'desc')).toEqual([0, 1]);
  });
});

describe('column coverage', () => {
  it('builds a working comparator for every ColumnId', () => {
    // The `never` check in makeComparator turns a new column into a compile
    // error; this turns it into a test failure too.
    const rows = [hcp({ id: 'HCP-000002', calls: 1 }), hcp({ id: 'HCP-000001', calls: 2 })];
    for (const column of ALL_COLUMNS) {
      expect(order(rows, column, 'asc')).toHaveLength(2);
      expect(order(rows, column, 'desc')).toHaveLength(2);
    }
  });

  it('classifies exactly the aggregate-bearing columns as numeric', () => {
    // FR-3: these are the columns whose sort also reorders groups.
    const numeric = ALL_COLUMNS.filter(isNumericColumn);
    expect(numeric).toEqual(['calls', 'trx', 'nrx', 'cpi']);
  });
});
