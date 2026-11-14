// SPDX-License-Identifier: AGPL-3.0-only

import type { Clock } from '../util/clock.js';

/** Why received bytes were discarded by the framing layer. */
export type DropReason = 'checksum' | 'garbage' | 'overflow' | 'too-long';

export interface StatsSnapshot {
  readonly rxBytes: number;
  readonly rxFrames: number;
  /** Number of drop events per reason. */
  readonly rxDropped: Readonly<Record<DropReason, number>>;
  /** Total bytes discarded per reason. */
  readonly rxDroppedBytes: Readonly<Record<DropReason, number>>;
  /** Writes actually put on the bus, including retries. */
  readonly txFrames: number;
  readonly txRetries: number;
  readonly txSucceeded: number;
  readonly txFailed: number;
  readonly connects: number;
  readonly disconnects: number;
  readonly lastRxAt: number | null;
  readonly lastTxAt: number | null;
  /** Creation or last `reset()` time. */
  readonly since: number;
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function zeroByReason(): Record<DropReason, number> {
  return { checksum: 0, garbage: 0, overflow: 0, 'too-long': 0 };
}

/**
 * Counters reported by every layer (transport, framing, bus) for logs and status UIs.
 */
export class Stats {
  private state: Mutable<StatsSnapshot> & {
    rxDropped: Record<DropReason, number>;
    rxDroppedBytes: Record<DropReason, number>;
  };

  constructor(private readonly clock: Clock) {
    this.state = this.initial();
  }

  /** Records raw bytes received from the bus (complete frame or not) and updates `lastRxAt`. */
  onRxBytes(n: number): void {
    this.state.rxBytes += n;
    this.state.lastRxAt = this.clock.now();
  }

  /** Records one valid frame decoded. */
  onRxFrame(): void {
    this.state.rxFrames++;
  }

  /** Records one drop event of `bytes` discarded bytes for `reason`. */
  onRxDrop(reason: DropReason, bytes: number): void {
    this.state.rxDropped[reason]++;
    this.state.rxDroppedBytes[reason] += bytes;
  }

  /** Records one write to the bus and updates `lastTxAt`. */
  onTx(isRetry: boolean): void {
    this.state.txFrames++;
    if (isRetry) {
      this.state.txRetries++;
    }
    this.state.lastTxAt = this.clock.now();
  }

  /** Records the final outcome of one transmit request. */
  onTxResult(ok: boolean): void {
    if (ok) {
      this.state.txSucceeded++;
    } else {
      this.state.txFailed++;
    }
  }

  onConnect(): void {
    this.state.connects++;
  }

  onDisconnect(): void {
    this.state.disconnects++;
  }

  /** Returns a frozen copy of the current counters. */
  snapshot(): StatsSnapshot {
    return Object.freeze({
      ...this.state,
      rxDropped: Object.freeze({ ...this.state.rxDropped }),
      rxDroppedBytes: Object.freeze({ ...this.state.rxDroppedBytes }),
    });
  }

  /** Zeroes all counters and sets `since` to now. */
  reset(): void {
    this.state = this.initial();
  }

  private initial(): Stats['state'] {
    return {
      rxBytes: 0,
      rxFrames: 0,
      rxDropped: zeroByReason(),
      rxDroppedBytes: zeroByReason(),
      txFrames: 0,
      txRetries: 0,
      txSucceeded: 0,
      txFailed: 0,
      connects: 0,
      disconnects: 0,
      lastRxAt: null,
      lastTxAt: null,
      since: this.clock.now(),
    };
  }
}
