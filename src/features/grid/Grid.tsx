import { useEffect } from 'react';
import { flatIndexOfRow, flatRowKey, selectFlat } from '../../store/selectors';
import type { FlatRow } from '../../store/selectors';
import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import { Footer } from '../../app/Footer';
import { ColumnHeaders } from './ColumnHeaders';
import { DataRow } from './DataRow';
import { RegionHeaderRow, TerritoryHeaderRow } from './GroupHeaderRow';
import { GRID_TEMPLATE, OVERSCAN, ROW_HEIGHT } from './columns';
import { useVirtualWindow } from './useVirtualWindow';
import styles from './Grid.module.css';

/**
 * Dispatch one flat row to its component.
 *
 * The exhaustive `never` check makes adding a third grouping level a compile error
 * here, rather than a row that silently fails to render.
 */
function renderRow(row: FlatRow): JSX.Element {
  switch (row.kind) {
    case 'region':
      return <RegionHeaderRow region={row.region} />;
    case 'territory':
      return <TerritoryHeaderRow territory={row.territory} />;
    case 'data':
      return <DataRow rowKey={row.rowKey} />;
    default: {
      const unhandled: never = row;
      throw new Error(`Unhandled flat row kind: ${JSON.stringify(unhandled)}`);
    }
  }
}

/**
 * The shared column template, handed to CSS as a custom property so the header
 * row, group rows and data rows cannot drift out of alignment.
 *
 * DECISION: declared as an interface extension rather than cast through
 * `as React.CSSProperties`. `CSSProperties` has no index signature for custom
 * properties, so the cast would be unchecked (HARD CONSTRAINT 4) and would also
 * silence a genuine typo in the property name.
 */
interface GridShellStyle extends React.CSSProperties {
  readonly '--grid-template': string;
}

const SHELL_STYLE: GridShellStyle = { '--grid-template': GRID_TEMPLATE };

/** How long a revealed row stays highlighted. Long enough to find, short enough not to nag. */
const FLASH_MS = 1400;

/**
 * FR-1 + FR-2: the virtualized, grouped grid.
 *
 * Only the rows inside the window exist in the DOM. The scrollbar's range comes
 * from a spacer of `totalHeight`; the rendered rows sit in an absolutely positioned
 * layer translated down by `offsetY`.
 *
 * DECISION: `translateY` on one wrapper, not `top` on each row. A transform is a
 * compositor-thread property, so scrolling never triggers layout — whereas setting
 * `top` on 40 elements per frame invalidates layout 40 times.
 */
export function Grid(): JSX.Element {
  const store = useHcpStore();
  const flat = useStoreSelector(selectFlat);
  const groups = useStoreSelector((s) => s.groups);
  const reveal = useStoreSelector((s) => s.reveal);
  const flashCount = useStoreSelector((s) => s.flashRowKeys.size);
  const { scrollRef, window: win, totalHeight } = useVirtualWindow(flat.rows.length, ROW_HEIGHT, OVERSCAN);

  // FR-4: bring an undone row into view. The store asks; the DOM work happens here
  // because the scroll container belongs to this component, not the store. The
  // request is consumed rather than left in state, so the same row can be revealed
  // twice — the `nonce` is what makes the second request a new object.
  useEffect(() => {
    if (reveal === null) return;
    if (reveal.blockedBy === null) {
      const index = flatIndexOfRow(store.getState(), reveal.rowKey);
      const el = scrollRef.current;
      if (index >= 0 && el !== null) {
        // Centre it rather than scroll to the top edge — flush against the sticky
        // header reads as clipped.
        el.scrollTop = Math.max(0, index * ROW_HEIGHT - el.clientHeight / 2 + ROW_HEIGHT / 2);
      }
    }
    store.getState().consumeReveal();
  }, [reveal, store, scrollRef]);

  // Transient highlight: clears itself on a timer rather than waiting for another
  // interaction to displace it.
  useEffect(() => {
    if (flashCount === 0) return;
    const timer = setTimeout(() => {
      store.getState().clearFlash();
    }, FLASH_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [flashCount, store]);

  const visible = flat.rows.slice(win.start, win.end);

  return (
    <div className={styles.shell} style={SHELL_STYLE}>
      <div className={styles.viewport} ref={scrollRef} role="grid" aria-rowcount={flat.rows.length}>
        <ColumnHeaders />
        {flat.rows.length === 0 ? (
          <div className={styles.empty}>No HCPs match the current search and filter.</div>
        ) : (
          <div className={styles.spacer} style={{ height: totalHeight }}>
            <div className={styles.window} style={{ transform: `translateY(${win.offsetY}px)` }}>
              {visible.map((row) => (
                // INVARIANT: the key is the row's identity — RowKey, or the group's
                // own key — never its position in the flat list. A position key
                // would let React recycle component state onto whatever row slides
                // into that slot: an open edit box would jump to a different doctor
                // mid-scroll, and a pending spinner would follow the viewport
                // instead of its own cell.
                <div key={flatRowKey(row, groups)}>{renderRow(row)}</div>
              ))}
            </div>
          </div>
        )}
      </div>
      <Footer rowsInDom={visible.length} flatRowCount={flat.rows.length} dataRowCount={flat.dataRowCount} />
    </div>
  );
}
