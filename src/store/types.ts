import type { Aggregates } from '../domain/aggregate';
import type { ColumnId, SortDirection, SortSpec } from '../domain/comparators';
import type { GroupIndex } from '../domain/grouping';
import type { CommandId, OpId, RegionIndex, ReqId, RowKey, TerritoryIndex } from '../domain/identity';
import type { Dataset } from '../domain/normalize';
import type { ResolvedTheme } from '../features/theme/types';

/**
 * Why a validator rejection happened.
 *
 * DECISION: a discriminated union, not `{ message: string; retryable: boolean }`.
 * The two rejection kinds differ in more than a boolean — a cap violation is
 * deterministic and the user's own input, so retrying is guaranteed to fail; a
 * 503 is transient and retrying is the correct affordance. Deriving retryability
 * from `kind` (see `isRetryable`) keeps the two facts from drifting apart, which
 * a parallel boolean field invites.
 */
export type RejectionReason =
  | { readonly kind: 'cap'; readonly message: string }
  | { readonly kind: 'transient'; readonly message: string }
  | { readonly kind: 'unknown'; readonly message: string };

/** A cap violation is the user's input and will fail identically on retry. */
export function isRetryable(reason: RejectionReason): boolean {
  return reason.kind !== 'cap';
}

/**
 * FR-4's cell lifecycle, as data.
 *
 * INVARIANT: this describes only what the *cell* looks like — it is never read
 * by aggregation. `proposed` in particular is a visual overlay: the value the
 * user asked for, not a value anything has accepted, and no arithmetic may
 * consult it.
 *
 * A cell with no entry in `cellState` is idle. Absence is the fifth state, which
 * is why there is no `{ kind: 'idle' }` member — representing it explicitly would
 * mean 50,000 map entries at rest.
 */
export type CellUiState =
  | { readonly kind: 'pending'; readonly reqId: ReqId; readonly proposed: number }
  | { readonly kind: 'saved'; readonly value: number; readonly at: number }
  | { readonly kind: 'rejected'; readonly attempted: number; readonly reason: RejectionReason };

/**
 * One row's before/after for a single accepted change.
 *
 * `before` and `after` are `number | null` rather than `number`: `null` means "no
 * parsable value", which is reachable in both directions (an accepted edit on an
 * unparsable row, and the undo of one).
 */
export interface EditEntry {
  readonly rowKey: RowKey;
  readonly before: number | null;
  readonly after: number | null;
}

/**
 * FR-4 + FR-6: undo as a command history, never as data snapshots.
 *
 * `bulk-edit` is present in the type from the start even though FR-5 is a design
 * deliverable. The design's whole point is that the applied subset of a
 * partially-failed bulk operation is *one* undo step, which is only true if the
 * command shape can hold many entries — a shape that couldn't would make the
 * design undeliverable, not merely unimplemented.
 */
export type Command =
  | { readonly kind: 'cell-edit'; readonly id: CommandId; readonly label: string; readonly entry: EditEntry }
  | {
      readonly kind: 'bulk-edit';
      readonly id: CommandId;
      readonly label: string;
      readonly opId: OpId;
      readonly entries: readonly EditEntry[];
    };

/** The entries a command touches, in a form both apply and undo can walk. */
export function commandEntries(command: Command): readonly EditEntry[] {
  switch (command.kind) {
    case 'cell-edit':
      return [command.entry];
    case 'bulk-edit':
      return command.entries;
    default: {
      const unhandled: never = command;
      throw new Error(`Unhandled command kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** Which cell the user is currently typing in. At most one at a time. */
export interface EditingCell {
  readonly rowKey: RowKey;
  /** Raw keystrokes, unparsed. Parsing happens on commit, not per character. */
  readonly draft: string;
  /** Set when the draft fails `parseCallsInput`, so the cell can explain itself. */
  readonly inputError: string | null;
}

/**
 * Explicit expand/collapse intent, keyed by group.
 *
 * DECISION: a `Map<key, boolean>` of *intent*, not a `Set` of open groups. FR-3
 * requires search to auto-expand groups containing matches, so effective
 * expansion has two inputs: what the user chose, and what the search implied.
 * With a single Set the two get merged, and clearing the search would destroy
 * the user's own expansion state.
 *
 * With intent stored separately, the resolution rule is one line —
 * `intent.get(k) ?? searchExpanded.has(k)` — and it handles the awkward case
 * correctly: a user collapsing a group that the search auto-expanded records
 * `false`, which wins. Under a two-Set model that toggle would appear to do
 * nothing.
 *
 * Absent from the map means "no opinion": follow the search, default closed.
 */
export interface ExpansionIntent {
  readonly regions: ReadonlyMap<RegionIndex, boolean>;
  readonly territories: ReadonlyMap<TerritoryIndex, boolean>;
}

export interface ViewState {
  /** Debounced committed search text. The input's own keystrokes live in the component. */
  readonly search: string;
  /** Region *name*, not index — it survives a dataset rebuild and reads clearly in a URL. */
  readonly regionFilter: string | null;
  /** `null` is the third sort state, not a missing value. */
  readonly sort: SortSpec | null;
  readonly userExpanded: ExpansionIntent;
  readonly editing: EditingCell | null;
  /**
   * Bumped whenever `search` or `regionFilter` changes.
   *
   * PERF: the per-territory sort cache is keyed on this instead of on the filter
   * strings. An integer compare replaces a string compare on a key that is
   * consulted once per expanded territory per render.
   */
  readonly filterVersion: number;
}

/**
 * A transient message about something that happened out of view.
 *
 * FR-4 requires rejection reasons to reach the user. A cell-only error is not
 * enough: the row that started an edit can scroll out of the DOM during the
 * validator's 300–900 ms, and an error painted on an unmounted component is an
 * error nobody sees. So rejections surface in two places — on the cell if still
 * mounted, and here unconditionally.
 */
export interface Toast {
  readonly id: number;
  readonly kind: 'rejection' | 'info';
  readonly title: string;
  readonly detail: string;
  /** The row involved, so the toast can offer to reveal or retry it. */
  readonly rowKey: RowKey | null;
  /** The value that was refused, so "Retry" has something to resend. */
  readonly attempted: number | null;
  /**
   * What the toast can offer to do about it, if anything.
   *
   * DECISION: a discriminated union rather than a `retryable: boolean`. There are
   * two distinct affordances — retry a transient failure, and drop the filter
   * hiding an undone row — and a second boolean would let `retryable: true,
   * showable: true` typecheck into a toast with two contradictory buttons. `null`
   * means "nothing to offer", which is itself information: a cap violation is
   * deterministic, so the honest UI is an explanation, not a button.
   */
  readonly action: ToastAction | null;
}

export type ToastAction =
  | { readonly kind: 'retry' }
  /** FR-6: the undone row exists but a filter is hiding it. */
  | { readonly kind: 'show' };

/** What the last user-visible operation cost, for the FR-1 footer. */
export interface LastOp {
  readonly label: string;
  readonly ms: number;
}

/**
 * FR-6: a request from the store that the view bring a row into sight.
 *
 * DECISION: the store expresses *intent* and the grid performs the effect. An
 * action cannot scroll — the scroll container is a DOM node owned by a
 * component, and reaching for it from the store would need a module-level ref
 * (untestable, and wrong the moment two grids exist) or imperative DOM work
 * inside a state transition. As state, "this row should be visible" is also
 * inspectable in a test without a DOM at all.
 */
export interface RevealRequest {
  readonly rowKey: RowKey;
  /**
   * Bumped per request from `nextRevealNonce`. Without it, undoing twice into the
   * same row would produce an identical object, the grid's effect wouldn't re-run,
   * and the second reveal would silently do nothing.
   */
  readonly nonce: number;
  /** Which filter is hiding the row, if any — drives the "Show it" affordance. */
  readonly blockedBy: 'search' | 'region' | 'both' | null;
}

export interface StoreState {
  /** Immutable for the lifetime of the app. HARD CONSTRAINT 6. */
  readonly dataset: Dataset;
  readonly groups: GroupIndex;

  /**
   * INVARIANT — the single most important line in this file.
   *
   * `committed` holds ONLY values the validator has accepted. `cellState` holds
   * ONLY the UI lifecycle. They are two maps on purpose.
   *
   * Aggregation reads `committed` and nothing else: `computeAggregates` and
   * `applyCallsChange` take a `ReadonlyMap<RowKey, number>` with no parameter
   * through which a pending value could arrive. FR-2's "aggregates must not
   * include edits that are still pending validation" is therefore a property of
   * the type signature, not a conditional someone has to remember.
   *
   * If these were merged into one `Map<RowKey, { value, status }>`:
   *   1. Every aggregate site would need `if (status === 'accepted')`, and the
   *      one site that forgot would produce a subtotal that silently counts
   *      unsaved work.
   *   2. A cell flipping to `pending` would change the map aggregation depends
   *      on, invalidating the aggregate memo and recomputing 50,000 rows to
   *      arrive at the identical answer.
   *   3. Undo would have to distinguish "revert an accepted value" from "cancel a
   *      pending one" by inspecting a status field, instead of the two living in
   *      structurally separate places.
   */
  readonly committed: ReadonlyMap<RowKey, number>;
  /** See the INVARIANT on `committed`. UI lifecycle only — never read by aggregation. */
  readonly cellState: ReadonlyMap<RowKey, CellUiState>;

  /**
   * Group subtotals, maintained by delta from `committed`.
   *
   * Stored rather than derived because the O(1) delta needs the previous value
   * to add to. A pure selector would have to recompute all 50,000 rows to
   * produce what a two-integer addition already gives us.
   */
  readonly aggregates: Aggregates;

  readonly view: ViewState;
  /** FR-5: rows chosen for a bulk action. */
  readonly selection: ReadonlySet<RowKey>;
  readonly history: { readonly past: readonly Command[]; readonly future: readonly Command[] };
  readonly theme: ResolvedTheme;
  /**
   * What the last store-side operation cost.
   *
   * DECISION: only work the *store* does lands here — applying an accepted edit,
   * an undo, a redo. Pipeline stage timings (filter / aggregate / sort) live in a
   * module-scoped holder in `selectors.ts` instead, since writing them into the
   * store would mean calling `set()` from inside a memoised selector. The footer
   * reads both sources and labels them separately.
   */
  readonly lastOp: LastOp;
  /**
   * Monotonic source for `ReqId`s.
   *
   * INVARIANT: never reset and never reused. The stale guard compares a settled
   * request's ticket against the cell's current one, so a recycled id could let
   * a superseded result pass the guard and overwrite newer state.
   */
  readonly nextReqId: ReqId;
  readonly nextCommandId: CommandId;
  readonly toasts: readonly Toast[];
  readonly nextToastId: number;
  /** FR-4: set by undo/redo, consumed and cleared by the grid. */
  readonly reveal: RevealRequest | null;
  /**
   * Monotonic source for reveal nonces.
   *
   * INVARIANT: a separate counter, never derived from `reveal?.nonce`. Deriving
   * it looked equivalent but wasn't: `consumeReveal` sets `reveal` to null, so
   * the next nonce would fall back to 0 + 1 and repeated reveals of the same row
   * would produce an identical request the grid's effect correctly ignores. Same
   * class of bug as a reused `ReqId`.
   */
  readonly nextRevealNonce: number;
  /**
   * Rows currently flashing after a reveal.
   *
   * A set rather than a single key because the interesting cases come in pairs —
   * the two rows sharing a duplicate id are only meaningful highlighted together.
   */
  readonly flashRowKeys: ReadonlySet<RowKey>;
}

export interface StoreActions {
  setSearch: (search: string) => void;
  setRegionFilter: (region: string | null) => void;
  /** FR-3 three-state cycle: asc -> desc -> none. A new column restarts at asc. */
  toggleSort: (column: ColumnId) => void;
  /**
   * Drop the sort outright.
   *
   * Distinct from `toggleSort` on purpose: cycling from 'asc' lands on 'desc', so a
   * "reset" built out of `toggleSort` advances the sort instead of clearing it —
   * which is exactly the bug this action was added to fix.
   */
  clearSort: () => void;
  toggleRegion: (region: RegionIndex) => void;
  toggleTerritory: (territory: TerritoryIndex) => void;

  toggleRowSelection: (rowKey: RowKey) => void;
  selectTerritoryRows: (territory: TerritoryIndex, selected: boolean) => void;
  clearSelection: () => void;

  /** Open a cell for editing, seeded with its current effective value. */
  beginEdit: (rowKey: RowKey) => void;
  /** Record a keystroke. Parsing happens on commit, not per character. */
  updateDraft: (draft: string) => void;
  /** Abandon the draft without touching `committed` or `cellState`. */
  cancelEdit: () => void;
  /** FR-4: parse, lock, validate, and apply or reject. */
  commitEdit: (rowKey: RowKey, raw: string) => Promise<void>;
  /** Re-send a value whose rejection was transient. */
  retryEdit: (rowKey: RowKey) => Promise<void>;
  /** Clear a cell's `saved` / `rejected` badge without changing any value. */
  acknowledgeCell: (rowKey: RowKey) => void;
  dismissToast: (id: number) => void;
  clearToasts: () => void;

  /** FR-8: switch tenants at runtime. `null` selects the built-in default. */
  setTenant: (tenantId: string | null) => void;
  /** FR-4/FR-6: invert the most recent command. Strict LIFO. */
  undo: () => void;
  /** FR-4/FR-6: re-apply the most recently undone command. Does not re-validate. */
  redo: () => void;
  /** Ask the view to bring a row into sight. */
  revealRow: (rowKey: RowKey) => void;
  /** Reveal the first row and flash all of them. */
  revealRows: (rowKeys: readonly RowKey[]) => void;
  /** The grid calls this once it has scrolled. */
  consumeReveal: () => void;
  /** Stop the post-reveal highlight. */
  clearFlash: () => void;
  /** Drop whichever filters are hiding a row, then reveal it. */
  showHiddenRow: (rowKey: RowKey) => void;
}

export type Store = StoreState & StoreActions;

/** The direction a three-state sort moves to next. `null` means "no sort". */
export function nextSortDirection(current: SortDirection | null): SortDirection | null {
  switch (current) {
    case null:
      return 'asc';
    case 'asc':
      return 'desc';
    case 'desc':
      return null;
    default: {
      const unhandled: never = current;
      throw new Error(`Unhandled sort direction: ${String(unhandled)}`);
    }
  }
}
