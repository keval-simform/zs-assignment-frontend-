/**
 * mock-validator.ts — provided starter file. DO NOT MODIFY.
 * Simulates a server-side business-rule validation for Calls edits.
 * Treat it as a black box: latency and failures are part of the assignment.
 */

const CALL_CAP = 60;
const RANDOM_FAILURE_RATE = 0.1;

export function validateCalls(newValue: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const latency = 300 + Math.random() * 600;
    setTimeout(() => {
      if (newValue > CALL_CAP) {
        reject(`exceeds per-HCP call cap (${CALL_CAP})`);
      } else if (Math.random() < RANDOM_FAILURE_RATE) {
        reject("validation service 503 (simulated)");
      } else {
        resolve();
      }
    }, latency);
  });
}
