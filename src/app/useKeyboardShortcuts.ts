import { useEffect } from 'react';
import { useHcpStore } from '../store/StoreContext';

/**
 * Whether the event came from somewhere the browser's own undo should win.
 *
 * Ctrl+Z inside a text input means "undo my typing", not "undo my last committed
 * edit". Hijacking it would make the Calls editor feel broken in a way the user
 * could not explain.
 */
function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
}

/**
 * FR-4: Ctrl+Z / Ctrl+Shift+Z (and the Cmd equivalents).
 *
 * Bound on `window` rather than on the grid, because undo has to work after the
 * user has clicked the search box or a toast — the affordance is application-level,
 * and scoping it to the grid would make it depend on where focus happens to be.
 */
export function useKeyboardShortcuts(): void {
  const store = useHcpStore();

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (!(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== 'z') return;
      if (isTextEntry(event.target)) return;

      event.preventDefault();
      if (event.shiftKey) store.getState().redo();
      else store.getState().undo();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [store]);
}
