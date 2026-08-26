import { memo, useEffect, useRef } from 'react';
import type { RowKey } from '../../domain/identity';
import { EM_DASH } from '../../domain/cpi';
import { RowFlag, callsAt, flagsAt } from '../../domain/normalize';
import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import { isRetryable } from '../../store/types';
import type { CellUiState } from '../../store/types';
import styles from './CallsCell.module.css';

/** A short, non-chromatic marker per state. Never the only signal — see the CSS. */
function marker(cell: CellUiState | undefined): string {
  if (cell === undefined) return '';
  switch (cell.kind) {
    case 'pending':
      return '⟳';
    case 'saved':
      return '✓';
    case 'rejected':
      return '⚠';
    default: {
      const unhandled: never = cell;
      throw new Error(`Unhandled cell state: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * What a screen reader hears.
 *
 * The lifecycle state is *spoken*, not merely coloured — the accessible half of
 * WCAG 1.4.1, alongside the glyphs and borders that cover it visually. The outlier
 * fact is included here rather than left to a `title` attribute, since a flag only
 * a sighted user can see would defeat the same requirement.
 */
function describe(cell: CellUiState | undefined, value: number | null, isOutlier: boolean): string {
  const shown = value === null ? 'no value' : String(value);
  const outlier = isOutlier ? ' Outlier value: above the per-HCP cap of 60.' : '';
  if (cell === undefined) return `Calls ${shown}.${outlier} Press Enter to edit.`;
  switch (cell.kind) {
    case 'pending':
      return `Calls ${shown}, validating ${String(cell.proposed)}. Locked until the server answers.${outlier}`;
    case 'saved':
      return `Calls ${shown}, saved.${outlier}`;
    case 'rejected':
      return `Calls ${shown}. ${String(cell.attempted)} was rejected: ${cell.reason.message}${outlier}`;
    default: {
      const unhandled: never = cell;
      throw new Error(`Unhandled cell state: ${JSON.stringify(unhandled)}`);
    }
  }
}

function EditingInput({ rowKey }: { rowKey: RowKey }): JSX.Element {
  const store = useHcpStore();
  const draft = useStoreSelector((s) => s.view.editing?.draft ?? '');
  const inputError = useStoreSelector((s) => s.view.editing?.inputError ?? null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    ref.current?.select();
  }, []);

  return (
    <div className={styles.editing}>
      <input
        ref={ref}
        className={`${styles.input} ${inputError === null ? '' : styles.inputInvalid}`}
        value={draft}
        autoFocus
        aria-label="Calls"
        aria-invalid={inputError !== null}
        aria-errormessage={inputError === null ? undefined : `calls-error-${String(rowKey)}`}
        inputMode="numeric"
        onChange={(e) => {
          store.getState().updateDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void store.getState().commitEdit(rowKey, draft);
            return;
          }
          if (e.key === 'Escape') {
            e.preventDefault();
            store.getState().cancelEdit();
          }
        }}
        // DECISION: blur neither commits nor cancels. In a virtualized grid a blur
        // can fire from the row unmounting mid-scroll — committing there would apply
        // an unconfirmed edit, cancelling would lose typing the user can still see.
        // Enter/Esc are the only exits; the draft lives in the store, so it survives
        // scrolling away and back.
      />
      {inputError === null ? null : (
        <span className={styles.inputError} id={`calls-error-${String(rowKey)}`} role="alert">
          {inputError}
        </span>
      )}
    </div>
  );
}

/**
 * FR-4: the editable Calls cell, with all five lifecycle states.
 *
 * idle · editing · pending · saved · rejected. `idle` is the absence of a
 * `cellState` entry rather than a union member, so a fresh grid holds zero map
 * entries instead of 50,000.
 *
 * DECISION: the *displayed* number is always the committed value, even while a
 * pending edit proposes a different one — the proposal shows beside it, never in
 * place of it. Substituting it would be an optimistic update, and the cell would
 * disagree with its group subtotal for the whole 300–900 ms validation window.
 */
export const CallsCell = memo(function CallsCell({ rowKey }: { rowKey: RowKey }): JSX.Element {
  const store = useHcpStore();
  const value = useStoreSelector((s) => s.committed.get(rowKey) ?? callsAt(s.dataset, rowKey));
  const cell = useStoreSelector((s) => s.cellState.get(rowKey));
  const isEditing = useStoreSelector((s) => s.view.editing?.rowKey === rowKey);
  const isOutlier = useStoreSelector((s) => (flagsAt(s.dataset, rowKey) & RowFlag.OutlierCalls) !== 0);

  if (isEditing) return <EditingInput rowKey={rowKey} />;

  const stateClass =
    cell === undefined
      ? ''
      : cell.kind === 'pending'
        ? styles.pending
        : cell.kind === 'saved'
          ? styles.saved
          : styles.rejected;

  return (
    <button
      type="button"
      className={`${styles.cell} ${stateClass}`}
      aria-label={describe(cell, value, isOutlier)}
      // FR-4: a pending cell is locked. Disabling it removes it from the tab order
      // too, rather than looking focusable and swallowing the keystroke.
      disabled={cell?.kind === 'pending'}
      title={
        cell?.kind === 'rejected'
          ? `${cell.reason.message}${isRetryable(cell.reason) ? ' — retryable' : ' — will fail again with this value'}`
          : undefined
      }
      onDoubleClick={() => {
        store.getState().beginEdit(rowKey);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === 'F2') {
          e.preventDefault();
          store.getState().beginEdit(rowKey);
        }
      }}
    >
      {cell?.kind === 'pending' ? (
        <>
          <span className={`${styles.marker} ${styles.spinner}`} aria-hidden="true">
            {marker(cell)}
          </span>
          <span className={styles.proposed} aria-hidden="true">
            →{cell.proposed}
          </span>
        </>
      ) : null}
      {cell !== undefined && cell.kind !== 'pending' ? (
        <span className={styles.marker} aria-hidden="true">
          {marker(cell)}
        </span>
      ) : null}
      {isOutlier ? (
        <span className={styles.marker} aria-hidden="true" title="Above the per-HCP cap of 60">
          ⚑
        </span>
      ) : null}
      <span>{value === null ? EM_DASH : value.toLocaleString()}</span>
    </button>
  );
});
