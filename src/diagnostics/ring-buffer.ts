// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fixed-capacity FIFO that overwrites its oldest item when full. `push` is O(1).
 */
export class RingBuffer<T> {
  readonly capacity: number;
  private readonly items: (T | undefined)[];
  /** Index of the oldest item. */
  private head = 0;
  private count = 0;

  /** @param capacity maximum number of items; must be an integer >= 1. */
  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer: capacity must be an integer >= 1, got ${capacity}`);
    }
    this.capacity = capacity;
    this.items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.count;
  }

  /** Appends an item, overwriting the oldest one if the buffer is full. */
  push(item: T): void {
    if (this.count < this.capacity) {
      this.items[(this.head + this.count) % this.capacity] = item;
      this.count++;
    } else {
      this.items[this.head] = item;
      this.head = (this.head + 1) % this.capacity;
    }
  }

  /** Returns all items, oldest first, as a new array. */
  toArray(): T[] {
    return this.latest(this.count);
  }

  /** Returns the newest `n` items (at most `size`), oldest first, as a new array. */
  latest(n: number): T[] {
    const take = n > 0 ? Math.min(Math.floor(n), this.count) : 0;
    const out = new Array<T>(take);
    const start = this.head + this.count - take;
    for (let i = 0; i < take; i++) {
      out[i] = this.items[(start + i) % this.capacity] as T;
    }
    return out;
  }

  /** Removes all items. */
  clear(): void {
    this.items.fill(undefined);
    this.head = 0;
    this.count = 0;
  }
}
