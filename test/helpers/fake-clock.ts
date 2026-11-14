// SPDX-License-Identifier: AGPL-3.0-only

import type { Clock, TimerHandle } from '../../src/util/clock.js';

interface FakeTimer {
  readonly id: number;
  readonly at: number;
  readonly fn: () => void;
}

/**
 * Deterministic {@link Clock} for tests. Time only moves when {@link FakeClock.advance} is called.
 */
export class FakeClock implements Clock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    const delay = Number.isFinite(ms) && ms > 0 ? ms : 0;
    this.timers.set(id, { id, at: this.current + delay, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    if (typeof handle === 'number') {
      this.timers.delete(handle);
    }
  }

  /**
   * Moves time forward by `ms`, running timers that expire in that range in expiry order
   * (ties in registration order). Timers registered by callbacks are included if they fall in range.
   */
  advance(ms: number): void {
    if (!(ms >= 0)) {
      throw new RangeError(`FakeClock.advance: ms must be >= 0, got ${ms}`);
    }
    const target = this.current + ms;
    for (;;) {
      const next = this.earliestDue(target);
      if (next === undefined) {
        break;
      }
      this.timers.delete(next.id);
      this.current = next.at;
      next.fn();
    }
    this.current = target;
  }

  /** Number of timers that have been scheduled but have neither fired nor been cleared. */
  pendingCount(): number {
    return this.timers.size;
  }

  private earliestDue(limit: number): FakeTimer | undefined {
    let best: FakeTimer | undefined;
    for (const timer of this.timers.values()) {
      if (timer.at <= limit && (best === undefined || timer.at < best.at || (timer.at === best.at && timer.id < best.id))) {
        best = timer;
      }
    }
    return best;
  }
}
