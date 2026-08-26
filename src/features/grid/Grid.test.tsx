import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import type { HcpRecord } from '../../vendor/data-generator';
import { hcp, realData } from '../../test/fixtures';
import { createHcpStore } from '../../store/store';
import { mountGrid, mountGridWithStore, renderedRows, scrollTo, stubViewportHeight } from '../../test/renderGrid';
import { asRegionIndex, asTerritoryIndex } from '../../domain/identity';

let restore: () => void;
beforeEach(() => {
  restore = stubViewportHeight();
});
afterEach(() => {
  restore();
});

/** Six regions x one territory x `perTerritory` rows, so group counts are exact. */
function sixRegionFixture(perTerritory: number): HcpRecord[] {
  const regions = ['Midwest', 'National', 'Northeast', 'Southeast', 'Southwest', 'West'];
  const rows: HcpRecord[] = [];
  regions.forEach((region, r) => {
    for (let i = 0; i < perTerritory; i++) {
      rows.push(
        hcp({
          id: `HCP-${String(r * 1000 + i).padStart(6, '0')}`,
          name: `Rep ${String(r)}-${String(i)}`,
          region,
          territory: `${region} / T1`,
          calls: 10 + i,
          trx: 100,
          nrx: 50,
        }),
      );
    }
  });
  return rows;
}

// ---------------------------------------------------------------------------

describe('grouping (FR-2)', () => {
  it('renders one row per region with everything collapsed', () => {
    const { container } = mountGrid(sixRegionFixture(3));
    expect(renderedRows(container)).toHaveLength(6);
    expect(screen.getByRole('button', { name: /Expand Midwest/ })).toBeInTheDocument();
  });

  it('shows territory headers when a region is expanded', () => {
    const { container, store } = mountGrid(sixRegionFixture(3));
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
    });
    // 6 regions + Midwest's single territory
    expect(renderedRows(container)).toHaveLength(7);
    expect(screen.getByRole('button', { name: /Expand T1/ })).toBeInTheDocument();
  });

  it('shows data rows when a territory is expanded', () => {
    const { container, store } = mountGrid(sixRegionFixture(3));
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
      store.getState().toggleTerritory(asTerritoryIndex(0));
    });
    expect(renderedRows(container)).toHaveLength(6 + 1 + 3);
  });

  it('expands and collapses from the chevron button', async () => {
    const user = userEvent.setup();
    const { container } = mountGrid(sixRegionFixture(2));
    await user.click(screen.getByRole('button', { name: /Expand Midwest/ }));
    expect(renderedRows(container)).toHaveLength(7);
    await user.click(screen.getByRole('button', { name: /Collapse Midwest/ }));
    expect(renderedRows(container)).toHaveLength(6);
  });

  it('shows aggregates on a COLLAPSED group', () => {
    // The subtotal is the reason to collapse a group in the first place.
    mountGrid(sixRegionFixture(3));
    const midwest = screen.getByRole('button', { name: /Expand Midwest/ }).closest('[role="row"]');
    expect(midwest).not.toBeNull();
    if (midwest === null) return;
    const cells = within(midwest as HTMLElement).getAllByRole('gridcell');
    // label | Σcalls | Σtrx | Σnrx | CPI      calls 10+11+12 = 33, trx 300
    expect(cells[1]).toHaveTextContent('33');
    expect(cells[2]).toHaveTextContent('300');
    expect(cells[3]).toHaveTextContent('150');
    expect(cells[4]).toHaveTextContent('11.0');
  });

  it('shows the HCP count on the group label', () => {
    mountGrid(sixRegionFixture(3));
    expect(screen.getByRole('button', { name: /Expand Midwest/ })).toHaveTextContent('3 HCPs');
  });
});

// ---------------------------------------------------------------------------

describe('virtualization (FR-1)', () => {
  it('keeps the DOM row count flat while scrolling 50,000 rows', async () => {
    const store = createHcpStore(realData());
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const { container } = mountGridWithStore(store);

    const viewport = container.querySelector('[role="grid"]');
    expect(viewport).toBeInstanceOf(HTMLElement);
    if (!(viewport instanceof HTMLElement)) return;

    await waitFor(() => {
      expect(renderedRows(container).length).toBeGreaterThan(10);
    });
    const atRest = renderedRows(container).length;

    for (const top of [0, 5_000, 12_000, 25_000, 31_000]) {
      await act(async () => {
        scrollTo(viewport, top);
        await new Promise((resolve) => {
          requestAnimationFrame(() => {
            resolve(null);
          });
        });
      });
      // The whole point of FR-1: 1,000+ rows in the list, ~32 in the document.
      // The ceiling is viewport rows + overscan on both sides; at scrollTop 0 the
      // leading overscan is clamped away, so the window is smaller at rest than
      // mid-list and "never grows from atRest" would be the wrong assertion.
      expect(renderedRows(container).length).toBeLessThanOrEqual(20 + 2 * 6);
    }
    expect(atRest).toBeLessThanOrEqual(20 + 2 * 6);
  });

  it('never puts all 50,000 rows in the DOM', async () => {
    const store = createHcpStore(realData());
    store.getState().toggleRegion(asRegionIndex(0));
    store.getState().toggleTerritory(asTerritoryIndex(0));
    const { container } = mountGridWithStore(store);
    await waitFor(() => {
      expect(renderedRows(container).length).toBeGreaterThan(10);
    });
    expect(renderedRows(container).length).toBeLessThan(100);
  });

  it('reports rows in DOM in the footer, headers and overscan included', async () => {
    const { container } = mountGrid(sixRegionFixture(2));
    await waitFor(() => {
      expect(screen.getByTitle(/Row elements React actually rendered/)).toBeInTheDocument();
    });
    const stat = screen.getByTitle(/Row elements React actually rendered/);
    expect(stat).toHaveTextContent(String(renderedRows(container).length));
  });
});

// ---------------------------------------------------------------------------

describe('seeded defects are rendered, not hidden', () => {
  function firstDataRow(container: HTMLElement): HTMLElement {
    const rows = renderedRows(container).filter(
      (row) => row.querySelector('[aria-expanded]') === null && !row.hasAttribute('aria-expanded'),
    );
    const row = rows.at(-1);
    if (row === undefined) throw new Error('no data row rendered');
    return row;
  }

  function mountOneRow(overrides: Partial<HcpRecord>): HTMLElement {
    const { container, store } = mountGrid([hcp(overrides)]);
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
      store.getState().toggleTerritory(asTerritoryIndex(0));
    });
    return firstDataRow(container);
  }

  it('renders an em dash for a null specialty, never the string "null"', () => {
    const row = mountOneRow({ specialty: null });
    const cells = within(row).getAllByRole('gridcell');
    expect(cells[2]).toHaveTextContent('—');
    expect(row.textContent).not.toContain('null');
  });

  it('renders an em dash for CPI when trx is 0, never Infinity or NaN', () => {
    const row = mountOneRow({ calls: 25, trx: 0 });
    const cells = within(row).getAllByRole('gridcell');
    expect(cells[6]).toHaveTextContent('—');
    expect(row.textContent).not.toMatch(/Infinity|NaN/);
  });

  it('flags a duplicate ID with a warning badge', () => {
    const { container, store } = mountGrid([
      hcp({ id: 'HCP-000001', name: 'A' }),
      hcp({ id: 'HCP-000001', name: 'B' }),
    ]);
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
      store.getState().toggleTerritory(asTerritoryIndex(0));
    });
    expect(within(container).getAllByLabelText('duplicate identifier')).toHaveLength(2);
  });

  it('marks the 99999 outlier without clamping its value', () => {
    const row = mountOneRow({ calls: 99_999 });
    const cells = within(row).getAllByRole('gridcell');
    expect(cells[3]).toHaveTextContent('99,999');
    // Announced, not merely coloured: a flag a sighted user can see and a
    // screen-reader user cannot is the gap WCAG 1.4.1 exists to close.
    expect(within(row).getByRole('button', { name: /Outlier value/ })).toBeInTheDocument();
  });

  it('renders a string-typed calls value as a number', () => {
    const row = mountOneRow({ calls: '9' });
    const cells = within(row).getAllByRole('gridcell');
    expect(cells[3]).toHaveTextContent('9');
  });

  it('renders an em dash for unparsable calls rather than NaN', () => {
    const row = mountOneRow({ calls: 'garbage' });
    const cells = within(row).getAllByRole('gridcell');
    expect(cells[3]).toHaveTextContent('—');
    expect(row.textContent).not.toContain('NaN');
  });
});

// ---------------------------------------------------------------------------

describe('sorting (FR-3)', () => {
  it('cycles aria-sort through ascending, descending, none', async () => {
    const user = userEvent.setup();
    mountGrid(sixRegionFixture(2));
    const header = screen.getByRole('columnheader', { name: /Calls/ });
    expect(header).toHaveAttribute('aria-sort', 'none');
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'ascending');
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'descending');
    await user.click(header);
    expect(header).toHaveAttribute('aria-sort', 'none');
  });

  it('exposes every column as a sortable header', () => {
    mountGrid(sixRegionFixture(1));
    expect(screen.getAllByRole('columnheader')).toHaveLength(7);
  });

  it('reorders GROUPS when a numeric column is sorted', async () => {
    // FR-3: Midwest Σcalls 10, National 30, Northeast 50 — ascending puts Midwest
    // first, descending puts Northeast first.
    const user = userEvent.setup();
    const rows: HcpRecord[] = [
      hcp({ id: 'HCP-000001', region: 'Midwest', territory: 'Midwest / T1', calls: 10 }),
      hcp({ id: 'HCP-000002', region: 'National', territory: 'National / T1', calls: 30 }),
      hcp({ id: 'HCP-000003', region: 'Northeast', territory: 'Northeast / T1', calls: 50 }),
    ];
    const { container } = mountGrid(rows);

    // Read the toggle's aria-label ("Expand Midwest") rather than slicing
    // textContent, which also carries the chevron glyph and the HCP count.
    const labels = (): string[] =>
      renderedRows(container).map(
        (row) => row.querySelector('button')?.getAttribute('aria-label')?.replace(/^(Expand|Collapse) /, '') ?? '',
      );
    expect(labels()).toEqual(['Midwest', 'National', 'Northeast']);

    await user.click(screen.getByRole('columnheader', { name: /Calls/ }));
    expect(labels()).toEqual(['Midwest', 'National', 'Northeast']);

    await user.click(screen.getByRole('columnheader', { name: /Calls/ }));
    expect(labels()).toEqual(['Northeast', 'National', 'Midwest']);
  });

  it('does NOT reorder groups for a text column', async () => {
    const user = userEvent.setup();
    const rows: HcpRecord[] = [
      hcp({ id: 'HCP-000001', name: 'Zoe', region: 'Midwest', territory: 'Midwest / T1' }),
      hcp({ id: 'HCP-000002', name: 'Adam', region: 'West', territory: 'West / T1' }),
    ];
    const { container } = mountGrid(rows);
    await user.click(screen.getByRole('columnheader', { name: /Name/ }));
    const labels = renderedRows(container).map(
      (row) => row.querySelector('button')?.getAttribute('aria-label')?.replace(/^(Expand|Collapse) /, '') ?? '',
    );
    expect(labels).toEqual(['Midwest', 'West']);
  });

  it('sorts rows within a territory', async () => {
    const user = userEvent.setup();
    const rows: HcpRecord[] = [
      hcp({ id: 'HCP-000001', region: 'West', territory: 'West / T1', calls: 30 }),
      hcp({ id: 'HCP-000002', region: 'West', territory: 'West / T1', calls: 10 }),
      hcp({ id: 'HCP-000003', region: 'West', territory: 'West / T1', calls: 20 }),
    ];
    const { container, store } = mountGrid(rows);
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
      store.getState().toggleTerritory(asTerritoryIndex(0));
    });
    await user.click(screen.getByRole('columnheader', { name: /Calls/ }));

    const ids = renderedRows(container)
      .filter((row) => row.textContent?.includes('HCP-') === true)
      .map((row) => row.textContent?.slice(0, 10) ?? '');
    expect(ids).toEqual(['HCP-000002', 'HCP-000003', 'HCP-000001']);
  });
});

// ---------------------------------------------------------------------------

describe('search and filter (FR-3)', () => {
  it('filters and auto-expands the groups containing matches', async () => {
    const user = userEvent.setup();
    const { container } = mountGrid(sixRegionFixture(3));
    await user.type(screen.getByLabelText('Search'), 'Rep 0-1');
    await waitFor(() => {
      expect(container.textContent).toContain('HCP-000001');
    });
    // One region, its territory, and the single matching row — no manual expansion.
    expect(renderedRows(container)).toHaveLength(3);
  });

  it('searches by ID as well as name', async () => {
    const user = userEvent.setup();
    const { container } = mountGrid(sixRegionFixture(3));
    await user.type(screen.getByLabelText('Search'), 'hcp-002001');
    await waitFor(() => {
      expect(container.textContent).toContain('HCP-002001');
    });
    expect(renderedRows(container)).toHaveLength(3);
  });

  it('shows "(N matching)" beside the group total when a filter narrows it', async () => {
    const user = userEvent.setup();
    mountGrid(sixRegionFixture(3));
    await user.type(screen.getByLabelText('Search'), 'Rep 0-1');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Collapse Midwest/ })).toHaveTextContent('(1 matching)');
    });
    // DECISION D40: the subtotal itself still describes the whole group.
    expect(screen.getByRole('button', { name: /Collapse Midwest/ })).toHaveTextContent('3 HCPs');
  });

  it('filters by region without auto-expanding it', async () => {
    // DECISION: only a *search* auto-expands. Opening a whole region because the
    // user narrowed to it would dump ~8,000 rows they did not ask for.
    const user = userEvent.setup();
    const { container } = mountGrid(sixRegionFixture(2));
    await user.selectOptions(screen.getByLabelText('Region'), 'West');
    await waitFor(() => {
      expect(renderedRows(container)).toHaveLength(1);
    });
    expect(screen.getByRole('button', { name: /Expand West/ })).toBeInTheDocument();
  });

  it('shows an empty state rather than a blank grid when nothing matches', async () => {
    const user = userEvent.setup();
    mountGrid(sixRegionFixture(2));
    await user.type(screen.getByLabelText('Search'), 'zzzz-nothing');
    await waitFor(() => {
      expect(screen.getByText(/No HCPs match/)).toBeInTheDocument();
    });
  });

  it('resets search, filter and sort together', async () => {
    const user = userEvent.setup();
    const { container, store } = mountGrid(sixRegionFixture(2));
    await user.type(screen.getByLabelText('Search'), 'Rep 0');
    await user.click(screen.getByRole('columnheader', { name: /Calls/ }));
    await waitFor(() => {
      expect(store.getState().view.search).toBe('Rep 0');
    });

    await user.click(screen.getByRole('button', { name: 'Reset view' }));
    await waitFor(() => {
      expect(renderedRows(container)).toHaveLength(6);
    });
    expect(store.getState().view.sort).toBeNull();
    expect(store.getState().view.regionFilter).toBeNull();
  });
});

// ---------------------------------------------------------------------------

describe('accessibility', () => {
  it('marks the scroll container as a grid with a row count', () => {
    const { container } = mountGrid(sixRegionFixture(2));
    const grid = container.querySelector('[role="grid"]');
    expect(grid).toHaveAttribute('aria-rowcount', '6');
  });

  it('announces expansion state on group rows', () => {
    const { container } = mountGrid(sixRegionFixture(2));
    const rows = renderedRows(container);
    expect(rows[0]).toHaveAttribute('aria-expanded', 'false');
  });
});
