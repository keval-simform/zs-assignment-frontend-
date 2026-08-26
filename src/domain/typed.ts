/**
 * Bounds-checked reads for the typed arrays and dense arrays that back the
 * dataset.
 *
 * `noUncheckedIndexedAccess` widens every indexed read — including
 * `Float64Array[i]` — to `T | undefined`. The three ways to satisfy it are
 * `!` (banned by HARD CONSTRAINT 4), `?? 0` (silently turns an out-of-bounds
 * read into a plausible-looking zero), and an explicit check. We take the
 * explicit check: an out-of-range RowKey is a programming error and should be
 * loud, not smoothed over into a wrong aggregate.
 *
 * PERF: one comparison against `undefined` per read. The branch is perfectly
 * predicted (it never taken in correct code) and the functions are small enough
 * for V8 to inline, so full-dataset scans measure the same as raw indexing.
 * Full scans that do not need random access should still iterate with `for..of`,
 * which yields `number` directly and skips the check entirely.
 */

/** @throws RangeError when `i` is outside the array. */
export function readF64(a: Float64Array, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`Float64Array index ${i} out of range (len ${a.length})`);
  return v;
}

/** @throws RangeError when `i` is outside the array. */
export function readI32(a: Int32Array, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`Int32Array index ${i} out of range (len ${a.length})`);
  return v;
}

/** @throws RangeError when `i` is outside the array. */
export function readU32(a: Uint32Array, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`Uint32Array index ${i} out of range (len ${a.length})`);
  return v;
}

/** @throws RangeError when `i` is outside the array. */
export function readU8(a: Uint8Array, i: number): number {
  const v = a[i];
  if (v === undefined) throw new RangeError(`Uint8Array index ${i} out of range (len ${a.length})`);
  return v;
}

/**
 * Read from a dense array. `T` is constrained to exclude `undefined` because the
 * `undefined` check IS the bounds check — a sparse array of `T | undefined`
 * would make this function lie.
 * @throws RangeError when `i` is outside the array.
 */
export function readItem<T extends NonNullable<unknown> | null>(a: readonly T[], i: number): T {
  const v = a[i];
  if (v === undefined) throw new RangeError(`Array index ${i} out of range (len ${a.length})`);
  return v;
}
