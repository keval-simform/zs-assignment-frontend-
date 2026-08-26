import { memo } from 'react';
import { groupCpi } from '../../domain/cpi';
import { asRegionIndex, asTerritoryIndex } from '../../domain/identity';
import type { RegionIndex, TerritoryIndex } from '../../domain/identity';
import { readF64, readItem, readU32 } from '../../domain/typed';
import { useStoreSelector, useHcpStore } from '../../store/StoreContext';
import { selectFilter, selectRegionVisible, selectTerritoryVisible, isRegionOpen, isTerritoryOpen } from '../../store/selectors';
import { CpiValue, IntegerValue } from './cells';
import { GROUP_LABEL_SPAN } from './columns';
import styles from './Grid.module.css';

/**
 * FR-2: a group header row with live subtotals.
 *
 * DECISION: every value is selected as a **primitive**. Selecting the group's
 * totals object instead — `s => totalsAt(s.aggregates.region, region)` — would
 * allocate a fresh object per render; Zustand compares snapshots by reference, so
 * it would re-render forever. Six primitive selectors are cheap; one allocating
 * selector is a bug.
 *
 * DECISION: collapsed groups still show their aggregates — the subtotal is the
 * reason to collapse a group in the first place, letting a rep scan territory
 * performance without the 1,000 rows.
 */
interface GroupRowProps {
  readonly count: number;
  readonly visible: number;
  readonly sumCalls: number;
  readonly sumTrx: number;
  readonly sumNrx: number;
  readonly nullCalls: number;
  readonly label: string;
  readonly open: boolean;
  readonly isRegion: boolean;
  readonly onToggle: () => void;
}

function GroupRowShell({
  count,
  visible,
  sumCalls,
  sumTrx,
  sumNrx,
  nullCalls,
  label,
  open,
  isRegion,
  onToggle,
}: GroupRowProps): JSX.Element {
  // With a filter active the header shows both numbers: the group's true totals and
  // how many of its rows are on screen.
  const filtered = visible !== count;

  return (
    <div
      className={`${styles.row} ${styles.groupRow} ${isRegion ? styles.regionRow : ''}`}
      role="row"
      aria-expanded={open}
    >
      <div
        className={styles.cell}
        style={{ gridColumn: `span ${GROUP_LABEL_SPAN}`, padding: 0 }}
        role="gridcell"
      >
        <button
          type="button"
          className={`${styles.groupLabel} ${isRegion ? '' : styles.territoryIndent}`}
          onClick={onToggle}
          aria-label={`${open ? 'Collapse' : 'Expand'} ${label}`}
        >
          <span className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`} aria-hidden="true">
            ▶
          </span>
          <span className={styles.groupName}>{label}</span>
          <span className={styles.groupCount}>
            {count.toLocaleString()} HCP{count === 1 ? '' : 's'}
          </span>
          {filtered ? <span className={styles.groupMatching}>({visible.toLocaleString()} matching)</span> : null}
          {nullCalls > 0 ? (
            <span
              className={`${styles.badge} ${styles.badgeDuplicate}`}
              title={`${nullCalls} row(s) have an unparsable Calls value and are excluded from the sum`}
            >
              ⚠
            </span>
          ) : null}
        </button>
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <IntegerValue value={sumCalls} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <IntegerValue value={sumTrx} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <IntegerValue value={sumNrx} />
      </div>
      <div className={`${styles.cell} ${styles.cellNumeric}`} role="gridcell">
        <CpiValue value={groupCpi(sumCalls, sumTrx)} />
      </div>
    </div>
  );
}

/** Region header. Props are a single branded integer — see the memo note above. */
export const RegionHeaderRow = memo(function RegionHeaderRow({
  region,
}: {
  region: RegionIndex;
}): JSX.Element {
  const store = useHcpStore();
  const label = useStoreSelector((s) => readItem(s.groups.regionKeys, region));
  const count = useStoreSelector((s) => readU32(s.aggregates.region.count, region));
  const sumCalls = useStoreSelector((s) => readF64(s.aggregates.region.sumCalls, region));
  const sumTrx = useStoreSelector((s) => readF64(s.aggregates.region.sumTrx, region));
  const sumNrx = useStoreSelector((s) => readF64(s.aggregates.region.sumNrx, region));
  const nullCalls = useStoreSelector((s) => readU32(s.aggregates.region.nullCalls, region));
  const visible = useStoreSelector((s) => selectRegionVisible(s, region));
  const open = useStoreSelector((s) => isRegionOpen(s.view, selectFilter(s), region));

  return (
    <GroupRowShell
      label={label}
      count={count}
      visible={visible}
      sumCalls={sumCalls}
      sumTrx={sumTrx}
      sumNrx={sumNrx}
      nullCalls={nullCalls}
      open={open}
      isRegion
      onToggle={() => {
        store.getState().toggleRegion(asRegionIndex(region));
      }}
    />
  );
});

/** Territory header. */
export const TerritoryHeaderRow = memo(function TerritoryHeaderRow({
  territory,
}: {
  territory: TerritoryIndex;
}): JSX.Element {
  const store = useHcpStore();
  const label = useStoreSelector((s) => readItem(s.groups.territoryLabels, territory));
  const count = useStoreSelector((s) => readU32(s.aggregates.territory.count, territory));
  const sumCalls = useStoreSelector((s) => readF64(s.aggregates.territory.sumCalls, territory));
  const sumTrx = useStoreSelector((s) => readF64(s.aggregates.territory.sumTrx, territory));
  const sumNrx = useStoreSelector((s) => readF64(s.aggregates.territory.sumNrx, territory));
  const nullCalls = useStoreSelector((s) => readU32(s.aggregates.territory.nullCalls, territory));
  const visible = useStoreSelector((s) => selectTerritoryVisible(s, territory));
  const open = useStoreSelector((s) => isTerritoryOpen(s.view, selectFilter(s), territory));

  return (
    <GroupRowShell
      label={label}
      count={count}
      visible={visible}
      sumCalls={sumCalls}
      sumTrx={sumTrx}
      sumNrx={sumNrx}
      nullCalls={nullCalls}
      open={open}
      isRegion={false}
      onToggle={() => {
        store.getState().toggleTerritory(asTerritoryIndex(territory));
      }}
    />
  );
});
