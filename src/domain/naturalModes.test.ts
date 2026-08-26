import { describe, expect, it } from '@jest/globals';
import { realData } from '../test/fixtures';
import { asRowKey } from './identity';
import { RowFlag, callsAt, hasFlag, rowAt, trxAt } from './normalize';

/**
 * Verifies the governing principle recorded in CLAUDE.md:
 *
 *   index-based rules describe the generator's INTENT;
 *   value-based rules describe the DATA.
 *
 * They diverge wherever a defect has a **natural mode** — a way of occurring that
 * the seeding rule did not put there. This suite proves empirically which defects
 * have one, so the claim in the docs is measured rather than asserted from a
 * reading of the generator source.
 *
 * Every check below asks the same question in both directions: does the seeded
 * index set explain every defective row, and does every seeded index actually
 * carry the defect?
 */

/** The generator's seeding rules, replicated ONLY to classify rows, never to detect them. */
const SEED_RULES = {
  duplicateId: 9973,
  nullSpecialty: 97,
  stringCalls: 211,
  outlierCalls: 12007,
  zeroTrx: 577,
} as const;

function isSeededIndex(i: number, modulus: number): boolean {
  return i > 0 && i % modulus === 0;
}

/** Row indices where a predicate holds but the seeding rule does not explain it. */
function unexplained(modulus: number, predicate: (i: number) => boolean): number[] {
  const { dataset } = realData();
  const out: number[] = [];
  for (let i = 0; i < dataset.count; i++) {
    if (predicate(i) && !isSeededIndex(i, modulus)) out.push(i);
  }
  return out;
}

/** Row indices where the seeding rule fires but the defect is absent. */
function missing(modulus: number, predicate: (i: number) => boolean): number[] {
  const { dataset } = realData();
  const out: number[] = [];
  for (let i = modulus; i < dataset.count; i += modulus) {
    if (!predicate(i)) out.push(i);
  }
  return out;
}

describe('trx === 0 — the ONE defect with a natural mode', () => {
  const hasZeroTrx = (i: number): boolean => trxAt(realData().dataset, asRowKey(i)) === 0;

  it('has exactly 26 rows the seeding rule does not explain', () => {
    // trx = Math.round(rand() * 900), which returns 0 whenever rand() < 1/1800.
    // Expected count at 50,000 rows is ~27.8; measured is 26.
    expect(unexplained(SEED_RULES.zeroTrx, hasZeroTrx)).toHaveLength(26);
  });

  it('fires on every seeded index too, so the total is 86 + 26 = 112', () => {
    expect(missing(SEED_RULES.zeroTrx, hasZeroTrx)).toHaveLength(0);
    const { dataset } = realData();
    let total = 0;
    for (let i = 0; i < dataset.count; i++) if (hasZeroTrx(i)) total++;
    expect(total).toBe(112);
  });

  it('is why every zero-TRx check in the codebase is value-based', () => {
    // The 26 natural rows are flagged identically to the 86 seeded ones, because
    // RowFlag.ZeroTrx is set from `row.trx === 0` and never from the index.
    const { dataset } = realData();
    for (const i of unexplained(SEED_RULES.zeroTrx, hasZeroTrx)) {
      expect(hasFlag(dataset, asRowKey(i), RowFlag.ZeroTrx)).toBe(true);
    }
  });
});

describe('defects with NO natural mode', () => {
  it('specialty === null: only i % 97 can produce one', () => {
    // SPECIALTIES holds 8 non-null strings and the index is always in range, so
    // the generator has no other path to null.
    const has = (i: number): boolean => rowAt(realData().dataset, asRowKey(i)).specialty === null;
    expect(unexplained(SEED_RULES.nullSpecialty, has)).toHaveLength(0);
    expect(missing(SEED_RULES.nullSpecialty, has)).toHaveLength(0);
  });

  it('duplicate id: ids are strictly increasing, so only i % 9973 can collide', () => {
    const { dataset } = realData();
    const has = (i: number): boolean =>
      hasFlag(dataset, asRowKey(i), RowFlag.DuplicateId) && i > 0 && rowAt(dataset, asRowKey(i)).id === rowAt(dataset, asRowKey(i - 1)).id;
    expect(unexplained(SEED_RULES.duplicateId, has)).toHaveLength(0);
    expect(missing(SEED_RULES.duplicateId, has)).toHaveLength(0);
  });

  it('calls typed as string: Math.round() cannot return one', () => {
    const has = (i: number): boolean => typeof rowAt(realData().dataset, asRowKey(i)).calls === 'string';
    expect(unexplained(SEED_RULES.stringCalls, has)).toHaveLength(0);
    expect(missing(SEED_RULES.stringCalls, has)).toHaveLength(0);
  });

  it('calls above the cap of 60: the natural range is 0..40', () => {
    const has = (i: number): boolean => (callsAt(realData().dataset, asRowKey(i)) ?? 0) > 60;
    expect(unexplained(SEED_RULES.outlierCalls, has)).toHaveLength(0);
    expect(missing(SEED_RULES.outlierCalls, has)).toHaveLength(0);
  });

  it('calls unparsable: never happens, because every seeded string is numeric', () => {
    // String(Math.round(rand() * 40)) always parses, and 99999 is a number. The
    // null branch in parseCalls is a defensive path the union type permits but
    // that this seed does not exercise. Stated honestly rather than implied.
    const { dataset } = realData();
    let unparsable = 0;
    for (let i = 0; i < dataset.count; i++) {
      if (hasFlag(dataset, asRowKey(i), RowFlag.UnparsableCalls)) unparsable++;
    }
    expect(unparsable).toBe(0);
  });
});

describe('fields with a natural mode but no seeded rule', () => {
  it('nrx === 0 occurs naturally and carries no CPI consequence', () => {
    // Checked so the natural-mode audit is complete rather than selective:
    // nrx = Math.round(rand() * 300) hits 0 when rand() < 1/600. It is a
    // legitimate value, it divides nothing, and it needs no special handling.
    const { dataset } = realData();
    let zeroNrx = 0;
    for (let i = 0; i < dataset.count; i++) if (dataset.nrx[i] === 0) zeroNrx++;
    expect(zeroNrx).toBeGreaterThan(0);
    expect(zeroNrx).toBeLessThan(200);
  });
});
