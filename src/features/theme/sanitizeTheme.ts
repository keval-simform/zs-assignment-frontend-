import { DEFAULT_THEME, TENANT_THEMES } from '../../vendor/theme-config';
import type { TenantTheme } from '../../vendor/theme-config';
import type { ResolvedTheme, ThemeIssue } from './types';

/**
 * FR-8: tenant configs come from customers and cannot be trusted.
 *
 * SECURITY: this is an **allowlist, never a blocklist**. Every field is checked
 * against exactly what is permitted; anything else is discarded. These values become
 * CSS custom properties, and an unvalidated string there is a real injection vector:
 *
 *     red; background-image: url(https://attacker.example/pixel)
 *
 * terminates the `--tenant-primary:` declaration and injects a second one, letting a
 * hostile config exfiltrate data, cover the page, or spoof a control's label via
 * `content`. A blocklist can't cover CSS's equivalent encodings (`\75 rl`, `URL(`,
 * comment splitting); a six-hex-digit pattern has no such escape hatches.
 *
 * `setProperty` alone is not a mitigation — it rejects a `;` but accepts `red
 * !important` and various function forms. The allowlist is the control that holds.
 */

/**
 * Three- and six-digit hex only.
 *
 * DECISION: four- and eight-digit alpha forms are valid CSS but rejected anyway. A
 * semi-transparent `text` or `background` can silently destroy contrast, and the
 * *resulting* contrast can't be validated at config time since it depends on
 * whatever ends up behind it. Keeping colours opaque keeps contrast computable from
 * the config alone.
 */
const HEX_COLOUR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Radius bounds, from the vendor file's own comment: "px, 0-24". */
const RADIUS_MIN = 0;
const RADIUS_MAX = 24;

/**
 * Longest accepted app name.
 *
 * A name is a toolbar label, not a document — an unbounded string is a layout
 * attack even when it's otherwise valid.
 */
const APP_NAME_MAX = 64;

/** How much of a rejected value to show in the issues panel. */
const RECEIVED_PREVIEW_MAX = 60;

/**
 * Render a rejected value for display.
 *
 * Truncated since the offending value may be enormous, and `JSON.stringify`d so a
 * value that *looks* like a valid colour but carries trailing whitespace or a
 * newline is visibly different. Rendered as React text content, never CSS.
 */
function preview(value: unknown): string {
  // Exhaustive by type rather than `String(value)`: stringifying an object yields
  // "[object Object]", which tells the reader nothing about what they shipped.
  let text: string;
  if (typeof value === 'string') text = JSON.stringify(value);
  else if (value === undefined) text = '(absent)';
  else if (value === null) text = 'null';
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    text = String(value);
  } else if (typeof value === 'symbol') text = value.toString();
  else if (typeof value === 'function') text = '(a function)';
  else if (Array.isArray(value)) text = `(an array of ${String(value.length)})`;
  else text = '(an object)';
  return text.length > RECEIVED_PREVIEW_MAX ? `${text.slice(0, RECEIVED_PREVIEW_MAX)}…` : text;
}

interface FieldOutcome<T> {
  readonly value: T;
  readonly issue: ThemeIssue | null;
}

function colourField(field: keyof TenantTheme, raw: unknown, fallback: string): FieldOutcome<string> {
  if (raw === undefined || raw === null) {
    return { value: fallback, issue: { field, received: preview(raw), reason: 'Missing; using the default.' } };
  }
  if (typeof raw !== 'string') {
    return {
      value: fallback,
      issue: { field, received: preview(raw), reason: `Expected a hex colour string, got ${typeof raw}.` },
    };
  }
  if (!HEX_COLOUR.test(raw)) {
    return {
      value: fallback,
      issue: {
        field,
        received: preview(raw),
        reason: 'Not a 3- or 6-digit hex colour. Rejected rather than sanitised — see sanitizeTheme.',
      },
    };
  }
  return { value: raw, issue: null };
}

function radiusField(raw: unknown, fallback: number): FieldOutcome<number> {
  if (raw === undefined || raw === null) {
    return { value: fallback, issue: { field: 'radius', received: preview(raw), reason: 'Missing; using the default.' } };
  }
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    return {
      value: fallback,
      issue: {
        field: 'radius',
        received: preview(raw),
        reason: `Expected a finite number of pixels, got ${typeof raw === 'number' ? 'NaN or Infinity' : typeof raw}.`,
      },
    };
  }
  if (raw < RADIUS_MIN || raw > RADIUS_MAX) {
    const clamped = Math.min(RADIUS_MAX, Math.max(RADIUS_MIN, raw));
    // Clamped rather than rejected: the tenant's intent ("very round") is legible
    // within range, unlike an invalid colour where intent is unknowable.
    return {
      value: clamped,
      issue: {
        field: 'radius',
        received: preview(raw),
        reason: `Outside the supported ${String(RADIUS_MIN)}–${String(RADIUS_MAX)}px range; clamped to ${String(clamped)}px.`,
      },
    };
  }
  return { value: raw, issue: null };
}

function appNameField(raw: unknown, fallback: string): FieldOutcome<string> {
  if (raw === undefined || raw === null) {
    return { value: fallback, issue: { field: 'appName', received: preview(raw), reason: 'Missing; using the default.' } };
  }
  if (typeof raw !== 'string') {
    return {
      value: fallback,
      issue: { field: 'appName', received: preview(raw), reason: `Expected a string, got ${typeof raw}.` },
    };
  }
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      value: fallback,
      issue: { field: 'appName', received: preview(raw), reason: 'Empty after trimming; using the default.' },
    };
  }
  if (trimmed.length > APP_NAME_MAX) {
    return {
      value: trimmed.slice(0, APP_NAME_MAX),
      issue: {
        field: 'appName',
        received: preview(raw),
        reason: `Longer than ${String(APP_NAME_MAX)} characters; truncated. An unbounded name is a layout attack.`,
      },
    };
  }
  return { value: trimmed, issue: null };
}

export interface SanitizedTheme {
  readonly theme: TenantTheme;
  readonly issues: readonly ThemeIssue[];
}

/**
 * Validate an untrusted theme config field by field, falling back per field.
 *
 * Never throws. `null`, `undefined`, a string, a number, an array — anything that is
 * not a usable object yields the full default plus one issue per missing field, which
 * is the same code path as a partially-valid config rather than a special case.
 *
 * @param raw whatever the tenant supplied.
 * @returns a complete, safe `TenantTheme` and one issue per field that was replaced.
 */
export function sanitizeTheme(raw: unknown): SanitizedTheme {
  // Not an error to branch on — treated as an object with no usable fields, so
  // every field falls back through the normal path.
  const source: Record<string, unknown> =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? { ...raw } : {};

  const outcomes = [
    appNameField(source['appName'], DEFAULT_THEME.appName),
    colourField('primary', source['primary'], DEFAULT_THEME.primary),
    colourField('onPrimary', source['onPrimary'], DEFAULT_THEME.onPrimary),
    colourField('background', source['background'], DEFAULT_THEME.background),
    colourField('surface', source['surface'], DEFAULT_THEME.surface),
    colourField('text', source['text'], DEFAULT_THEME.text),
    radiusField(source['radius'], DEFAULT_THEME.radius),
  ] as const;

  const issues = outcomes.map((o) => o.issue).filter((i): i is ThemeIssue => i !== null);

  return {
    theme: {
      appName: outcomes[0].value,
      primary: outcomes[1].value,
      onPrimary: outcomes[2].value,
      background: outcomes[3].value,
      surface: outcomes[4].value,
      text: outcomes[5].value,
      radius: outcomes[6].value,
    },
    issues,
  };
}

/** Tenant keys the app offers, in a stable order. */
export function tenantIds(): readonly string[] {
  return Object.keys(TENANT_THEMES).sort();
}

/** The built-in default, with nothing to report. */
export const DEFAULT_RESOLVED: ResolvedTheme = {
  tenantId: null,
  theme: DEFAULT_THEME,
  issues: [],
  unknownTenantRequested: false,
};

/**
 * Resolve a requested tenant id to a usable theme.
 *
 * FR-8: an unknown tenant falls back to `DEFAULT_THEME` with no error and — the
 * security-relevant part — **the requested value is never retained**. Echoing an
 * unvalidated query parameter into the DOM is reflected XSS; React would escape it,
 * but the value has no business existing past this function. The panel reports only
 * *that* an unknown tenant was requested.
 */
export function resolveTenant(requested: string | null): ResolvedTheme {
  if (requested === null || requested === '') return DEFAULT_RESOLVED;

  // `Object.hasOwn`, not `in`: `TENANT_THEMES` is a plain record, and `'toString' in
  // TENANT_THEMES` is true. A tenant id of "constructor" must not resolve to a
  // prototype member.
  const config = Object.hasOwn(TENANT_THEMES, requested) ? TENANT_THEMES[requested] : undefined;
  if (config === undefined) {
    return {
      tenantId: null,
      theme: DEFAULT_THEME,
      issues: [],
      unknownTenantRequested: true,
    };
  }

  const { theme, issues } = sanitizeTheme(config);
  return { tenantId: requested, theme, issues, unknownTenantRequested: false };
}
