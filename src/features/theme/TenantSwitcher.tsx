import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import { tenantIds } from './sanitizeTheme';
import styles from '../toolbar/Toolbar.module.css';

/** The query parameter FR-8 accepts. */
export const TENANT_PARAM = 'tenant';

/**
 * Read the requested tenant from the URL.
 *
 * Returns the raw string only so `resolveTenant` can *discard* it: the value is
 * never stored and never rendered. See the SECURITY note in `sanitizeTheme`.
 */
export function tenantFromLocation(search: string): string | null {
  const raw = new URLSearchParams(search).get(TENANT_PARAM);
  // `?tenant=` yields '' rather than null; normalise so callers handle one
  // "no tenant" value instead of two that behave identically.
  return raw === null || raw === '' ? null : raw;
}

/**
 * FR-8: "a dropdown or query parameter is fine." Both, kept in sync.
 *
 * DECISION: switching tenants rewrites the URL with `replaceState`, not `pushState`.
 * A theme choice isn't a navigation step — filling the back button with colour
 * changes would make it useless for getting out of the app.
 */
export function TenantSwitcher(): JSX.Element {
  const store = useHcpStore();
  const tenantId = useStoreSelector((s) => s.theme.tenantId);
  const issueCount = useStoreSelector((s) => s.theme.issues.length);

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor="hcp-tenant">
        Tenant
      </label>
      <select
        id="hcp-tenant"
        className={styles.select}
        value={tenantId ?? ''}
        onChange={(e) => {
          const next = e.target.value === '' ? null : e.target.value;
          store.getState().setTenant(next);

          const url = new URL(window.location.href);
          if (next === null) url.searchParams.delete(TENANT_PARAM);
          else url.searchParams.set(TENANT_PARAM, next);
          window.history.replaceState(null, '', url);
        }}
      >
        <option value="">Default</option>
        {tenantIds().map((id) => (
          <option key={id} value={id}>
            {id}
          </option>
        ))}
      </select>
      {issueCount > 0 ? (
        <span className={styles.hint} title="This tenant's config has fields that were rejected">
          {issueCount} config issue{issueCount === 1 ? '' : 's'}
        </span>
      ) : null}
    </div>
  );
}
