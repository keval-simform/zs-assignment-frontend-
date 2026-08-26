import type { Aggregates } from '../domain/aggregate';
import { asCommandId, asReqId } from '../domain/identity';
import type { ReqId, RowKey } from '../domain/identity';
import { callsAt, parseCallsInput, rowAt } from '../domain/normalize';
import { toReason } from '../services/validatorClient';
import type { ValidatorClient } from '../services/validatorClient';
import { applyCommand } from './commands';
import { HISTORY_LIMIT } from './historySlice';
import type { Slice } from './slices';
import { isRetryable } from './types';
import type { CellUiState, Command, EditEntry, StoreActions, Toast } from './types';

export interface EditSlice {
  /** INVARIANT — see the declaration in `types.ts`. Accepted values ONLY. */
  readonly committed: ReadonlyMap<RowKey, number>;
  /** INVARIANT — see the declaration in `types.ts`. UI lifecycle ONLY. */
  readonly cellState: ReadonlyMap<RowKey, CellUiState>;
  readonly aggregates: Aggregates;
  readonly nextReqId: ReqId;
  readonly toasts: readonly Toast[];
  readonly nextToastId: number;
  beginEdit: StoreActions['beginEdit'];
  updateDraft: StoreActions['updateDraft'];
  cancelEdit: StoreActions['cancelEdit'];
  commitEdit: StoreActions['commitEdit'];
  retryEdit: StoreActions['retryEdit'];
  acknowledgeCell: StoreActions['acknowledgeCell'];
  dismissToast: StoreActions['dismissToast'];
  clearToasts: StoreActions['clearToasts'];
}

/** How many toasts are retained. Older ones fall off rather than growing forever. */
const TOAST_LIMIT = 20;

/**
 * The ticket a cell is currently waiting on, or `null` if it is not pending.
 *
 * Extracted because the stale guard runs on both the success and the failure path
 * and must read the state fresh at settle time, never close over the state it saw
 * when the request was made.
 */
function pendingReqId(cellState: ReadonlyMap<RowKey, CellUiState>, rowKey: RowKey): ReqId | null {
  const cell = cellState.get(rowKey);
  return cell?.kind === 'pending' ? cell.reqId : null;
}

function withCellState(
  cellState: ReadonlyMap<RowKey, CellUiState>,
  rowKey: RowKey,
  next: CellUiState | null,
): ReadonlyMap<RowKey, CellUiState> {
  const map = new Map(cellState);
  if (next === null) map.delete(rowKey);
  else map.set(rowKey, next);
  return map;
}

function pushToast(toasts: readonly Toast[], toast: Toast): readonly Toast[] {
  return [toast, ...toasts].slice(0, TOAST_LIMIT);
}

/**
 * FR-4: the async-validated Calls edit lifecycle.
 *
 * `editing -> pending -> saved | rejected`, with the guards in a deliberate order.
 * The ordering is the design: each guard exists to make a specific failure
 * unreachable, and moving one changes what is possible.
 */
export const createEditSlice =
  (initialAggregates: Aggregates, validator: ValidatorClient): Slice<EditSlice> =>
  (set, get) => ({
    committed: new Map(),
    cellState: new Map(),
    aggregates: initialAggregates,
    // Starts at 1 so 0 is never a valid ticket, and cannot be mistaken for one by
    // a zero-initialised field.
    nextReqId: asReqId(1),
    toasts: [],
    nextToastId: 1,

    beginEdit: (rowKey) => {
      const state = get();
      // FR-4: pending cells are locked against further edits. Refusing here, not
      // only in commitEdit, means the input never appears — a cell that looks
      // editable and silently discards typing would be worse.
      if (state.cellState.get(rowKey)?.kind === 'pending') return;
      const current = state.committed.get(rowKey) ?? callsAt(state.dataset, rowKey);
      set({
        view: {
          ...state.view,
          editing: { rowKey, draft: current === null ? '' : String(current), inputError: null },
        },
      });
    },

    updateDraft: (draft) => {
      const { view } = get();
      if (view.editing === null) return;
      // Clear inputError on each keystroke so the message describes the current
      // draft, not one that failed two characters ago.
      set({ view: { ...view, editing: { ...view.editing, draft, inputError: null } } });
    },

    cancelEdit: () => {
      const { view } = get();
      if (view.editing === null) return;
      set({ view: { ...view, editing: null } });
    },

    commitEdit: async (rowKey, raw) => {
      const state = get();

      // (a) FR-4: refuse while a previous commit for this cell is still in flight.
      // Without this, two requests race for one cell and the later-settling one
      // wins regardless of which the user asked for last.
      if (state.cellState.get(rowKey)?.kind === 'pending') return;

      // (b) Parse before anything else. An unparsable draft is the user's typo,
      // not a server question — it gets an inline message and never reaches the
      // validator, so a malformed edit costs no latency.
      const parsed = parseCallsInput(raw);
      if (!parsed.ok) {
        set({
          view: {
            ...state.view,
            editing: { rowKey, draft: raw, inputError: parsed.reason },
          },
        });
        return;
      }

      // (c) No-op detection. Committing the value a cell already holds costs
      // nothing: no validator call (no 10% chance of a spurious 503 on an
      // unchanged value) and no history entry (undo doesn't step through edits
      // that changed nothing).
      const currentValue = state.committed.get(rowKey) ?? callsAt(state.dataset, rowKey);
      if (parsed.value === currentValue) {
        set({ view: { ...state.view, editing: null } });
        return;
      }

      // (d) Enter `pending` with a fresh monotonic ticket.
      //
      // INVARIANT: `committed` is NOT touched here. That single fact is why
      // aggregates don't move while an edit is in flight — not a conditional in
      // the aggregate code, but the absence of a write. `cellState.proposed` holds
      // the value the user asked for, and nothing that computes a number reads it.
      const reqId = state.nextReqId;
      set({
        nextReqId: asReqId(reqId + 1),
        cellState: withCellState(state.cellState, rowKey, {
          kind: 'pending',
          reqId,
          proposed: parsed.value,
        }),
        view: { ...state.view, editing: null },
        lastOp: { label: 'edit pending', ms: 0 },
      });

      // (e) Await the black box.
      let failure: unknown = null;
      let rejected = false;
      const started = performance.now();
      try {
        await validator.validate(parsed.value);
      } catch (error) {
        rejected = true;
        failure = error;
      }
      const elapsed = performance.now() - started;

      // (f) STALE GUARD, on both paths.
      //
      // The validator cannot be cancelled — `validateCalls` is a bare `setTimeout`
      // with no abort path — so a superseded request still settles, up to 900 ms
      // later, and would otherwise clobber whatever the cell holds by then. Reading
      // the ticket from *current* state, not the closure, means that if the cell
      // is no longer pending on OUR reqId (undone, retried, or superseded), the
      // result is discarded in full — safe because nothing was written in step (d).
      if (pendingReqId(get().cellState, rowKey) !== reqId) return;

      if (rejected) {
        // (h) Rejected: the cell reverts to its committed value — no action needed,
        // since `committed` was never written — and the reason surfaces in two
        // places. See the Toast doc comment for why the cell alone is not enough.
        const reason = toReason(failure);
        const after = get();
        set({
          cellState: withCellState(after.cellState, rowKey, {
            kind: 'rejected',
            attempted: parsed.value,
            reason,
          }),
          toasts: pushToast(after.toasts, {
            id: after.nextToastId,
            kind: 'rejection',
            title: `${rowAt(after.dataset, rowKey).name} — Calls ${String(parsed.value)} rejected`,
            detail: reason.message,
            rowKey,
            attempted: parsed.value,
            action: isRetryable(reason) ? { kind: 'retry' } : null,
          }),
          nextToastId: after.nextToastId + 1,
          lastOp: { label: 'edit rejected', ms: elapsed },
        });
        return;
      }

      // (g) Accepted: write `committed`, delta the aggregates, push history.
      const after = get();
      const entry: EditEntry = { rowKey, before: currentValue, after: parsed.value };
      const command: Command = {
        kind: 'cell-edit',
        id: after.nextCommandId,
        label: `Calls ${String(currentValue ?? '—')} → ${String(parsed.value)} on ${rowAt(after.dataset, rowKey).id}`,
        entry,
      };
      const written = applyCommand(after, command);

      set({
        committed: written.committed,
        aggregates: written.aggregates,
        cellState: withCellState(after.cellState, rowKey, {
          kind: 'saved',
          value: parsed.value,
          at: after.nextCommandId,
        }),
        // FR-4: a new edit clears the redo stack — the future it described
        // branched off a state that no longer exists.
        history: { past: [...after.history.past, command].slice(-HISTORY_LIMIT), future: [] },
        nextCommandId: asCommandId(after.nextCommandId + 1),
        lastOp: { label: 'edit accepted', ms: elapsed },
      });
    },

    retryEdit: async (rowKey) => {
      const cell = get().cellState.get(rowKey);
      // Only a transient rejection can be retried. A cap violation is
      // deterministic — offering the button would be a lie.
      if (cell?.kind !== 'rejected' || !isRetryable(cell.reason)) return;
      await get().commitEdit(rowKey, String(cell.attempted));
    },

    acknowledgeCell: (rowKey) => {
      const { cellState } = get();
      const cell = cellState.get(rowKey);
      // A pending cell is never dismissible — its badge is load-bearing.
      if (cell === undefined || cell.kind === 'pending') return;
      set({ cellState: withCellState(cellState, rowKey, null) });
    },

    dismissToast: (id) => {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },

    clearToasts: () => {
      if (get().toasts.length === 0) return;
      set({ toasts: [] });
    },
  });
