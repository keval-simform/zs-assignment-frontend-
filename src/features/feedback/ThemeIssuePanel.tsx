import { useStoreSelector } from '../../store/StoreContext';
import styles from './ThemeIssuePanel.module.css';

/**
 * FR-8: "error surfaces that explain rather than swallow", applied to configuration.
 *
 * DECISION: rejected config fields are reported, not silently defaulted. A tenant who
 * ships `#ZZ8800` and sees the default blue has no way to tell whether their config
 * was ignored, mis-parsed, or never loaded — and the person who can fix it isn't the
 * person looking at this screen. Naming the field, what arrived, and why it was
 * refused turns a support ticket into a one-line fix.
 *
 * DECISION: a collapsed `<details>` rather than a banner or toast. The app still
 * works — every field fell back — so this is diagnostic, not an interruption.
 * `<details>` also gives keyboard operability and expand/collapse semantics for free.
 *
 * Values are rendered as React text content, never interpolated into CSS — which is
 * why they were rejected in the first place.
 */
export function ThemeIssuePanel(): JSX.Element | null {
  const issues = useStoreSelector((s) => s.theme.issues);
  const unknownTenant = useStoreSelector((s) => s.theme.unknownTenantRequested);
  const tenantId = useStoreSelector((s) => s.theme.tenantId);

  if (issues.length === 0 && !unknownTenant) return null;

  return (
    <details className={styles.panel}>
      <summary className={styles.summary}>
        <span className={styles.chevron} aria-hidden="true">
          ▶
        </span>
        <span>Theme configuration</span>
        {issues.length > 0 ? (
          <span className={styles.count}>
            {issues.length} field{issues.length === 1 ? '' : 's'} rejected
            {tenantId === null ? '' : ` in "${tenantId}"`}
          </span>
        ) : null}
        {unknownTenant ? <span className={styles.count}>unknown tenant requested</span> : null}
      </summary>

      {unknownTenant ? (
        <p className={styles.note}>
          {/* Requested value deliberately not shown: untrusted input, discarded during resolution. */}
          A tenant was requested that is not configured. Using the built-in default theme.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Received</th>
              <th scope="col">Why it was rejected</th>
            </tr>
          </thead>
          <tbody>
            {issues.map((issue) => (
              <tr key={issue.field}>
                <td className={styles.field}>{issue.field}</td>
                <td className={styles.received}>{issue.received}</td>
                <td>{issue.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </details>
  );
}
