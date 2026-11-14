// SPDX-License-Identifier: AGPL-3.0-only

/** Opaque timer handle returned by {@link Clock.setTimeout}. */
export type TimerHandle = unknown;

/**
 * Injectable time source so time-dependent logic can run deterministically under test.
 */
export interface Clock {
  /** Current time in milliseconds. Assumed to be non-decreasing. */
  now(): number;
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}

/** Real clock backed by `Date.now` and the global timer functions. */
export const systemClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => {
    globalThis.clearTimeout(handle as ReturnType<typeof globalThis.setTimeout> | undefined);
  },
};
