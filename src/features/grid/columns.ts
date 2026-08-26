import type { ColumnId } from '../../domain/comparators';

export interface ColumnDef {
  readonly id: ColumnId;
  readonly label: string;
  /** CSS grid track size. */
  readonly track: string;
  /** Numeric columns are right-aligned and use tabular figures. */
  readonly numeric: boolean;
  /** Screen-reader description for the sort control. */
  readonly description: string;
}

/**
 * The grid's columns, in display order.
 *
 * DECISION: fixed pixel tracks for every column except Name, which takes the
 * remaining space. Predictable widths let group header rows align their Σ columns
 * with the data rows below by spanning the first three tracks — an `auto`-sized
 * layout would drift between the two row kinds and the totals would misalign.
 */
export const COLUMNS: readonly ColumnDef[] = [
  { id: 'id', label: 'ID', track: '132px', numeric: false, description: 'HCP identifier' },
  { id: 'name', label: 'Name', track: 'minmax(180px, 1fr)', numeric: false, description: 'HCP name' },
  { id: 'specialty', label: 'Specialty', track: '150px', numeric: false, description: 'Specialty' },
  { id: 'calls', label: 'Calls', track: '96px', numeric: true, description: 'Calls, editable' },
  { id: 'trx', label: 'TRx', track: '96px', numeric: true, description: 'Total prescriptions' },
  { id: 'nrx', label: 'NRx', track: '96px', numeric: true, description: 'New prescriptions' },
  { id: 'cpi', label: 'CPI', track: '96px', numeric: true, description: 'Calls per indication' },
];

/** The `grid-template-columns` value shared by header, group and data rows. */
export const GRID_TEMPLATE = COLUMNS.map((c) => c.track).join(' ');

/**
 * How many leading tracks a group header's label spans.
 *
 * INVARIANT: must equal the number of non-numeric columns. If a text column is
 * added without updating this, group subtotals shift one column left of the
 * figures they summarise — a silently wrong-looking table rather than an error.
 */
export const GROUP_LABEL_SPAN = COLUMNS.filter((c) => !c.numeric).length;

/** Uniform row height in px. Uniform is what makes the windowing maths a division. */
export const ROW_HEIGHT = 32;

/**
 * Rows rendered beyond the viewport on each side.
 *
 * PERF: 6 rows ≈ 192 px of buffer. Enough that a fast flick does not expose blank
 * space before the next frame lands, small enough that the DOM stays at roughly
 * viewport + 12 rows. Raising it trades a constant DOM cost for fewer visible gaps.
 */
export const OVERSCAN = 6;
