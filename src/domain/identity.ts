/**
 * Branded integer identities for the four different "small non-negative integer"
 * roles in this app. They are all `number` at runtime and carry zero cost.
 *
 * DECISION: row identity is the index into the source array returned by
 * `generateRows`, NOT `record.id`. The generator deliberately duplicates ids
 * (`i % 9973 === 0` copies the previous row's id), so an id can address more than
 * one row; names collide even more heavily (256 distinct combinations across
 * 50,000 rows). The array index is the only value unique by construction.
 * Alternative rejected: a surrogate uuid per row — unique, but a 50,000-entry Map
 * lookup on every render instead of a direct array offset. ASSUMPTIONS.md §B1.
 *
 * INVARIANT: because identity IS position, the source array must never be sorted,
 * spliced, or reordered. If it ever is, every committed edit, selection, and undo
 * entry silently retargets a different HCP.
 */

declare const RowKeyBrand: unique symbol;
/** Index into the source `HcpRecord[]`. Stable for the lifetime of the dataset. */
export type RowKey = number & { readonly [RowKeyBrand]: true };

declare const FlatIndexBrand: unique symbol;
/**
 * Position in the *flattened, currently-visible* list (group headers included).
 * Distinct from RowKey on purpose: this one changes whenever the user sorts,
 * filters, or expands anything, so confusing the two is a whole bug class —
 * scroll-to-row landing on the wrong HCP, React keys recycling cell state.
 */
export type FlatIndex = number & { readonly [FlatIndexBrand]: true };

declare const RegionIndexBrand: unique symbol;
/** Index into `GroupIndex.regionKeys` (6 of them). */
export type RegionIndex = number & { readonly [RegionIndexBrand]: true };

declare const TerritoryIndexBrand: unique symbol;
/** Index into `GroupIndex.territoryKeys` (48 of them). */
export type TerritoryIndex = number & { readonly [TerritoryIndexBrand]: true };

declare const ReqIdBrand: unique symbol;
/**
 * A monotonic validation-request ticket.
 *
 * The vendor validator cannot be cancelled — once fired it *will* settle — so
 * every request carries one of these and every settle handler compares it against
 * the cell's current ticket before touching state. Branded so it can never be
 * mistaken for the value being validated, which is also a number.
 */
export type ReqId = number & { readonly [ReqIdBrand]: true };

declare const OpIdBrand: unique symbol;
/** Groups the entries of one bulk operation (FR-5) so they undo as a single step. */
export type OpId = number & { readonly [OpIdBrand]: true };

declare const CommandIdBrand: unique symbol;
/** Identifies one entry in the undo history. */
export type CommandId = number & { readonly [CommandIdBrand]: true };

function assertIndex(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer, received ${String(n)}`);
  }
}

/**
 * The `as*` functions in this file are the ONLY sanctioned type-assertion sites in
 * the codebase (HARD CONSTRAINT 4). Branding is unrepresentable without one
 * assertion, so it is centralised here, guarded by a runtime check, rather than
 * sprinkled across call sites.
 * @throws RangeError if `n` is not a non-negative safe integer.
 */
export function asRowKey(n: number): RowKey {
  assertIndex(n, 'RowKey');
  return n as RowKey;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asFlatIndex(n: number): FlatIndex {
  assertIndex(n, 'FlatIndex');
  return n as FlatIndex;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asRegionIndex(n: number): RegionIndex {
  assertIndex(n, 'RegionIndex');
  return n as RegionIndex;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asTerritoryIndex(n: number): TerritoryIndex {
  assertIndex(n, 'TerritoryIndex');
  return n as TerritoryIndex;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asReqId(n: number): ReqId {
  assertIndex(n, 'ReqId');
  return n as ReqId;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asOpId(n: number): OpId {
  assertIndex(n, 'OpId');
  return n as OpId;
}

/** @throws RangeError if `n` is not a non-negative safe integer. */
export function asCommandId(n: number): CommandId {
  assertIndex(n, 'CommandId');
  return n as CommandId;
}
