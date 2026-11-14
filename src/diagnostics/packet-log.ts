// SPDX-License-Identifier: AGPL-3.0-only

import type { Clock } from '../util/clock.js';
import { RingBuffer } from './ring-buffer.js';

/** Packet direction relative to this plugin: received from or transmitted to the bus. */
export type Direction = 'rx' | 'tx';

export interface PacketLogEntry {
  /** `clock.now()` at the time of recording. */
  readonly at: number;
  readonly direction: Direction;
  /** Private copy of the recorded bytes. Treat as read-only. */
  readonly bytes: Buffer;
  /** Free-form annotation, e.g. `'checksum-mismatch'` or `'retry 2/3'`. */
  readonly note?: string;
}

/**
 * Bounded log of the most recent rx/tx packets for diagnostics. Older entries are discarded.
 */
export class PacketLog {
  private readonly buffer: RingBuffer<PacketLogEntry>;

  /** @param capacity maximum number of entries kept; must be an integer >= 1. */
  constructor(capacity: number, private readonly clock: Clock) {
    this.buffer = new RingBuffer<PacketLogEntry>(capacity);
  }

  /** Records a copy of `bytes`, timestamped with the injected clock. */
  record(direction: Direction, bytes: Uint8Array, note?: string): void {
    const entry: PacketLogEntry = note === undefined
      ? { at: this.clock.now(), direction, bytes: Buffer.from(bytes) }
      : { at: this.clock.now(), direction, bytes: Buffer.from(bytes), note };
    this.buffer.push(Object.freeze(entry));
  }

  /** Returns the logged entries, oldest first, as a new array. */
  entries(): readonly PacketLogEntry[] {
    return this.buffer.toArray();
  }

  /** Removes all entries. */
  clear(): void {
    this.buffer.clear();
  }
}
