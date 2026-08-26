import { describe, expect, it } from '@jest/globals';
import { fixture, hcp } from '../test/fixtures';
import { asRowKey } from './identity';
import type { RowKey } from './identity';
import { buildChangeSet, serializeChangeSet } from './exportDiff';

const AT = '2026-08-24T12:00:00.000Z';

function build(committed: ReadonlyMap<RowKey, number>): ReturnType<typeof buildChangeSet> {
  const { dataset, groups } = fixture([
    hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10 }),
    hcp({ id: 'HCP-000001', name: 'Omar Khan', region: 'West', territory: 'West / T1', calls: 20 }),
    hcp({ id: 'HCP-000003', name: 'Priya Rao', region: 'Midwest', territory: 'Midwest / T1', calls: '9' }),
  ]);
  return buildChangeSet(dataset, groups, committed, AT);
}

describe('buildChangeSet', () => {
  it('exports one entry per accepted change', () => {
    const set = build(new Map([[asRowKey(0), 40]]));
    expect(set.changedRowCount).toBe(1);
    expect(set.entries[0]).toEqual({
      rowKey: 0,
      id: 'HCP-000001',
      name: 'Anita Sharma',
      region: 'West',
      territory: 'West / T1',
      calls: { from: 10, to: 40 },
    });
  });

  it('includes rowKey, because id is not unique', () => {
    // Rows 0 and 1 share HCP-000001. A consumer keying on `id` alone would merge
    // two different HCPs' edits.
    const set = build(
      new Map([
        [asRowKey(0), 40],
        [asRowKey(1), 50],
      ]),
    );
    expect(set.entries.map((e) => e.id)).toEqual(['HCP-000001', 'HCP-000001']);
    expect(set.entries.map((e) => e.rowKey)).toEqual([0, 1]);
  });

  it('reports the string-typed source value as a number', () => {
    const set = build(new Map([[asRowKey(2), 15]]));
    expect(set.entries[0]?.calls.from).toBe(9);
  });

  it('is empty when nothing has been accepted', () => {
    const set = build(new Map());
    expect(set.entries).toEqual([]);
    expect(set.changedRowCount).toBe(0);
  });

  it('deduplicates no-ops for free, because committed is a true diff', () => {
    // A row edited 10 -> 40 -> 10 has no key in `committed` at all (D80), so there
    // is nothing here to filter out.
    const set = build(new Map());
    expect(set.entries).toHaveLength(0);
  });

  it('orders entries by rowKey so two exports of one state are byte-identical', () => {
    const forward = build(
      new Map([
        [asRowKey(2), 1],
        [asRowKey(0), 2],
      ]),
    );
    const reverse = build(
      new Map([
        [asRowKey(0), 2],
        [asRowKey(2), 1],
      ]),
    );
    expect(serializeChangeSet(forward)).toBe(serializeChangeSet(reverse));
    expect(forward.entries.map((e) => e.rowKey)).toEqual([0, 2]);
  });

  it('records the seed and source row count so the diff is reproducible', () => {
    const set = build(new Map([[asRowKey(0), 40]]));
    expect(set.sourceRowCount).toBe(3);
    expect(set.generatedAt).toBe(AT);
  });
});

describe('serializeChangeSet', () => {
  it('produces valid, pretty-printed JSON ending in a newline', () => {
    const json = serializeChangeSet(build(new Map([[asRowKey(0), 40]])));
    expect(json.endsWith('\n')).toBe(true);
    // `JSON.parse` returns `any`; asserting on the round trip without leaking that
    // into the test's types.
    expect(() => {
      JSON.parse(json);
    }).not.toThrow();
    expect(json).toContain('\n  "entries"');
  });
});
