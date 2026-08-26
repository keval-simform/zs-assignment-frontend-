import { describe, expect, it } from '@jest/globals';
import { DEFAULT_THEME, TENANT_THEMES } from '../../vendor/theme-config';
import { DEFAULT_RESOLVED, resolveTenant, sanitizeTheme, tenantIds } from './sanitizeTheme';

/** FR-8: configs come from customers and cannot be trusted. */

describe('the provided meridian config', () => {
  const { theme, issues } = sanitizeTheme(TENANT_THEMES['meridian']);

  it('produces exactly four issues', () => {
    expect(issues.map((i) => i.field).sort()).toEqual(['onPrimary', 'primary', 'radius', 'text']);
  });

  it('rejects the invalid hex in primary and falls back per field', () => {
    expect(theme.primary).toBe(DEFAULT_THEME.primary);
    const issue = issues.find((i) => i.field === 'primary');
    expect(issue?.received).toBe('"#ZZ8800"');
    expect(issue?.reason).toMatch(/hex/);
  });

  it('rejects the string radius', () => {
    expect(theme.radius).toBe(DEFAULT_THEME.radius);
    expect(issues.find((i) => i.field === 'radius')?.received).toBe('"huge"');
  });

  it('reports the two absent fields', () => {
    expect(theme.onPrimary).toBe(DEFAULT_THEME.onPrimary);
    expect(theme.text).toBe(DEFAULT_THEME.text);
    for (const field of ['onPrimary', 'text'] as const) {
      expect(issues.find((i) => i.field === field)?.received).toBe('(absent)');
    }
  });

  it('PRESERVES the fields it did supply validly', () => {
    // Per-field fallback, not all-or-nothing: one bad colour must not cost the
    // tenant its own name.
    expect(theme.appName).toBe('Meridian 360');
    expect(theme.background).toBe('#FFFFFF');
    expect(theme.surface).toBe('#F4F4F4');
  });
});

describe('the provided aurelia config', () => {
  it('is fully valid and produces no issues', () => {
    const { theme, issues } = sanitizeTheme(TENANT_THEMES['aurelia']);
    expect(issues).toEqual([]);
    expect(theme.appName).toBe('Aurelia Field IQ');
    expect(theme.radius).toBe(8);
  });
});

describe('radius', () => {
  it.each([
    [30, 24],
    [25, 24],
    [-5, 0],
    [-1, 0],
  ])('clamps %i to %i', (input, expected) => {
    const { theme, issues } = sanitizeTheme({ radius: input });
    expect(theme.radius).toBe(expected);
    expect(issues.find((i) => i.field === 'radius')?.reason).toMatch(/clamped/);
  });

  it.each([0, 8, 24])('accepts %i without complaint', (input) => {
    const { theme, issues } = sanitizeTheme({ radius: input });
    expect(theme.radius).toBe(input);
    expect(issues.find((i) => i.field === 'radius')).toBeUndefined();
  });

  it.each([
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ])('rejects %s rather than clamping it', (_label, input) => {
    const { theme } = sanitizeTheme({ radius: input });
    expect(theme.radius).toBe(DEFAULT_THEME.radius);
  });

  it('is a number, so a numeric string is a type error not a parse opportunity', () => {
    // Coercing "8" would mean accepting "8; content: attack" tomorrow.
    const { theme, issues } = sanitizeTheme({ radius: '8' });
    expect(theme.radius).toBe(DEFAULT_THEME.radius);
    expect(issues.find((i) => i.field === 'radius')?.reason).toMatch(/Expected a finite number/);
  });
});

describe('colour allowlist', () => {
  it.each(['#fff', '#FFF', '#0b5fa5', '#0B5FA5'])('accepts %s', (input) => {
    const { theme, issues } = sanitizeTheme({ primary: input });
    expect(theme.primary).toBe(input);
    // The other six fields are absent in this fixture and legitimately report
    // issues; only `primary` is under test here.
    expect(issues.find((i) => i.field === 'primary')).toBeUndefined();
  });

  it.each([
    ['CSS injection via declaration break', 'red; background-image: url(https://evil.example/p)'],
    ['CSS injection with important', 'red !important'],
    ['named colour', 'rebeccapurple'],
    ['rgb function', 'rgb(255,0,0)'],
    ['url function', 'url(https://evil.example/p)'],
    ['expression', 'expression(alert(1))'],
    ['var reference', 'var(--tenant-text)'],
    ['bad hex chars', '#ZZ8800'],
    ['wrong length', '#12345'],
    ['alpha hex', '#0b5fa580'],
    ['leading whitespace', ' #0b5fa5'],
    ['trailing newline', '#0b5fa5\n'],
    ['missing hash', '0b5fa5'],
    ['empty', ''],
  ])('rejects %s', (_label, input) => {
    // SECURITY: an allowlist, not a blocklist. None of these need to be individually
    // anticipated — they fail because they are not six hex digits.
    const { theme } = sanitizeTheme({ primary: input });
    expect(theme.primary).toBe(DEFAULT_THEME.primary);
  });

  it('never lets a rejected value reach the theme', () => {
    const hostile = 'red; background-image: url(https://evil.example/p)';
    const { theme } = sanitizeTheme({ primary: hostile, text: hostile, background: hostile });
    expect(Object.values(theme).join('|')).not.toContain('url(');
    expect(Object.values(theme).join('|')).not.toContain(';');
  });
});

describe('appName', () => {
  it('truncates a 100,000-character name', () => {
    const { theme, issues } = sanitizeTheme({ appName: 'A'.repeat(100_000) });
    expect(theme.appName).toHaveLength(64);
    expect(issues.find((i) => i.field === 'appName')?.reason).toMatch(/truncated/);
  });

  it('trims surrounding whitespace', () => {
    expect(sanitizeTheme({ appName: '  Meridian  ' }).theme.appName).toBe('Meridian');
  });

  it('falls back for a name that is only whitespace', () => {
    const { theme, issues } = sanitizeTheme({ appName: '   ' });
    expect(theme.appName).toBe(DEFAULT_THEME.appName);
    expect(issues.find((i) => i.field === 'appName')?.reason).toMatch(/Empty/);
  });

  it('does not truncate the received preview beyond a readable length', () => {
    const issue = sanitizeTheme({ appName: 'A'.repeat(100_000) }).issues.find((i) => i.field === 'appName');
    expect((issue?.received.length ?? 0)).toBeLessThanOrEqual(61);
  });
});

describe('hostile and malformed input never throws', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a string', 'not a theme'],
    ['a number', 42],
    ['an array', ['#fff']],
    ['a boolean', true],
    ['an empty object', {}],
  ])('handles %s by returning the full default', (_label, input) => {
    const { theme, issues } = sanitizeTheme(input);
    expect(theme).toEqual(DEFAULT_THEME);
    // One issue per field, so the panel explains all seven fallbacks.
    expect(issues).toHaveLength(7);
  });

  it('ignores a prototype-polluting key', () => {
    const { theme } = sanitizeTheme(JSON.parse('{"__proto__":{"primary":"#000000"}}'));
    expect(theme.primary).toBe(DEFAULT_THEME.primary);
  });

  it('ignores unknown extra fields rather than passing them through', () => {
    const { theme } = sanitizeTheme({ primary: '#123456', evil: 'url(x)' });
    expect(theme.primary).toBe('#123456');
    expect(Object.keys(theme).sort()).toEqual([
      'appName',
      'background',
      'onPrimary',
      'primary',
      'radius',
      'surface',
      'text',
    ]);
  });

  it('always returns all seven fields, whatever the input', () => {
    for (const input of [null, {}, { radius: 'huge' }, 'x']) {
      const { theme } = sanitizeTheme(input);
      expect(Object.keys(theme)).toHaveLength(7);
      for (const value of Object.values(theme)) expect(value).not.toBeUndefined();
    }
  });
});

describe('resolveTenant', () => {
  it('resolves a known tenant', () => {
    const resolved = resolveTenant('meridian');
    expect(resolved.tenantId).toBe('meridian');
    expect(resolved.issues).toHaveLength(4);
    expect(resolved.unknownTenantRequested).toBe(false);
  });

  it('falls back for an unknown tenant with no error', () => {
    const resolved = resolveTenant('atlantis');
    expect(resolved.theme).toEqual(DEFAULT_THEME);
    expect(resolved.issues).toEqual([]);
    expect(resolved.unknownTenantRequested).toBe(true);
  });

  it('does NOT retain the requested value for an unknown tenant', () => {
    // See the SECURITY note on resolveTenant: reflected XSS if this leaked.
    const hostile = '"><img src=x onerror=alert(1)>';
    const resolved = resolveTenant(hostile);
    expect(resolved.tenantId).toBeNull();
    expect(JSON.stringify(resolved)).not.toContain('img src');
  });

  it('does not resolve a prototype member as a tenant', () => {
    // `'toString' in TENANT_THEMES` is true; Object.hasOwn is not.
    for (const key of ['toString', 'constructor', '__proto__', 'hasOwnProperty']) {
      expect(resolveTenant(key).unknownTenantRequested).toBe(true);
    }
  });

  it('treats null and the empty string as "use the default"', () => {
    expect(resolveTenant(null)).toEqual(DEFAULT_RESOLVED);
    expect(resolveTenant('')).toEqual(DEFAULT_RESOLVED);
  });

  it('lists the configured tenants in a stable order', () => {
    expect(tenantIds()).toEqual(['aurelia', 'meridian']);
  });
});
