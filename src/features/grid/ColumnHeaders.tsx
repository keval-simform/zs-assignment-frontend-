import { useStoreSelector, useHcpStore } from '../../store/StoreContext';
import type { ColumnId, SortDirection } from '../../domain/comparators';
import { isNumericColumn } from '../../domain/comparators';
import { COLUMNS } from './columns';
import styles from './Grid.module.css';

/** ARIA's vocabulary for the three sort states. */
function ariaSort(direction: SortDirection | null): 'ascending' | 'descending' | 'none' {
  switch (direction) {
    case 'asc':
      return 'ascending';
    case 'desc':
      return 'descending';
    case null:
      return 'none';
    default: {
      const unhandled: never = direction;
      throw new Error(`Unhandled sort direction: ${String(unhandled)}`);
    }
  }
}

function indicator(direction: SortDirection | null): string {
  switch (direction) {
    case 'asc':
      return '▲';
    case 'desc':
      return '▼';
    case null:
      return '▲';
    default: {
      const unhandled: never = direction;
      throw new Error(`Unhandled sort direction: ${String(unhandled)}`);
    }
  }
}

function HeaderCell({ column }: { column: ColumnId }): JSX.Element {
  const store = useHcpStore();
  const def = COLUMNS.find((c) => c.id === column);
  const direction = useStoreSelector((s) => (s.view.sort?.column === column ? s.view.sort.direction : null));

  if (def === undefined) throw new Error(`No column definition for ${column}`);

  const numeric = isNumericColumn(column);
  return (
    <button
      type="button"
      role="columnheader"
      aria-sort={ariaSort(direction)}
      className={`${styles.headerCell} ${def.numeric ? styles.headerCellNumeric : ''}`}
      onClick={() => {
        store.getState().toggleSort(column);
      }}
      title={
        numeric
          ? `Sort by ${def.label}. Groups reorder by their ${def.label} subtotal.`
          : `Sort by ${def.label}`
      }
    >
      <span>{def.label}</span>
      <span
        className={`${styles.sortIndicator} ${direction === null ? styles.sortIndicatorInactive : ''}`}
        aria-hidden="true"
      >
        {indicator(direction)}
      </span>
    </button>
  );
}

/**
 * FR-3: three-state sort on every column, announced through `aria-sort`.
 *
 * Rendered inside the scroll container and stuck to its top, so vertical scrolling
 * pins the headers while horizontal scrolling carries them with the columns —
 * outside the container it would need `scrollLeft` mirrored by hand every frame.
 */
export function ColumnHeaders(): JSX.Element {
  return (
    <div className={styles.headerRow} role="row">
      {COLUMNS.map((c) => (
        <HeaderCell key={c.id} column={c.id} />
      ))}
    </div>
  );
}
