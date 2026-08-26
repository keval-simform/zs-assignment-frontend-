import { asCommandId, asRegionIndex, asTerritoryIndex } from '../domain/identity';
import type { CommandId, RowKey } from '../domain/identity';
import { readU8 } from '../domain/typed';
import { describeCommand, invertCommand, applyCommand } from './commands';
import { rowFilterBlock } from './selectors';
import type { Slice } from './slices';
import { commandEntries } from './types';
import type { CellUiState, Command, RevealRequest, Store, StoreActions, Toast } from './types';

export interface HistorySlice {
  readonly history: { readonly past: readonly Command[]; readonly future: readonly Command[] };
  readonly nextCommandId: CommandId;
  readonly reveal: RevealRequest | null;
  readonly nextRevealNonce: number;
  readonly flashRowKeys: ReadonlySet<RowKey>;
  undo: StoreActions['undo'];
  redo: StoreActions['redo'];
  revealRow: StoreActions['revealRow'];
  revealRows: StoreActions['revealRows'];
  consumeReveal: StoreActions['consumeReveal'];
  clearFlash: StoreActions['clearFlash'];
  showHiddenRow: StoreActions['showHiddenRow'];
}

/**
 * FR-4/FR-6: command history, capped.
 *
 * DECISION: 100 commands. Undo is a *recovery* affordance, not version control —
 * past a hundred steps a user reaches for a filter, not the undo key. The cap
 * matters because a single `bulk-edit` command can hold thousands of entries, so
 * an uncapped history is unbounded memory, not a slowly growing array.
 */
export const HISTORY_LIMIT = 100;

/** Drop the saved/rejected badges on rows a command touched. */
function clearCellStates(
  cellState: ReadonlyMap<RowKey, CellUiState>,
  command: Command,
): ReadonlyMap<RowKey, CellUiState> {
  const next = new Map(cellState);
  // After an undo the "saved" marker describes a value that is no longer there —
  // leaving it would be a badge asserting something false.
  for (const entry of commandEntries(command)) next.delete(entry.rowKey);
  return next;
}

/** The row a reveal should target: the first entry a command touched. */
function revealTarget(command: Command): RowKey | null {
  return commandEntries(command)[0]?.rowKey ?? null;
}

/**
 * Expansion intent that opens a row's ancestor groups.
 *
 * FR-6: undoing a change whose row sits inside a collapsed group must expand it
 * and scroll it into view. Writing `true` into the intent maps, rather than
 * relying on search auto-expansion, means the expansion survives the user then
 * clearing the search — the same mechanism a manual chevron click uses.
 */
function expandAncestors(store: Store, rowKey: RowKey): Store['view']['userExpanded'] {
  const region = asRegionIndex(readU8(store.groups.regionOf, rowKey));
  const territory = asTerritoryIndex(readU8(store.groups.territoryOf, rowKey));
  return {
    regions: new Map(store.view.userExpanded.regions).set(region, true),
    territories: new Map(store.view.userExpanded.territories).set(territory, true),
  };
}

/** A row with an edit in flight cannot be undone — see the DECISION on `undo`. */
function inFlightRow(store: Store, command: Command): RowKey | null {
  for (const entry of commandEntries(command)) {
    if (store.cellState.get(entry.rowKey)?.kind === 'pending') return entry.rowKey;
  }
  return null;
}

function busyToast(store: Store, command: Command): Toast {
  return {
    id: store.nextToastId,
    kind: 'info',
    title: 'Cannot undo yet',
    detail: `"${describeCommand(command)}" touches a row whose edit is still being validated.`,
    rowKey: inFlightRow(store, command),
    attempted: null,
    action: null,
  };
}

function hiddenToast(store: Store, command: Command, rowKey: RowKey, blockedBy: string): Toast {
  return {
    id: store.nextToastId,
    kind: 'info',
    title: `Undone: ${describeCommand(command)}`,
    // FR-6: undo changes truth regardless of the filter. The change is applied
    // either way; the view adapts if it can, and says so plainly when it cannot.
    detail: `The row is hidden by the current ${blockedBy === 'both' ? 'search and region filter' : blockedBy}.`,
    rowKey,
    attempted: null,
    action: { kind: 'show' },
  };
}

export const createHistorySlice: Slice<HistorySlice> = (set, get) => ({
  history: { past: [], future: [] },
  nextCommandId: asCommandId(1),
  reveal: null,
  nextRevealNonce: 1,
  flashRowKeys: new Set(),

  /**
   * FR-4/FR-6: invert the most recent command.
   *
   * DECISION: **strict LIFO.** Only `past.at(-1)` is ever undoable. Out-of-order
   * undo would let a stale `before` clobber a newer value — edit a row 10→20, then
   * 20→30, undo the *first* command, and it writes `before: 10` over a cell that
   * holds 30, silently discarding the second edit. LIFO makes that impossible by
   * construction rather than by a merge rule nobody can reason about.
   *
   * DECISION: undo does **not** re-validate. The `before` value was already
   * accepted when it was first written, so asking again adds latency and a 10%
   * chance of a spurious 503 to an operation whose whole job is restoring a
   * known-good state. Against a real backend where other users edit the same rows,
   * undo would need to re-validate and have its own conflict story; this one can't.
   *
   * DECISION: refused while any row in the command has an edit in flight. The
   * in-flight request will settle and write `committed`; if undo ran first, the two
   * writes would order by latency rather than intent. The user gets a toast rather
   * than a silently ignored keystroke.
   */
  undo: () => {
    const state = get();
    const command = state.history.past.at(-1);
    if (command === undefined) return;

    if (inFlightRow(state, command) !== null) {
      set({ toasts: [busyToast(state, command), ...state.toasts], nextToastId: state.nextToastId + 1 });
      return;
    }

    const started = performance.now();
    const written = invertCommand(state, command);
    const target = revealTarget(command);

    set({
      committed: written.committed,
      aggregates: written.aggregates,
      cellState: clearCellStates(state.cellState, command),
      history: {
        past: state.history.past.slice(0, -1),
        future: [command, ...state.history.future].slice(0, HISTORY_LIMIT),
      },
      lastOp: { label: 'undo', ms: performance.now() - started },
    });

    if (target !== null) get().revealRow(target);
  },

  /**
   * FR-4/FR-6: re-apply the most recently undone command.
   *
   * DECISION: redo does **not** re-validate either. The value was already accepted
   * once; with a 10% random 503 rate, re-validating would fail on a known-good
   * value roughly one time in ten, so a user who undid and changed their mind would
   * watch their own previously-accepted edit get rejected for no visible reason.
   * Against a real backend where state can drift under you, redo *should*
   * re-validate — here nothing can have changed, since this client is the only
   * writer.
   */
  redo: () => {
    const state = get();
    const command = state.history.future[0];
    if (command === undefined) return;

    if (inFlightRow(state, command) !== null) {
      set({ toasts: [busyToast(state, command), ...state.toasts], nextToastId: state.nextToastId + 1 });
      return;
    }

    const started = performance.now();
    const written = applyCommand(state, command);
    const target = revealTarget(command);

    set({
      committed: written.committed,
      aggregates: written.aggregates,
      cellState: clearCellStates(state.cellState, command),
      history: {
        past: [...state.history.past, command].slice(-HISTORY_LIMIT),
        future: state.history.future.slice(1),
      },
      lastOp: { label: 'redo', ms: performance.now() - started },
    });

    if (target !== null) get().revealRow(target);
  },

  /**
   * FR-6: expand the ancestor groups, ask the grid to scroll, and flash the row.
   *
   * If the current filter excludes the row the change stays applied — see
   * `hiddenToast` — and the toast offers "Show it", which drops the conflicting
   * filter rather than guessing at what the user wanted.
   */
  revealRow: (rowKey) => {
    const state = get();
    const blockedBy = rowFilterBlock(state, rowKey);
    const nonce = state.nextRevealNonce;

    if (blockedBy !== null) {
      const command = state.history.future[0] ?? state.history.past.at(-1);
      set({
        reveal: { rowKey, nonce, blockedBy },
        nextRevealNonce: nonce + 1,
        toasts:
          command === undefined
            ? state.toasts
            : [hiddenToast(state, command, rowKey, blockedBy), ...state.toasts],
        nextToastId: state.nextToastId + 1,
      });
      return;
    }

    set({
      view: { ...state.view, userExpanded: expandAncestors(state, rowKey) },
      reveal: { rowKey, nonce, blockedBy: null },
      nextRevealNonce: nonce + 1,
      flashRowKeys: new Set([rowKey]),
    });
  },

  revealRows: (rowKeys) => {
    const first = rowKeys[0];
    if (first === undefined) return;
    get().revealRow(first);
    // revealRow flashes only its target; widen the set so a colliding pair lights
    // up together.
    if (rowKeys.length > 1) set({ flashRowKeys: new Set(rowKeys) });
  },

  consumeReveal: () => {
    if (get().reveal === null) return;
    set({ reveal: null });
  },

  clearFlash: () => {
    if (get().flashRowKeys.size === 0) return;
    set({ flashRowKeys: new Set() });
  },

  showHiddenRow: (rowKey) => {
    const state = get();
    const blockedBy = rowFilterBlock(state, rowKey);
    if (blockedBy === null) {
      get().revealRow(rowKey);
      return;
    }
    // Drop only the filters actually in the way — clearing both unconditionally
    // would throw away a region filter the user still wanted.
    if (blockedBy === 'search' || blockedBy === 'both') state.setSearch('');
    if (blockedBy === 'region' || blockedBy === 'both') state.setRegionFilter(null);
    get().revealRow(rowKey);
  },
});
