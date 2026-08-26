import { describe, expect, it } from '@jest/globals';
import { fixture, hcp, realData } from '../test/fixtures';
import { asRowKey } from './identity';
import {
  OUTLIER_CALLS_HINT,
  RowFlag,
  callsAt,
  flagsAt,
  hasFlag,
  parseCalls,
  parseCallsInput,
  rowAt,
} from './normalize';

describe('parseCalls', () => {
  it('passes finite numbers through', () => {
    expect(parseCalls(0)).toBe(0);
    expect(parseCalls(40)).toBe(40);
    expect(parseCalls(99999)).toBe(99999);
  });

  it('parses the string half of the union numerically', () => {
    // EDGE CASE: 236 rows arrive as strings via `i % 211 === 0`.
    expect(parseCalls('7')).toBe(7);
    expect(parseCalls(' 7 ')).toBe(7);
    expect(parseCalls('0')).toBe(0);
  });

  it('returns null rather than 0 for an empty string', () => {
    // Number('') is 0. A blank cell is missing data, not zero calls.
    expect(parseCalls('')).toBeNull();
    expect(parseCalls('   ')).toBeNull();
  });

  it('rejects partially-numeric strings instead of truncating them', () => {
    // parseInt('12abc') would return 12 and silently accept garbage.
    expect(parseCalls('12abc')).toBeNull();
    expect(parseCalls('abc')).toBeNull();
  });

  it('never returns NaN or Infinity', () => {
    expect(parseCalls(Number.NaN)).toBeNull();
    expect(parseCalls(Number.POSITIVE_INFINITY)).toBeNull();
    expect(parseCalls(Number.NEGATIVE_INFINITY)).toBeNull();
    expect(parseCalls('Infinity')).toBeNull();
  });
});

describe('parseCallsInput', () => {
  it('accepts whole non-negative numbers', () => {
    expect(parseCallsInput('5')).toEqual({ ok: true, value: 5 });
    expect(parseCallsInput(' 42 ')).toEqual({ ok: true, value: 42 });
    expect(parseCallsInput('007')).toEqual({ ok: true, value: 7 });
    expect(parseCallsInput('0')).toEqual({ ok: true, value: 0 });
  });

  it('does NOT enforce the validator cap client-side', () => {
    // FR-4: the cap belongs to the validator. Rejecting 75 locally would be
    // faster but would bypass the rejection lifecycle we have to demonstrate.
    expect(parseCallsInput('75')).toEqual({ ok: true, value: 75 });
    expect(parseCallsInput(String(OUTLIER_CALLS_HINT + 1))).toEqual({ ok: true, value: 61 });
  });

  it.each([
    ['empty', ''],
    ['whitespace', '   '],
    ['decimal', '5.5'],
    ['negative', '-1'],
    ['signed positive', '+5'],
    ['letters', 'abc'],
    ['mixed', '12abc'],
    ['hex', '0x10'],
    ['exponent', '1e3'],
    ['internal space', '1 2'],
  ])('rejects %s input with a reason', (_label, raw) => {
    const result = parseCallsInput(raw);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(0);
  });

  it('rejects a pasted number too long to represent, without reaching Infinity', () => {
    const result = parseCallsInput('9'.repeat(400));
    expect(result).toEqual({ ok: false, reason: 'Value is too large' });
  });
});

describe('projectRows flags', () => {
  it('flags a null specialty', () => {
    const { dataset } = fixture([hcp({ specialty: null })]);
    expect(hasFlag(dataset, asRowKey(0), RowFlag.NullSpecialty)).toBe(true);
  });

  it('flags string-typed calls but still parses them', () => {
    const { dataset } = fixture([hcp({ calls: '9' })]);
    const k = asRowKey(0);
    expect(hasFlag(dataset, k, RowFlag.StringCalls)).toBe(true);
    expect(callsAt(dataset, k)).toBe(9);
  });

  it('flags an outlier by value, not by a hard-coded 99999', () => {
    const { dataset } = fixture([hcp({ calls: 99999 }), hcp({ calls: 61 }), hcp({ calls: 60 })]);
    expect(hasFlag(dataset, asRowKey(0), RowFlag.OutlierCalls)).toBe(true);
    expect(hasFlag(dataset, asRowKey(1), RowFlag.OutlierCalls)).toBe(true);
    expect(hasFlag(dataset, asRowKey(2), RowFlag.OutlierCalls)).toBe(false);
  });

  it('does not clamp the 99999 outlier', () => {
    const { dataset } = fixture([hcp({ calls: 99999 })]);
    expect(callsAt(dataset, asRowKey(0))).toBe(99999);
  });

  it('flags zero trx by value, so natural zeros are caught too', () => {
    const { dataset } = fixture([hcp({ trx: 0 }), hcp({ trx: 1 })]);
    expect(hasFlag(dataset, asRowKey(0), RowFlag.ZeroTrx)).toBe(true);
    expect(hasFlag(dataset, asRowKey(1), RowFlag.ZeroTrx)).toBe(false);
  });

  it('flags BOTH members of a duplicate-id pair', () => {
    // The first member cannot be known until the whole census exists, which is
    // why the flag needs a second pass.
    const { dataset } = fixture([
      hcp({ id: 'HCP-000001' }),
      hcp({ id: 'HCP-000002' }),
      hcp({ id: 'HCP-000001' }),
    ]);
    expect(hasFlag(dataset, asRowKey(0), RowFlag.DuplicateId)).toBe(true);
    expect(hasFlag(dataset, asRowKey(1), RowFlag.DuplicateId)).toBe(false);
    expect(hasFlag(dataset, asRowKey(2), RowFlag.DuplicateId)).toBe(true);
    expect(dataset.duplicateIds).toEqual(new Set(['HCP-000001']));
  });

  it('reports unparsable calls as null, never NaN', () => {
    const { dataset } = fixture([hcp({ calls: 'not a number' })]);
    const k = asRowKey(0);
    expect(callsAt(dataset, k)).toBeNull();
    expect(hasFlag(dataset, k, RowFlag.UnparsableCalls)).toBe(true);
    // The NaN sentinel stays inside the typed array and is translated at the edge.
    expect(Number.isNaN(dataset.callsNum[0])).toBe(true);
  });

  it('packs multiple defects into one row without collision', () => {
    const { dataset } = fixture([hcp({ specialty: null, calls: '99999', trx: 0 })]);
    const flags = flagsAt(dataset, asRowKey(0));
    expect(flags & RowFlag.NullSpecialty).toBeTruthy();
    expect(flags & RowFlag.StringCalls).toBeTruthy();
    expect(flags & RowFlag.OutlierCalls).toBeTruthy();
    expect(flags & RowFlag.ZeroTrx).toBeTruthy();
    expect(flags & RowFlag.UnparsableCalls).toBeFalsy();
  });
});

describe('the real dataset', () => {
  it('leaves the source array in generator order', () => {
    // HARD CONSTRAINT 6: identity is position, so the source must never move.
    const { dataset } = realData();
    expect(rowAt(dataset, asRowKey(0)).id).toBe('HCP-000001');
    expect(rowAt(dataset, asRowKey(1)).id).toBe('HCP-000002');
    expect(dataset.count).toBe(50_000);
  });

  it('lowercases name and id once, at load', () => {
    const { dataset } = realData();
    const k = asRowKey(0);
    expect(dataset.idLower[0]).toBe(rowAt(dataset, k).id.toLowerCase());
    expect(dataset.nameLower[0]).toBe(rowAt(dataset, k).name.toLowerCase());
  });

  it('never yields NaN from callsAt across all 50,000 rows', () => {
    const { dataset } = realData();
    for (let i = 0; i < dataset.count; i++) {
      const value = callsAt(dataset, asRowKey(i));
      if (value !== null) expect(Number.isNaN(value)).toBe(false);
    }
  });
});
