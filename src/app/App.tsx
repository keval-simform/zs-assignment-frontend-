import { ThemeIssuePanel } from '../features/feedback/ThemeIssuePanel';
import { Toasts } from '../features/feedback/Toasts';
import { ThemeProvider } from '../features/theme/ThemeProvider';
import { Grid } from '../features/grid/Grid';
import { Toolbar } from '../features/toolbar/Toolbar';
import { StoreProvider } from '../store/StoreContext';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import type { HcpStore } from '../store/store';
import styles from './App.module.css';

/**
 * The application shell.
 *
 * Takes the store as a prop rather than importing the singleton, so a test can
 * mount the whole app over a four-row fixture.
 */
export function App({ store }: { store: HcpStore }): JSX.Element {
  return (
    <StoreProvider store={store}>
      <AppBody />
    </StoreProvider>
  );
}

/**
 * Split from `App` because `useKeyboardShortcuts` reads the store from context, and
 * a hook cannot consume a provider its own component renders.
 */
function AppBody(): JSX.Element {
  useKeyboardShortcuts();
  return (
    <ThemeProvider>
      <div className={styles.app}>
        <Toolbar />
        <Grid />
        <ThemeIssuePanel />
        <Toasts />
      </div>
    </ThemeProvider>
  );
}
