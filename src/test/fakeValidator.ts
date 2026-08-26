import type { ValidatorClient } from '../services/validatorClient';

export interface PendingCall {
  readonly id: number;
  readonly value: number;
}

export interface FakeValidator extends ValidatorClient {
  /** Every call made, in order, including ones already settled. */
  readonly calls: readonly PendingCall[];
  /** Calls still awaiting `settle`. */
  readonly inFlight: readonly PendingCall[];
  /**
   * Resolve or reject one specific in-flight call.
   *
   * The whole point: resolution order is an argument, so a test can settle request
   * 2 before request 1 and assert the late result is dropped.
   *
   * @throws Error when `id` is not in flight — a test that settles the wrong call
   *   should fail loudly rather than silently assert nothing.
   */
  settle: (id: number, outcome: 'ok' | { reject: string }) => void;
  /** Reject everything outstanding, for teardown. */
  settleAll: (outcome: 'ok' | { reject: string }) => void;
  reset: () => void;
}

export const CAP_REJECTION = 'exceeds per-HCP call cap (60)';
export const TRANSIENT_REJECTION = 'validation service 503 (simulated)';

/**
 * A manually-driven validator.
 *
 * DECISION: manual control rather than fake timers. Fake timers would make the
 * *latency* deterministic but not the *order* — and order is the thing under test.
 * With `settle(id, ...)` a test writes the exact interleaving it wants to prove
 * safe, and there is no timer queue to reason about.
 */
export function createFakeValidator(): FakeValidator {
  interface Slot {
    readonly call: PendingCall;
    readonly resolve: () => void;
    readonly reject: (reason: string) => void;
    settled: boolean;
  }

  let nextId = 1;
  const slots: Slot[] = [];

  const find = (id: number): Slot => {
    const slot = slots.find((s) => s.call.id === id);
    if (slot === undefined) throw new Error(`No validator call with id ${id}`);
    if (slot.settled) throw new Error(`Validator call ${id} has already settled`);
    return slot;
  };

  return {
    get calls() {
      return slots.map((s) => s.call);
    },
    get inFlight() {
      return slots.filter((s) => !s.settled).map((s) => s.call);
    },

    validate: (value: number) =>
      new Promise<void>((resolve, reject) => {
        const call: PendingCall = { id: nextId++, value };
        slots.push({
          call,
          resolve,
          reject: (reason) => {
            // Rejects with a bare STRING, exactly as the vendor validator does. A
            // fake that rejected with an Error would be more idiomatic and would
            // let a bug in `toReason`'s string handling pass every test.
            // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- see above
            reject(reason);
          },
          settled: false,
        });
      }),

    settle: (id, outcome) => {
      const slot = find(id);
      slot.settled = true;
      if (outcome === 'ok') slot.resolve();
      else slot.reject(outcome.reject);
    },

    settleAll: (outcome) => {
      for (const slot of slots) {
        if (slot.settled) continue;
        slot.settled = true;
        if (outcome === 'ok') slot.resolve();
        else slot.reject(outcome.reject);
      }
    },

    reset: () => {
      slots.length = 0;
      nextId = 1;
    },
  };
}
