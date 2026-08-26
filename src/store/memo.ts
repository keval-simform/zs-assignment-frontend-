/**
 * Single-slot memoisation keyed on argument identity.
 *
 * DECISION: one slot, not an LRU. The pipeline runs for exactly one state at a
 * time, so a second slot would only ever hold the previous frame's result, which
 * nothing asks for again. An LRU would add eviction policy and a Map lookup to
 * buy a hit rate that is already 100% here.
 *
 * Identity comparison is sound because every value the store holds is replaced
 * rather than mutated — a new `committed` map means a genuinely new map. Under
 * in-place mutation this memo would return a stale result forever, since the
 * reference would never change.
 */
export function memo1<A extends readonly unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
  let slot: { readonly args: A; readonly result: R } | null = null;
  return (...args: A): R => {
    if (slot !== null && slot.args.length === args.length && slot.args.every((a, i) => a === args[i])) {
      return slot.result;
    }
    const result = fn(...args);
    slot = { args, result };
    return result;
  };
}
