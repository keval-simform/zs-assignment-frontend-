import type { TenantTheme } from '../../vendor/theme-config';

/**
 * One rejected field from an untrusted tenant config.
 *
 * FR-8: "invalid or missing values must fall back per-field". An issue records
 * what was thrown away and why, so the fallback is *explained* rather than
 * silently applied — see ThemeIssuePanel.
 */
export interface ThemeIssue {
  readonly field: keyof TenantTheme;
  /** The offending value, rendered for display. Never interpolated into CSS. */
  readonly received: string;
  readonly reason: string;
}

/** The outcome of sanitising one tenant config. */
export interface ResolvedTheme {
  /**
   * The *resolved* tenant key, or `null` for the built-in default.
   *
   * SECURITY: only ever a key that exists in `TENANT_THEMES`. An unrecognised
   * request resolves to `null`, and the requested string is discarded — see
   * `resolveTenant`.
   */
  readonly tenantId: string | null;
  readonly theme: TenantTheme;
  readonly issues: readonly ThemeIssue[];
  /**
   * True when a tenant was asked for and not found.
   *
   * A boolean rather than the requested name, deliberately: it lets the UI explain
   * the fallback without retaining an untrusted string.
   */
  readonly unknownTenantRequested: boolean;
}
