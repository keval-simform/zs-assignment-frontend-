/** What we render wherever a value is genuinely undefined. */
export const EM_DASH = '—';

/**
 * Calls Per Indication for a single row: `calls / trx * 100`.
 *
 * DECISION: returns `null`, never 0, when the ratio is undefined. A CPI of 0
 * means "this HCP was prescribed to but never called"; a CPI of `null` means "we
 * cannot know". Collapsing them would put fabricated zeros into a column
 * salespeople read as a performance signal.
 *
 * EDGE CASE: `trx === 0` on 112 measured rows — 86 from the seeded `i % 577` rule
 * and 26 that land on zero by chance, because `trx` is `Math.round(rand() * 900)`.
 * Both are handled because the test is on the value, not on the row index; a rule
 * written from the generator source would leak Infinity into those 26.
 *
 * @param calls parsed calls, or `null` if the source value was unparsable.
 * @returns the ratio, or `null` when calls are unknown or TRx is zero.
 *   Never `NaN` and never `Infinity` (HARD CONSTRAINT 5).
 */
export function rowCpi(calls: number | null, trx: number): number | null {
  if (calls === null || trx === 0) return null;
  const cpi = (calls / trx) * 100;
  // Defensive: the types say this is finite, but this is the single choke point
  // for CPI, so it is the cheapest place to guarantee constraint 5 holds.
  return Number.isFinite(cpi) ? cpi : null;
}

/**
 * Aggregate CPI for a group: `Σcalls / Σtrx * 100`.
 *
 * DECISION: **ratio of sums**, not mean of per-row ratios. The two disagree, and
 * they disagree most exactly where it matters. A territory of 1,000 HCPs where one
 * has `calls 1 / trx 1` (CPI 100) and 999 have `calls 10 / trx 100` (CPI 10) has a
 * mean-of-ratios of 10.09 but a ratio-of-sums of 10.0 — the mean lets one
 * low-volume row swing a territory-wide number. Ratio of sums is also the only
 * definition that composes: a region's CPI equals the CPI of its combined
 * territories, which is what makes the O(1) delta update in `aggregate.ts` valid.
 * Documented in ASSUMPTIONS.md §B7.
 *
 * A further consequence worth stating: rows with `trx === 0` contribute their
 * calls to Σcalls and nothing to Σtrx. They are not excluded. Excluding them
 * would make Σ Calls in the header disagree with the sum of the visible Calls
 * column, which is a worse lie than a slightly optimistic ratio.
 *
 * @returns `null` when Σtrx is 0 — the whole group has no prescriptions.
 */
export function groupCpi(sumCalls: number, sumTrx: number): number | null {
  if (sumTrx === 0) return null;
  const cpi = (sumCalls / sumTrx) * 100;
  return Number.isFinite(cpi) ? cpi : null;
}

/**
 * Render a CPI for display.
 * @returns one decimal place, or an em dash when the value is undefined. The
 *   `Number.isFinite` guard is deliberate belt-and-braces: the type forbids NaN
 *   here, but this is the last function before the DOM.
 */
export function formatCpi(cpi: number | null, fractionDigits = 1): string {
  if (cpi === null || !Number.isFinite(cpi)) return EM_DASH;
  return cpi.toFixed(fractionDigits);
}
