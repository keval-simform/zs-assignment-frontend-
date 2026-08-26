import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { hcp } from '../../test/fixtures';
import { mountGridWithStore, stubViewportHeight } from '../../test/renderGrid';
import { createFakeValidator } from '../../test/fakeValidator';
import { asRegionIndex, asTerritoryIndex } from '../../domain/identity';
import { createHcpStore } from '../../store/store';
import { fixture } from '../../test/fixtures';
import { resolveTenant } from './sanitizeTheme';
import { tenantFromLocation } from './TenantSwitcher';

let restore: () => void;
beforeEach(() => {
  restore = stubViewportHeight();
});
afterEach(() => {
  restore();
  // Written to the real documentElement, so a test that switches tenants would
  // otherwise colour every later test.
  for (const property of [
    '--tenant-primary',
    '--tenant-on-primary',
    '--tenant-background',
    '--tenant-surface',
    '--tenant-text',
    '--tenant-radius',
  ]) {
    document.documentElement.style.removeProperty(property);
  }
});

function mountWithTenant(tenant: string | null): ReturnType<typeof mountGridWithStore> {
  const store = createHcpStore(
    fixture([hcp({ region: 'West', territory: 'West / T1' })]),
    createFakeValidator(),
    resolveTenant(tenant),
  );
  return mountGridWithStore(store);
}

describe('applying a theme at runtime', () => {
  it('writes the tenant colours as CSS custom properties on the root element', () => {
    mountWithTenant('aurelia');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--tenant-primary')).toBe('#0B5FA5');
    expect(style.getPropertyValue('--tenant-surface')).toBe('#EFF5FA');
    expect(style.getPropertyValue('--tenant-radius')).toBe('8px');
  });

  it('writes the FALLBACK value for a field the tenant got wrong', () => {
    // meridian ships primary "#ZZ8800"; must not break or write it into CSS.
    mountWithTenant('meridian');
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--tenant-primary')).toBe('#0B5FA5');
    expect(style.getPropertyValue('--tenant-radius')).toBe('8px');
    expect(style.getPropertyValue('--tenant-primary')).not.toContain('ZZ');
  });

  it('shows the tenant app name and sets the document title', () => {
    mountWithTenant('meridian');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Meridian 360');
    expect(document.title).toBe('Meridian 360');
  });

  it('does NOT let a tenant override the fixed edit-state palette', () => {
    // FR-8: "your edited-cell states must remain clearly distinguishable under every
    // provided theme." The --state-* tokens are not part of the theming surface.
    mountWithTenant('meridian');
    expect(document.documentElement.style.getPropertyValue('--state-pending')).toBe('');
    expect(document.documentElement.style.getPropertyValue('--state-rejected')).toBe('');
  });
});

describe('switching tenants', () => {
  it('re-skins without a rebuild and without unmounting the grid', async () => {
    const user = userEvent.setup();
    mountWithTenant(null);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('HCP Data Explorer');

    await user.selectOptions(screen.getByLabelText('Tenant'), 'aurelia');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Aurelia Field IQ');
    expect(document.documentElement.style.getPropertyValue('--tenant-surface')).toBe('#EFF5FA');
    // Still the same grid: the data was never reloaded.
    expect(screen.getByRole('grid')).toBeInTheDocument();
  });

  it('offers every configured tenant plus the default', () => {
    mountWithTenant(null);
    const options = within(screen.getByLabelText('Tenant')).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Default', 'aurelia', 'meridian']);
  });

  it('returns to the default theme', async () => {
    const user = userEvent.setup();
    mountWithTenant('aurelia');
    await user.selectOptions(screen.getByLabelText('Tenant'), '');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('HCP Data Explorer');
  });
});

describe('the theme issue panel', () => {
  it('lists exactly the four rejected meridian fields', () => {
    mountWithTenant('meridian');
    const panel = screen.getByText(/Theme configuration/).closest('details');
    expect(panel).toBeInstanceOf(HTMLElement);
    if (!(panel instanceof HTMLElement)) return;

    expect(within(panel).getByText(/4 fields rejected/)).toBeInTheDocument();
    const rows = within(panel).getAllByRole('row').slice(1);
    expect(rows.map((r) => r.querySelector('td')?.textContent).sort()).toEqual([
      'onPrimary',
      'primary',
      'radius',
      'text',
    ]);
  });

  it('shows what arrived and why it was refused', () => {
    mountWithTenant('meridian');
    expect(screen.getByText('"#ZZ8800"')).toBeInTheDocument();
    expect(screen.getByText('"huge"')).toBeInTheDocument();
  });

  it('is absent entirely for a fully valid config', () => {
    mountWithTenant('aurelia');
    expect(screen.queryByText(/Theme configuration/)).not.toBeInTheDocument();
  });

  it('explains an unknown tenant without echoing the requested value', () => {
    mountWithTenant('"><img src=x onerror=alert(1)>');
    expect(screen.getByText(/unknown tenant requested/)).toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain('img src=x');
    expect(document.body.innerHTML).not.toContain('onerror');
  });

  it('still renders the app normally on a bad config', () => {
    mountWithTenant('atlantis');
    expect(screen.getByRole('grid')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('HCP Data Explorer');
  });
});

describe('the tenant query parameter', () => {
  it.each([
    ['?tenant=meridian', 'meridian'],
    ['?tenant=aurelia&other=1', 'aurelia'],
    ['?other=1', null],
    ['', null],
    ['?tenant=', null],
  ])('reads %s as %s', (search, expected) => {
    expect(tenantFromLocation(search)).toBe(expected === null ? null : expected);
  });

  it('resolves an unknown parameter to the default with no throw', () => {
    expect(() => resolveTenant(tenantFromLocation('?tenant=nope'))).not.toThrow();
    expect(resolveTenant(tenantFromLocation('?tenant=nope')).tenantId).toBeNull();
  });

  it('boots straight into a tenant from the URL', () => {
    mountWithTenant(tenantFromLocation('?tenant=meridian'));
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Meridian 360');
  });
});

describe('edit-state visibility under a tenant theme', () => {
  it('keeps a pending cell distinguishable by glyph, not only colour', async () => {
    const user = userEvent.setup();
    const { store, validator } = mountWithTenant('meridian');
    act(() => {
      store.getState().toggleRegion(asRegionIndex(0));
      store.getState().toggleTerritory(asTerritoryIndex(0));
    });

    const cell = screen.getByRole('button', { name: /^Calls 10\./ });
    await user.dblClick(cell);
    await user.clear(screen.getByRole('textbox', { name: 'Calls' }));
    await user.type(screen.getByRole('textbox', { name: 'Calls' }), '45{Enter}');

    const pending = await screen.findByRole('button', { name: /validating 45/ });
    // Survives any palette: the glyph and the disabled state are not colours.
    expect(pending).toHaveTextContent('⟳');
    expect(pending).toBeDisabled();
    validator.settleAll('ok');
  });
});
