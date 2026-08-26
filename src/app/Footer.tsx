import { useStoreSelector } from '../store/StoreContext';
import { pipelineTimings } from '../store/pipelineTimings';
import styles from './Footer.module.css';

function Stat({
  label,
  value,
  title,
  emphasis,
}: {
  label: string;
  value: string;
  title: string;
  emphasis?: boolean;
}): JSX.Element {
  return (
    <span className={styles.stat} title={title}>
      <span className={styles.label}>{label}</span>
      <span className={`${styles.value} ${emphasis === true ? styles.pending : ''}`}>{value}</span>
    </span>
  );
}

/**
 * FR-1's required footer: rows currently in the DOM, and the last operation's cost.
 *
 * DECISION: "rows in DOM" includes group headers and overscan, since the metric's
 * job is to prove "only visible rows exist in the DOM" — excluding either would
 * overstate that claim. Settles around `viewport rows + 2 × overscan` (~40 on a
 * typical window) and stays flat while scrolling all 50,000 rows.
 *
 * Timings come from two sources: `lastOp` is store work, and pipeline stage numbers
 * are read from a module-scoped holder so instrumenting the pipeline doesn't
 * schedule the renders it measures.
 */
export function Footer({
  rowsInDom,
  flatRowCount,
  dataRowCount,
}: {
  rowsInDom: number;
  flatRowCount: number;
  dataRowCount: number;
}): JSX.Element {
  const lastOp = useStoreSelector((s) => s.lastOp);
  const pendingCount = useStoreSelector((s) => {
    let n = 0;
    for (const state of s.cellState.values()) if (state.kind === 'pending') n += 1;
    return n;
  });
  const committedCount = useStoreSelector((s) => s.committed.size);
  const totalRows = useStoreSelector((s) => s.dataset.count);

  return (
    <div className={styles.footer} role="status" aria-live="off">
      <Stat
        label="rows in DOM"
        value={rowsInDom.toLocaleString()}
        title="Row elements React actually rendered, including group headers and overscan. Stays flat while scrolling all 50,000 rows."
      />
      <Stat
        label="visible list"
        value={`${dataRowCount.toLocaleString()} of ${totalRows.toLocaleString()}`}
        title={`${flatRowCount.toLocaleString()} rows in the flattened list, group headers included`}
      />
      <Stat
        label="pending"
        value={pendingCount.toLocaleString()}
        title="Edits awaiting validation. These are excluded from every subtotal."
        emphasis={pendingCount > 0}
      />
      <Stat
        label="accepted edits"
        value={committedCount.toLocaleString()}
        title="Validator-accepted edits, which are the only edits aggregates can see."
      />
      <span className={styles.spacer} />
      <Stat
        label={lastOp.label}
        value={`${lastOp.ms.toFixed(1)} ms`}
        title="Cost of the last store operation"
      />
      <Stat
        label="filter"
        value={`${pipelineTimings.filterMs.toFixed(1)} ms`}
        title="Stage B — search and region filter over the source rows"
      />
      <Stat
        label="sort"
        value={`${pipelineTimings.sortMs.toFixed(1)} ms`}
        title={`Stage E — ${pipelineTimings.territoriesSorted} territory sort(s), ${pipelineTimings.sortCacheHits} cache hit(s)`}
      />
      <Stat
        label="flatten"
        value={`${pipelineTimings.flattenMs.toFixed(1)} ms`}
        title="Stage F — building the display list"
      />
    </div>
  );
}
