import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import type { HcpRecord } from '../vendor/data-generator';
import { App } from '../app/App';
import { createHcpStore } from '../store/store';
import type { HcpStore } from '../store/store';
import { fixture } from './fixtures';
import { createFakeValidator } from './fakeValidator';
import type { FakeValidator } from './fakeValidator';

/**
 * jsdom performs no layout, so `clientHeight` is 0 and the virtual window would
 * compute a viewport of zero rows. Stubbing it is what makes the windowing maths
 * observable in a test at all.
 */
export const TEST_VIEWPORT_HEIGHT = 640;

export function stubViewportHeight(height = TEST_VIEWPORT_HEIGHT): () => void {
  const original = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight');
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => height,
  });
  return () => {
    if (original === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight');
      return;
    }
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', original);
  };
}

export interface MountedGrid extends RenderResult {
  readonly store: HcpStore;
  /** The injected validator, so a test can settle calls by hand. */
  readonly validator: FakeValidator;
}

/**
 * Mount the whole app over a hand-written fixture, with a manually-driven validator.
 *
 * Every mounted grid gets a fake validator even when the test does not touch
 * editing: the real one would fire 300–900 ms timers that outlive the test and
 * settle into an unmounted tree.
 */
export function mountGrid(rows: readonly HcpRecord[]): MountedGrid {
  const validator = createFakeValidator();
  const store = createHcpStore(fixture(rows), validator);
  return { ...render(<App store={store} />), store, validator };
}

/** Mount over an existing store, for cases that need to seed state first. */
export function mountGridWithStore(store: HcpStore, validator = createFakeValidator()): MountedGrid {
  return { ...render(<App store={store} />), store, validator };
}

/**
 * Row elements React actually rendered, excluding the sticky column-header row.
 *
 * The header carries `role="row"` because that is correct ARIA for a header row in
 * a grid, so it shows up in `getAllByRole('row')` and has to be discounted here.
 */
export function renderedRows(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll('[role="row"]')].filter(
    (el): el is HTMLElement => el.querySelector('[role="columnheader"]') === null,
  );
}

/** Set scrollTop and fire the scroll event the hook listens for. */
export function scrollTo(element: HTMLElement, top: number): void {
  element.scrollTop = top;
  element.dispatchEvent(new Event('scroll'));
}
