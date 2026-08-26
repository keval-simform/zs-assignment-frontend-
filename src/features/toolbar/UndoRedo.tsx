import { describeCommand } from '../../store/commands';
import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import styles from './Toolbar.module.css';

/**
 * FR-4: undo/redo controls.
 *
 * DECISION: the buttons carry the *label of the command they would act on* in their
 * tooltip and accessible name. "Undo" alone gives the user no way to know what is
 * about to change — and with strict LIFO there is exactly one answer, so there is no
 * reason not to say it.
 */
export function UndoRedo(): JSX.Element {
  const store = useHcpStore();
  // Safe to select the command objects directly: immutable, references only
  // change when the history does.
  const nextUndo = useStoreSelector((s) => s.history.past.at(-1) ?? null);
  const nextRedo = useStoreSelector((s) => s.history.future[0] ?? null);

  return (
    <div className={styles.field}>
      <button
        type="button"
        className={`${styles.button} ${styles.ghost}`}
        disabled={nextUndo === null}
        title={nextUndo === null ? 'Nothing to undo' : `Undo: ${describeCommand(nextUndo)}`}
        aria-label={nextUndo === null ? 'Undo (nothing to undo)' : `Undo: ${describeCommand(nextUndo)}`}
        onClick={() => {
          store.getState().undo();
        }}
      >
        ↶ Undo
      </button>
      <button
        type="button"
        className={`${styles.button} ${styles.ghost}`}
        disabled={nextRedo === null}
        title={nextRedo === null ? 'Nothing to redo' : `Redo: ${describeCommand(nextRedo)}`}
        aria-label={nextRedo === null ? 'Redo (nothing to redo)' : `Redo: ${describeCommand(nextRedo)}`}
        onClick={() => {
          store.getState().redo();
        }}
      >
        ↷ Redo
      </button>
    </div>
  );
}
