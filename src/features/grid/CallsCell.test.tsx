import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { hcp } from '../../test/fixtures';
import { CAP_REJECTION, TRANSIENT_REJECTION } from '../../test/fakeValidator';
import { mountGrid, stubViewportHeight } from '../../test/renderGrid';
import { asRegionIndex, asRowKey, asTerritoryIndex } from '../../domain/identity';
import type { MountedGrid } from '../../test/renderGrid';

let restore: () => void;
beforeEach(() => {
  restore = stubViewportHeight();
});
afterEach(() => {
  restore();
});

/** One expanded territory holding two rows, calls 10 and 20. */
function mountTwoRows(): MountedGrid {
  const mounted = mountGrid([
    hcp({ id: 'HCP-000001', name: 'Anita Sharma', region: 'West', territory: 'West / T1', calls: 10 }),
    hcp({ id: 'HCP-000002', name: 'Omar Khan', region: 'West', territory: 'West / T1', calls: 20 }),
  ]);
  act(() => {
    mounted.store.getState().toggleRegion(asRegionIndex(0));
    mounted.store.getState().toggleTerritory(asTerritoryIndex(0));
  });
  return mounted;
}

function callsButton(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

// ---------------------------------------------------------------------------

describe('keyboard and pointer entry', () => {
  it('opens the editor on Enter', async () => {
    const user = userEvent.setup();
    mountTwoRows();
    const cell = callsButton(/^Calls 10\./);
    cell.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'Calls' })).toHaveValue('10');
  });

  it('opens the editor on double-click', async () => {
    const user = userEvent.setup();
    mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    expect(screen.getByRole('textbox', { name: 'Calls' })).toBeInTheDocument();
  });

  it('commits on Enter', async () => {
    const user = userEvent.setup();
    const { store, validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');

    expect(validator.calls).toEqual([{ id: 1, value: 45 }]);
    await act(async () => {
      validator.settle(1, 'ok');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(store.getState().committed.get(asRowKey(0))).toBe(45);
    });
  });

  it('cancels on Escape without calling the validator', async () => {
    const user = userEvent.setup();
    const { validator, store } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '99{Escape}');

    expect(validator.calls).toHaveLength(0);
    expect(store.getState().view.editing).toBeNull();
    expect(screen.queryByRole('textbox', { name: 'Calls' })).not.toBeInTheDocument();
  });

  it('shows an inline error for an unparsable draft and makes no request', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '4.5{Enter}');

    expect(await screen.findByRole('alert')).toHaveTextContent(/Whole numbers only/);
    expect(validator.calls).toHaveLength(0);
    expect(screen.getByRole('textbox', { name: 'Calls' })).toHaveAttribute('aria-invalid', 'true');
  });
});

// ---------------------------------------------------------------------------

describe('the four visible states', () => {
  it('pending: spinner glyph, locked control, and the proposal shown beside the value', async () => {
    const user = userEvent.setup();
    mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');

    const pending = await screen.findByRole('button', { name: /validating 45/ });
    // FR-4: pending cells are locked against further edits.
    expect(pending).toBeDisabled();
    // The committed value is still what is displayed — the proposal sits beside it,
    // never in place of it, so the cell can never disagree with its subtotal.
    expect(pending).toHaveTextContent('10');
    expect(pending).toHaveTextContent('→45');
    // Non-chromatic signal, so the state survives any tenant palette.
    expect(pending).toHaveTextContent('⟳');
  });

  it('saved: a check glyph and the new value', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');
    await act(async () => {
      validator.settle(1, 'ok');
      await Promise.resolve();
    });

    const saved = await screen.findByRole('button', { name: /Calls 45, saved/ });
    expect(saved).toHaveTextContent('✓');
    expect(saved).not.toBeDisabled();
  });

  it('rejected: a warning glyph, the original value, and the reason', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '75{Enter}');
    await act(async () => {
      validator.settle(1, { reject: CAP_REJECTION });
      await Promise.resolve();
    });

    const rejected = await screen.findByRole('button', { name: /75 was rejected/ });
    // Reverted: the displayed value is the committed one, untouched.
    expect(rejected).toHaveTextContent('10');
    expect(rejected).toHaveTextContent('⚠');
    expect(rejected).toHaveAttribute('title', expect.stringContaining('call cap'));
    expect(rejected).toHaveAttribute('title', expect.stringContaining('will fail again'));
  });

  it('idle: no marker at all', () => {
    mountTwoRows();
    const idle = callsButton(/^Calls 20\./);
    expect(idle.textContent).toBe('20');
  });
});

// ---------------------------------------------------------------------------

describe('rejections surface in two places', () => {
  it('announces the rejection in a polite live region as well as on the cell', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '75{Enter}');
    await act(async () => {
      validator.settle(1, { reject: CAP_REJECTION });
      await Promise.resolve();
    });

    const log = screen.getByRole('log', { name: 'Edit results' });
    expect(log).toHaveAttribute('aria-live', 'polite');
    expect(within(log).getByText(/Anita Sharma/)).toBeInTheDocument();
    expect(within(log).getByText(/call cap/)).toBeInTheDocument();
  });

  it('offers Retry for a 503 and resends the same value', async () => {
    const user = userEvent.setup();
    const { validator, store } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');
    await act(async () => {
      validator.settle(1, { reject: TRANSIENT_REJECTION });
      await Promise.resolve();
    });

    await user.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(validator.calls).toEqual([
      { id: 1, value: 45 },
      { id: 2, value: 45 },
    ]);
    await act(async () => {
      validator.settle(2, 'ok');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(store.getState().committed.get(asRowKey(0))).toBe(45);
    });
  });

  it('offers no Retry for a cap violation, and says why', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '75{Enter}');
    await act(async () => {
      validator.settle(1, { reject: CAP_REJECTION });
      await Promise.resolve();
    });

    const log = screen.getByRole('log', { name: 'Edit results' });
    expect(within(log).queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(within(log).getByText(/will be rejected again/)).toBeInTheDocument();
  });

  it('dismisses a toast without affecting the cell', async () => {
    const user = userEvent.setup();
    const { validator, store } = mountTwoRows();
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '75{Enter}');
    await act(async () => {
      validator.settle(1, { reject: CAP_REJECTION });
      await Promise.resolve();
    });

    await user.click(await screen.findByRole('button', { name: /^Dismiss:/ }));
    expect(store.getState().toasts).toHaveLength(0);
    expect(screen.getByRole('button', { name: /75 was rejected/ })).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------

describe('aggregates and the footer during a pending edit', () => {
  it('leaves the group subtotal unchanged while pending, then moves it on accept', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    const territoryHeader = (): HTMLElement => screen.getByRole('button', { name: /Collapse T1/ });
    const subtotal = (): string => {
      const row = territoryHeader().closest('[role="row"]');
      if (!(row instanceof HTMLElement)) throw new Error('no territory row');
      return within(row).getAllByRole('gridcell')[1]?.textContent ?? '';
    };

    expect(subtotal()).toBe('30');

    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');

    await screen.findByRole('button', { name: /validating 45/ });
    // The whole FR-2/FR-4 intersection, visible on screen.
    expect(subtotal()).toBe('30');
    expect(screen.getByTitle(/Edits awaiting validation/)).toHaveTextContent('1');

    await act(async () => {
      validator.settle(1, 'ok');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(subtotal()).toBe('65');
    });
    expect(screen.getByTitle(/Edits awaiting validation/)).toHaveTextContent('0');
  });

  it('keeps the CPI column still while pending', async () => {
    const user = userEvent.setup();
    const { validator } = mountTwoRows();
    // Locate the row by its ID cell, which is the one thing about it that does not
    // change as the Calls cell moves through the lifecycle.
    const dataRow = (): HTMLElement => {
      const row = screen.getByText('HCP-000001').closest('[role="row"]');
      if (!(row instanceof HTMLElement)) throw new Error('no data row');
      return row;
    };
    const cpi = (): string => within(dataRow()).getAllByRole('gridcell')[6]?.textContent ?? '';

    expect(cpi()).toBe('10.0');
    await user.dblClick(callsButton(/^Calls 10\./));
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');
    await screen.findByRole('button', { name: /validating 45/ });
    expect(cpi()).toBe('10.0');

    await act(async () => {
      validator.settle(1, 'ok');
      await Promise.resolve();
    });
    await waitFor(() => {
      expect(cpi()).toBe('45.0');
    });
  });
});
