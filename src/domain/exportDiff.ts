import type { GroupIndex } from './grouping';
import { asRowKey } from './identity';
import type { RowKey } from './identity';
import { callsAt, rowAt } from './normalize';
import type { Dataset } from './normalize';
import { readU8, readItem } from './typed';

/** One accepted change, as it appears in the exported diff. */
export interface ChangeSetEntry {
  /** The identity used internally. Included because `id` is not unique (§A1). */
  readonly rowKey: number;
  readonly id: string;
  readonly name: string;
  readonly region: string;
  readonly territory: string;
  readonly calls: { readonly from: number | null; readonly to: number };
}

export interface ChangeSet {
  readonly seed: number;
  readonly sourceRowCount: number;
  readonly changedRowCount: number;
  /** Passed in rather than read from the clock, so the output is testable. */
  readonly generatedAt: string;
  readonly entries: readonly ChangeSetEntry[];
}

/**
 * Bonus: export the accepted change-set as a JSON diff, no-ops deduplicated.
 *
 * The deduplication is not implemented here — it is a *consequence* of `committed`
 * being kept as a true diff against the generated data. A row edited 10 → 40 → 10
 * has no key in `committed` at all, so it cannot appear in this output. There is
 * nothing to filter, which is why this function is thirty lines instead of a
 * reconciliation pass.
 *
 * `rowKey` is exported alongside `id` because `id` is not unique in this dataset —
 * five ids address two rows each. A consumer that keyed on `id` alone would silently
 * merge two different HCPs' edits, which is the same trap the internal identity
 * choice avoids (§B1).
 *
 * DECISION: pending and rejected edits are absent. The export is "what the server
 * has accepted", which is the only version of the truth another system should be
 * handed. Including proposals would make the file a record of intentions rather than
 * of facts.
 */
export function buildChangeSet(
  dataset: Dataset,
  groups: GroupIndex,
  committed: ReadonlyMap<RowKey, number>,
  generatedAt: string,
): ChangeSet {
  const entries: ChangeSetEntry[] = [];

  // Sorted by rowKey so two exports of the same state are byte-identical — a diff of
  // two change-sets should show what changed, not what order a Map iterated in.
  for (const rowKey of [...committed.keys()].sort((a, b) => a - b)) {
    const to = committed.get(rowKey);
    if (to === undefined) continue;
    const key = asRowKey(rowKey);
    const row = rowAt(dataset, key);
    entries.push({
      rowKey,
      id: row.id,
      name: row.name,
      region: readItem(groups.regionKeys, readU8(groups.regionOf, key)),
      territory: readItem(groups.territoryKeys, readU8(groups.territoryOf, key)),
      calls: { from: callsAt(dataset, key), to },
    });
  }

  return {
    seed: dataset.seed,
    sourceRowCount: dataset.count,
    changedRowCount: entries.length,
    generatedAt,
    entries,
  };
}

/** Pretty-printed, because the consumer of a change-set is usually a human first. */
export function serializeChangeSet(changeSet: ChangeSet): string {
  return `${JSON.stringify(changeSet, null, 2)}\n`;
}
