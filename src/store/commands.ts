import { applyCallsChange } from '../domain/aggregate';
import type { Aggregates } from '../domain/aggregate';
import type { GroupIndex } from '../domain/grouping';
import type { RowKey } from '../domain/identity';
import { callsAt } from '../domain/normalize';
import type { Dataset } from '../domain/normalize';
import type { Command, EditEntry } from './types';
import { commandEntries } from './types';

/** Which side of an `EditEntry` a write takes its value from. */
export type WriteDirection = 'apply' | 'invert';

export interface WriteResult {
  readonly committed: ReadonlyMap<RowKey, number>;
  readonly aggregates: Aggregates;
}

export interface WriteInputs {
  readonly dataset: Dataset;
  readonly groups: GroupIndex;
  readonly committed: ReadonlyMap<RowKey, number>;
  readonly aggregates: Aggregates;
}

/**
 * FR-4 + FR-6: write a set of entries into `committed` and fold the change into the
 * aggregates.
 *
 * **Apply writes `after`. Invert writes `before`. Same code path, opposite field.**
 * That symmetry is what makes undo tractable and lets FR-5's bulk case reuse this
 * function unchanged: a `bulk-edit` command with thousands of entries inverts
 * through here with no separate "undo a bulk operation" routine to keep in step.
 * A snapshot-based undo would need a 50,000-row copy per operation instead.
 *
 * DECISION: an entry whose target equals the row's *source* value deletes its key
 * from `committed` rather than storing it. Keeps `committed` a true diff against
 * the generated data — the footer's edit count, the JSON change-set export, and
 * the aggregate override pass all depend on that.
 */
export function writeEntries(
  inputs: WriteInputs,
  entries: readonly EditEntry[],
  direction: WriteDirection,
): WriteResult {
  const { dataset, groups } = inputs;
  const committed = new Map(inputs.committed);
  let aggregates = inputs.aggregates;

  for (const entry of entries) {
    const target = direction === 'apply' ? entry.after : entry.before;
    // Read the row's current value from state rather than trusting the entry's
    // opposite field, so an out-of-order write could not silently corrupt the
    // aggregate even if strict LIFO ever stopped holding.
    const current = committed.get(entry.rowKey) ?? callsAt(dataset, entry.rowKey);
    const sourceValue = callsAt(dataset, entry.rowKey);

    if (target === null || target === sourceValue) committed.delete(entry.rowKey);
    else committed.set(entry.rowKey, target);

    aggregates = applyCallsChange(aggregates, groups, entry.rowKey, current, target);
  }

  return { committed, aggregates };
}

/** Apply a whole command — the forward direction. */
export function applyCommand(inputs: WriteInputs, command: Command): WriteResult {
  return writeEntries(inputs, commandEntries(command), 'apply');
}

/** Invert a whole command — the undo direction. */
export function invertCommand(inputs: WriteInputs, command: Command): WriteResult {
  return writeEntries(inputs, commandEntries(command), 'invert');
}

/** A human-readable label for the undo/redo control and the history list. */
export function describeCommand(command: Command): string {
  switch (command.kind) {
    case 'cell-edit':
      return command.label;
    case 'bulk-edit':
      return `${command.label} (${command.entries.length} rows)`;
    default: {
      const unhandled: never = command;
      throw new Error(`Unhandled command kind: ${JSON.stringify(unhandled)}`);
    }
  }
}
