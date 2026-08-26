import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import { RegionFilter } from './RegionFilter';
import { SearchBox } from './SearchBox';
import { ExportDiff } from './ExportDiff';
import { UndoRedo } from './UndoRedo';
import { TenantSwitcher } from '../theme/TenantSwitcher';
import styles from './Toolbar.module.css';

/** FR-3 controls plus the FR-8 tenant app name. */
export function Toolbar(): JSX.Element {
  const store = useHcpStore();
  const appName = useStoreSelector((s) => s.theme.theme.appName);
  const sort = useStoreSelector((s) => s.view.sort);
  const search = useStoreSelector((s) => s.view.search);
  const regionFilter = useStoreSelector((s) => s.view.regionFilter);

  const anyFilter = search !== '' || regionFilter !== null || sort !== null;

  return (
    <div className={styles.toolbar}>
      <div className={styles.brand}>
        <h1 className={styles.appName}>{appName}</h1>
      </div>
      <SearchBox />
      <RegionFilter />
      <UndoRedo />
      <ExportDiff />
      <span className={styles.spacer} />
      <TenantSwitcher />
      {sort === null ? null : (
        <span className={styles.hint}>
          sorted by {sort.column} {sort.direction}
        </span>
      )}
      <button
        type="button"
        className={`${styles.button} ${styles.ghost}`}
        disabled={!anyFilter}
        onClick={() => {
          // Re-reads the store each call rather than sharing one snapshot: the
          // first call replaces `view`, so an up-front snapshot would go stale.
          store.getState().setSearch('');
          store.getState().setRegionFilter(null);
          store.getState().clearSort();
        }}
      >
        Reset view
      </button>
    </div>
  );
}
