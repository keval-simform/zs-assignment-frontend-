import { generateRows } from '../vendor/data-generator';
import type { HcpRecord } from '../vendor/data-generator';
import type { RowKey } from './identity';
import { buildGroupIndex } from './grouping';
import type { GroupIndex } from './grouping';
import { readF64, readI32, readItem, readU8 } from './typed';

/**
 * Calls values above this are flagged as outliers in the UI.
 *
 * DECISION: mirrors the validator's cap of 60, but is a *display hint only* — we
 * never use it to skip a `validateCalls()` call, since short-circuiting locally
 * would hide the rejection path FR-4 asks us to demonstrate. Flagging by value
 * rather than `calls === 99999` also catches a differently-seeded outlier.
 * EDGE CASE: the four `i % 12007` rows carry 99999, already above the cap.
 * Seeded data is invalid but grandfathered — displayed untouched, and any edit
 * to those cells will legitimately reject.
 */
export const OUTLIER_CALLS_HINT = 60;

/**
 * Per-row data-quality flags, packed one byte per row.
 *
 * DECISION: a single `Uint8Array` bitfield (50 KB) rather than a Set per defect
 * kind. Rendering a row needs an O(1) answer to "does this row have any badges",
 * and a bitfield gives that in one array read; five Set lookups per visible cell
 * would be five hash probes for the same answer.
 */
export const RowFlag = {
  None: 0,
  /** This row's `id` is shared with at least one other row. */
  DuplicateId: 1 << 0,
  /** `specialty === null`. */
  NullSpecialty: 1 << 1,
  /** The source `calls` value arrived as a string. */
  StringCalls: 1 << 2,
  /** Parsed `calls` exceeds `OUTLIER_CALLS_HINT`. */
  OutlierCalls: 1 << 3,
  /** `trx === 0`, so row CPI is undefined. */
  ZeroTrx: 1 << 4,
  /** `calls` could not be parsed to a finite number at all. */
  UnparsableCalls: 1 << 5,
} as const;

export type ParseResult =
  | { readonly ok: true; readonly value: number }
  | { readonly ok: false; readonly reason: string };

/**
 * Coerce a source `calls` value to a number.
 *
 * The generator types `calls` as `number | string` and emits ~236 strings, so
 * every consumer would otherwise have to re-decide how to compare them. We parse
 * once at load and everything downstream is numeric.
 *
 * DECISION: `Number()`, not `parseInt()`. `parseInt('12abc')` returns 12 and
 * silently accepts garbage; `Number('12abc')` returns NaN, which we surface as
 * `null`. The empty-string check comes first because `Number('')` is 0 — a blank
 * cell is missing data, not zero calls.
 *
 * @returns the numeric value, or `null` when the value is missing or unparsable.
 *   `null` rather than 0 because 0 is a legitimate call count: collapsing the two
 *   would understate nothing but would make a broken row indistinguishable from a
 *   real one, and would let a bad row silently join the Σ Calls aggregate.
 */
export function parseCalls(v: number | string): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const trimmed = v.trim();
  if (trimmed === '') return null;
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : null;
}

/**
 * Validate raw keyboard input for the Calls cell.
 *
 * Stricter than `parseCalls` on purpose: `parseCalls` has to accept whatever the
 * generator produced, while this one guards what a user is allowed to type.
 *
 * DECISION: this checks *form* (is it a whole non-negative number?) and never
 * *business rules* (the cap of 60). Rejecting >60 locally would be faster but
 * would bypass the validator, and FR-4's rejection lifecycle is exactly what we
 * are being asked to demonstrate. The digit-length ceiling exists so a pasted
 * 400-character number cannot reach `Number()` and come back as Infinity.
 */
export function parseCallsInput(raw: string): ParseResult {
  const trimmed = raw.trim();
  if (trimmed === '') return { ok: false, reason: 'Enter a number' };
  if (!/^\d+$/.test(trimmed)) return { ok: false, reason: 'Whole numbers only — no decimals, signs, or letters' };
  if (trimmed.length > 15) return { ok: false, reason: 'Value is too large' };
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value)) return { ok: false, reason: 'Value is too large' };
  return { ok: true, value };
}

/**
 * Column-oriented projections of the source rows.
 *
 * DECISION: typed arrays beside the original objects, not a transformed copy of
 * the objects. HARD CONSTRAINT 6 says the source array is never reordered, and
 * row identity is its index (see `identity.ts`), so the source has to survive
 * verbatim. The projections exist because the hot paths — filter, sort, aggregate
 * — touch one field at a time across many rows, which is the case column layout
 * is good at. `rows` stays available for rendering, where we need the whole record.
 */
export interface Dataset {
  readonly seed: number;
  readonly rows: readonly HcpRecord[];
  readonly count: number;
  /**
   * Parsed calls. `NaN` marks "unparsable" — the sentinel exists because a
   * Float64Array cannot hold `null`, and a parallel validity mask would be a
   * second array to keep in sync. `callsAt()` translates it back to `null` at
   * the boundary so no NaN escapes the domain layer (HARD CONSTRAINT 5).
   */
  readonly callsNum: Float64Array;
  readonly trx: Int32Array;
  readonly nrx: Int32Array;
  /**
   * PERF: lowercased once at load. Search runs on every keystroke over up to
   * 50,000 rows; calling `.toLowerCase()` in that loop would allocate 50,000
   * strings per keypress. Measured in the forensics output as build cost paid once.
   */
  readonly nameLower: readonly string[];
  readonly idLower: readonly string[];
  readonly flags: Uint8Array;
  /** The ids that appear on more than one row. 5 of them at seed 42. */
  readonly duplicateIds: ReadonlySet<string>;
}

export interface LoadedData {
  readonly dataset: Dataset;
  readonly groups: GroupIndex;
  /**
   * Cost of `generateRows` alone. Zero when rows were supplied directly, as
   * fixtures do.
   */
  readonly generateMs: number;
  /** Cost of the typed-array projection plus the group index. */
  readonly projectMs: number;
  /**
   * `generateMs + projectMs` — the number quoted in the README.
   *
   * Split out because the first version of this measured only the projection and
   * reported it as "generation + projection + grouping", losing ~28 ms of
   * generation. An instrumentation number that quietly excludes a third of the
   * work is worse than no number.
   */
  readonly buildMs: number;
}

/** The source record for a row. */
export function rowAt(d: Dataset, k: RowKey): HcpRecord {
  return readItem(d.rows, k);
}

/**
 * A row's source calls value.
 * @returns `null` when the source value was unparsable — never `NaN`.
 */
export function callsAt(d: Dataset, k: RowKey): number | null {
  const v = readF64(d.callsNum, k);
  return Number.isNaN(v) ? null : v;
}

export function trxAt(d: Dataset, k: RowKey): number {
  return readI32(d.trx, k);
}

export function nrxAt(d: Dataset, k: RowKey): number {
  return readI32(d.nrx, k);
}

/** Whether a row carries a given `RowFlag`. */
export function hasFlag(d: Dataset, k: RowKey, flag: number): boolean {
  return (readU8(d.flags, k) & flag) !== 0;
}

/** All flags set on a row, as a raw bitfield. */
export function flagsAt(d: Dataset, k: RowKey): number {
  return readU8(d.flags, k);
}

/**
 * Run the generator once and build every projection and index the app needs.
 *
 * DECISION: duplicate ids are found by *counting occurrences*, not by
 * re-implementing the generator's `i % 9973` rule. Reading the defect out of the
 * data rather than out of the generator source means the handling stays correct
 * if the seed, the row count, or the generator's internals change — and it is the
 * discovery method the assignment is actually asking for.
 */
export function buildDataset(seed = 42, n = 50_000): LoadedData {
  const started = performance.now();
  const rows = generateRows(seed, n);
  const generateMs = performance.now() - started;
  const projected = projectRows(rows, seed);
  return { ...projected, generateMs, buildMs: generateMs + projected.projectMs };
}

/**
 * The projection half of `buildDataset`, split out so tests can build a dataset
 * from a handful of hand-written records instead of 50,000 generated ones.
 * A four-row fixture that isolates one defect is worth more than an assertion
 * buried in a scan of the real data — and both are used here.
 */
export function projectRows(rows: readonly HcpRecord[], seed: number): LoadedData {
  const started = performance.now();
  const count = rows.length;

  const callsNum = new Float64Array(count);
  const trx = new Int32Array(count);
  const nrx = new Int32Array(count);
  const nameLower: string[] = new Array<string>(count);
  const idLower: string[] = new Array<string>(count);
  const flags = new Uint8Array(count);

  const idCounts = new Map<string, number>();

  for (let i = 0; i < count; i++) {
    const row = readItem(rows, i);
    const parsed = parseCalls(row.calls);

    callsNum[i] = parsed ?? Number.NaN;
    trx[i] = row.trx;
    nrx[i] = row.nrx;
    nameLower[i] = row.name.toLowerCase();
    idLower[i] = row.id.toLowerCase();

    let f = RowFlag.None;
    if (row.specialty === null) f |= RowFlag.NullSpecialty;
    if (typeof row.calls === 'string') f |= RowFlag.StringCalls;
    if (parsed === null) f |= RowFlag.UnparsableCalls;
    else if (parsed > OUTLIER_CALLS_HINT) f |= RowFlag.OutlierCalls;
    // EDGE CASE: value-based, not index-based — `trx` also lands on 0 by chance
    // (not just via the seeded `i % 577` rule), and an index-based test would miss it.
    if (row.trx === 0) f |= RowFlag.ZeroTrx;
    flags[i] = f;

    idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
  }

  const duplicateIds = new Set<string>();
  for (const [id, seen] of idCounts) if (seen > 1) duplicateIds.add(id);

  // Second pass only over the flag: a row is flagged once the full census exists,
  // because the *first* member of a duplicate pair cannot be known until the end.
  if (duplicateIds.size > 0) {
    for (let i = 0; i < count; i++) {
      if (duplicateIds.has(readItem(rows, i).id)) flags[i] = readU8(flags, i) | RowFlag.DuplicateId;
    }
  }

  const groups = buildGroupIndex(rows);

  const dataset: Dataset = {
    seed,
    rows,
    count,
    callsNum,
    trx,
    nrx,
    nameLower,
    idLower,
    flags,
    duplicateIds,
  };

  const projectMs = performance.now() - started;
  return { dataset, groups, generateMs: 0, projectMs, buildMs: projectMs };
}
