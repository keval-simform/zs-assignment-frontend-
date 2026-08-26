import { memo } from 'react';
import { rowCpi } from '../../domain/cpi';
import type { RowKey } from '../../domain/identity';
import { RowFlag, callsAt, flagsAt, nrxAt, rowAt, trxAt } from '../../domain/normalize';
import { useStoreSelector } from '../../store/StoreContext';
import { CallsCell } from './CallsCell';
import { CpiValue, IntegerValue, TextValue } from './cells';
import styles from './Grid.module.css';

/**
 * One HCP row.
 *
 * DECISION: the only prop is `rowKey` — a branded integer, not the record object.
 * A primitive prop lets `React.memo` work: the row re-renders only when its own
 * subscribed values change, so one cell going pending re-renders that cell's row,
 * not the grid. Passing the record would defeat memo, since the parent would look
 * it up fresh and recreate the reference on every render.
 *
 * DECISION: seeded defects are rendered *visibly*, not smoothed over — a missing
 * specialty is an em dash, a colliding id carries a ⚠, an outlier Calls value is
 * marked. The point is that these are decided and visible, not silently sanitised.
 */
export const DataRow = memo(function DataRow({ rowKey }: { rowKey: RowKey }): JSX.Element {
  const row = useStoreSelector((s) => rowAt(s.dataset, rowKey));
  const flags = useStoreSelector((s) => flagsAt(s.dataset, rowKey));
  const trx = useStoreSelector((s) => trxAt(s.dataset, rowKey));
  const nrx = useStoreSelector((s) => nrxAt(s.dataset, rowKey));
  // The committed value if one exists, else the source value. A pending value is
  // deliberately unreachable here — CPI must not move while an edit is unvalidated,
  // for the same reason the subtotals must not.
  const calls = useStoreSelector((s) => s.committed.get(rowKey) ?? callsAt(s.dataset, rowKey));
  // FR-4: highlight a row an undo has just brought back into view.
  const isFlashing = useStoreSelector((s) => s.flashRowKeys.has(rowKey));

  const isDuplicateId = (flags & RowFlag.DuplicateId) !== 0;

  return (
    <div className={`${styles.row} ${styles.dataRow} ${isFlashing ? styles.flash : ''}`} role="row">
      <div className={`${styles.cell} ${styles.idCell}`} role="gridcell">
        <span>{row.id}</span>
        {isDuplicateId ? (
          <span
            className={`${styles.badge} ${styles.badgeDuplicate}`}
            title="This ID is shared with another row. Rows are identified by position, not by ID."
            aria-label="duplicate identifier"
          >
            ⚠
          </span>
        ) : null}
      </div>
      <div className={styles.cell} role="gridcell">
        {row.name}
      </div>
      <div className={styles.cell} role="gridcell">
        <TextValue value={row.specialty} />
      </div>
      {/* FR-4: the one editable column. */}
      <div className={styles.cellEditable} role="gridcell">
        <CallsCell rowKey={rowKey} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <IntegerValue value={trx} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <IntegerValue value={nrx} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        {/* EDGE CASE: trx === 0 on 112 rows. rowCpi returns null, never Infinity. */}
        <CpiValue value={rowCpi(calls, trx)} />
      </div>
    </div>
  );
});
