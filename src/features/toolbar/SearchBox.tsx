import { useEffect, useState } from 'react';
import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import styles from './Toolbar.module.css';

/**
 * PERF: 150 ms. Long enough that a burst of typing produces one pipeline run
 * rather than one per character, short enough to still feel like live search. At
 * 50,000 rows the filter stage itself costs single digits of ms — the debounce is
 * about not scheduling eight renders while typing "anita", not the scan itself.
 */
const DEBOUNCE_MS = 150;

/**
 * FR-3: text search over name and ID.
 *
 * DECISION: the input keeps its own draft state and pushes to the store on a
 * debounce. Binding directly to `view.search` would put the whole derived pipeline
 * — filter, group totals, flatten — between the keypress and the character
 * appearing. The draft is local, so the caret never waits for anything.
 */
export function SearchBox(): JSX.Element {
  const store = useHcpStore();
  const committed = useStoreSelector((s) => s.view.search);
  const [draft, setDraft] = useState(committed);
  const visible = useStoreSelector((s) => s.dataset.count);

  useEffect(() => {
    if (draft === committed) return;
    const timer = setTimeout(() => {
      store.getState().setSearch(draft);
    }, DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, committed, store]);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="hcp-search">
        Search
      </label>
      <input
        id="hcp-search"
        className={styles.input}
        type="search"
        value={draft}
        placeholder="Name or ID"
        autoComplete="off"
        aria-describedby="hcp-search-hint"
        onChange={(e) => {
          setDraft(e.target.value);
        }}
      />
      <span id="hcp-search-hint" className={styles.hint}>
        {visible.toLocaleString()} HCPs
      </span>
    </div>
  );
}
