import '@testing-library/jest-dom/jest-globals';
import { cleanup } from '@testing-library/react';
import { afterEach } from '@jest/globals';

/**
 * React Testing Library normally registers its own `afterEach(cleanup)` — but only
 * if it finds a *global* `afterEach`. This project runs Jest with `injectGlobals:
 * false` (see `jest.config.ts`), so that auto-registration never happens and
 * mounted trees accumulate in `document.body` across cases.
 *
 * The symptom is confusing rather than obvious: tests pass in isolation and fail in
 * a suite with "found multiple elements", because `screen` queries the whole
 * document and finds three previous grids alongside the current one.
 */
afterEach(() => {
  cleanup();
});
