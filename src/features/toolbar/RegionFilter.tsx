import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import styles from './Toolbar.module.css';

/**
 * FR-3: region filter.
 *
 * EDGE CASE: "National" appears here as an ordinary option. It is one of six peer
 * regions with its own 8 territories, not a rollup — special-casing it would double
 * count every row it contains against a total the data never asked for (§A7).
 */
export function RegionFilter(): JSX.Element {
  const store = useHcpStore();
  const regionKeys = useStoreSelector((s) => s.groups.regionKeys);
  const selected = useStoreSelector((s) => s.view.regionFilter);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="hcp-region">
        Region
      </label>
      <select
        id="hcp-region"
        className={styles.select}
        value={selected ?? ''}
        onChange={(e) => {
          // Empty option means "no filter" (null), not an empty-string region name.
          store.getState().setRegionFilter(e.target.value === '' ? null : e.target.value);
        }}
      >
        <option value="">All regions</option>
        {regionKeys.map((region) => (
          <option key={region} value={region}>
            {region}
          </option>
        ))}
      </select>
    </div>
  );
}
