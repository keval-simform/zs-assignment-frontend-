import { buildChangeSet, serializeChangeSet } from '../../domain/exportDiff';
import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import styles from './Toolbar.module.css';

/**
 * Bonus: download the accepted change-set as JSON.
 *
 * DECISION: built on demand from `committed`, not accumulated as the user edits.
 * `committed` is already the authoritative diff — an accumulated list would be a
 * second representation of the same facts, and the two would drift the first time an
 * undo forgot to remove an entry.
 */
export function ExportDiff(): JSX.Element {
  const store = useHcpStore();
  const count = useStoreSelector((s) => s.committed.size);

  return (
    <button
      type="button"
      className={`${styles.button} ${styles.ghost}`}
      disabled={count === 0}
      title={
        count === 0
          ? 'No accepted edits to export'
          : `Download ${String(count)} accepted change(s) as JSON. Pending and rejected edits are excluded.`
      }
      onClick={() => {
        const { dataset, groups, committed } = store.getState();
        const json = serializeChangeSet(buildChangeSet(dataset, groups, committed, new Date().toISOString()));
        const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `hcp-changeset-${String(committed.size)}.json`;
        anchor.click();
        // Revoking immediately would race the download in some browsers.
        setTimeout(() => {
          URL.revokeObjectURL(url);
        }, 0);
      }}
    >
      Export diff{count === 0 ? '' : ` (${String(count)})`}
    </button>
  );
}
