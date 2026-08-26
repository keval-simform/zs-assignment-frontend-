import { validateCalls } from '../vendor/mock-validator';
import type { RejectionReason } from '../store/types';

/**
 * The seam between the store and the provided validator.
 *
 * DECISION: an interface injected into the store, not a direct import of the vendor
 * function. This is what makes tests deterministic: a real `validateCalls` settles
 * after 300–900 ms and fails 10% of the time at random, so testing out-of-order
 * resolution against it would be a coin flip. Through the seam, a fake exposes
 * `settle(id, ok)` and resolution order becomes an argument.
 *
 * The vendor file itself is untouched (HARD CONSTRAINT 1); everything below adapts
 * around its contract.
 */
export interface ValidatorClient {
  /**
   * Validate a proposed Calls value.
   *
   * INVARIANT: there is **no cancellation** — the vendor implementation is a bare
   * `setTimeout` with no abort path, so a called promise *will* settle. Every caller
   * must assume its result can arrive after the state that requested it has moved
   * on; that's what the `reqId` stale guard in `commitEdit` is for. An `AbortSignal`
   * parameter here would be a comforting lie: nothing downstream could honour it.
   */
  validate: (value: number) => Promise<void>;
}

/** The production client: the provided validator, unmodified. */
export const vendorValidatorClient: ValidatorClient = {
  validate: (value) => validateCalls(value),
};

/**
 * Substrings the vendor validator uses in its rejection reasons.
 *
 * DECISION: classify by matching the reason text, because `validateCalls` rejects
 * with a bare `string`, not an `Error` or a structured code — text is the only
 * discriminator on offer. A real service would return `{ code: 'CALL_CAP' }` and
 * this would shrink to a lookup.
 *
 * Rejected alternative: inferring "cap violation" by comparing the value against 60
 * locally. That would re-implement the server's business rule on the client, and it
 * would silently mis-classify every rejection the moment the cap changed.
 */
const CAP_MARKER = 'call cap';
const TRANSIENT_MARKER = '503';

/**
 * Narrow whatever the validator rejected with into a classified reason.
 *
 * The parameter is `unknown` rather than `string` on purpose: the contract says a
 * string, but a black box doesn't get its contract assumed. A thrown `Error`, an
 * object, or `undefined` all have to produce something the UI can show rather than
 * an unhandled rejection.
 *
 * @returns a `cap` reason (deterministic, retrying is futile), a `transient` one
 *   (retry is the right affordance), or `unknown` — treated as retryable, since
 *   refusing to let the user retry an error we don't understand is the worse
 *   failure.
 */
export function toReason(error: unknown): RejectionReason {
  const message = messageOf(error);
  if (message.includes(CAP_MARKER)) return { kind: 'cap', message };
  if (message.includes(TRANSIENT_MARKER)) return { kind: 'transient', message };
  return { kind: 'unknown', message };
}

function messageOf(error: unknown): string {
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message;
  if (error === null || error === undefined) return 'Validation failed for an unknown reason';
  if (typeof error === 'object' && 'message' in error) {
    const { message } = error;
    if (typeof message === 'string') return message;
  }
  // `String(error)` on an object yields "[object Object]", which tells the user
  // nothing; JSON.stringify is guarded since a circular structure would throw.
  try {
    return `Validation failed: ${JSON.stringify(error)}`;
  } catch {
    return 'Validation failed for an unknown reason';
  }
}
