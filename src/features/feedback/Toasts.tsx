import { useHcpStore, useStoreSelector } from '../../store/StoreContext';
import type { Toast } from '../../store/types';
import styles from './Toasts.module.css';

/** Render whichever single action a toast offers. */
function ToastActionButton({ toast }: { toast: Toast }): JSX.Element | null {
  const store = useHcpStore();
  const { action, rowKey } = toast;
  if (action === null || rowKey === null) return null;

  switch (action.kind) {
    case 'retry':
      return (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            store.getState().dismissToast(toast.id);
            void store.getState().retryEdit(rowKey);
          }}
        >
          Retry
        </button>
      );
    case 'show':
      return (
        <button
          type="button"
          className={styles.action}
          onClick={() => {
            store.getState().dismissToast(toast.id);
            store.getState().showHiddenRow(rowKey);
          }}
        >
          Show it
        </button>
      );
    default: {
      const unhandled: never = action;
      throw new Error(`Unhandled toast action: ${JSON.stringify(unhandled)}`);
    }
  }
}

/** How many toasts are shown at once. The rest stay in state, reachable by dismissing. */
const VISIBLE_LIMIT = 4;

/**
 * FR-4: rejection reasons surfaced where the user will actually see them.
 *
 * DECISION: rejections appear in TWO places — on the cell and here. A cell-only
 * error isn't sufficient in a virtualized grid: the validator takes 300–900 ms, long
 * enough for the user to scroll, collapse the group, or filter the row out of view,
 * and a message painted on an unmounted component reaches nobody. The cell tells you
 * *which* value failed when you're looking at it; the toast tells you *that*
 * something failed when you're not.
 *
 * `aria-live="polite"`, not `assertive`: a rejected edit isn't an emergency, and
 * assertive would cut across a screen-reader user mid-sentence on every 503.
 */
export function Toasts(): JSX.Element | null {
  const store = useHcpStore();
  const toasts = useStoreSelector((s) => s.toasts);

  const visible = toasts.slice(0, VISIBLE_LIMIT);

  return (
    <div className={styles.region} role="log" aria-live="polite" aria-label="Edit results">
      {toasts.length > VISIBLE_LIMIT ? (
        <button
          type="button"
          className={`${styles.action} ${styles.clearAll}`}
          onClick={() => {
            store.getState().clearToasts();
          }}
        >
          Dismiss all ({toasts.length})
        </button>
      ) : null}
      {visible.map((toast) => (
        <div key={toast.id} className={`${styles.toast} ${toast.kind === 'info' ? styles.info : ''}`}>
          <span
            className={`${styles.marker} ${toast.kind === 'info' ? styles.infoMarker : ''}`}
            aria-hidden="true"
          >
            {toast.kind === 'info' ? 'ℹ' : '⚠'}
          </span>
          <span className={styles.title}>{toast.title}</span>
          <button
            type="button"
            className={styles.dismiss}
            aria-label={`Dismiss: ${toast.title}`}
            onClick={() => {
              store.getState().dismissToast(toast.id);
            }}
          >
            ×
          </button>
          <span className={styles.detail}>{toast.detail}</span>
          {toast.action !== null && toast.rowKey !== null ? (
            <span className={styles.actions}>
              <ToastActionButton toast={toast} />
            </span>
          ) : null}
          {toast.action === null && toast.kind === 'rejection' ? (
            // A cap violation is deterministic — more useful to say so than to show
            // a Retry button guaranteed to fail.
            <span className={styles.notRetryable}>
              This value will be rejected again — change it and try a different one.
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}
