// SPDX-License-Identifier: AGPL-3.0-only

import type { Clock, TimerHandle } from '../util/clock.js';
import {
  QueueFullError, ReadOnlyError, SupersededError, TxAbortedError, TxTimeoutError,
} from './errors.js';

export interface TxRequest {
  bytes: Uint8Array;
  /** Decides whether a received frame acknowledges this request. Omit for fire-and-forget. */
  isAck?(frame: Buffer): boolean;
  /** A waiting request with the same key is replaced by this one (in place). In-flight requests are never replaced. */
  coalesceKey?: string;
  /** Ack wait per attempt. Default: `options.defaultTimeoutMs`. */
  timeoutMs?: number;
  /** Total number of writes, including the first one (1 = no retransmission). Default: `options.defaultMaxAttempts`. */
  maxAttempts?: number;
}

export interface TxResult {
  /** Number of writes performed. */
  attempts: number;
  /** Copy of the acknowledging frame, when `isAck` was given. */
  ack?: Buffer;
}

/**
 * When a write may be attempted.
 * - `idle`: after `busIdleMs` of bus silence.
 * - `after-frame`: `delayMs` after a frame accepted by `opensWindow`; falls back to `idle` after `fallbackAfterMs`
 *   without such a frame. `busIdleMs` is not applied to windows.
 */
export type SendWindowPolicy =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'after-frame';
      /** Whether a received frame opens a send window. Default: every frame. */
      readonly opensWindow?: (frame: Buffer) => boolean;
      /** Delay from the trigger frame to the write. Default 0. */
      readonly delayMs?: number;
      /** Fall back to the idle rule after waiting this long for a trigger. Default 1000. */
      readonly fallbackAfterMs?: number;
    };

export interface TxSchedulerOptions {
  clock: Clock;
  /** Puts bytes on the bus. May throw; a throw counts as a failed attempt. */
  write(bytes: Buffer): void;
  /** Reject every request with `ReadOnlyError`. */
  readOnly?: boolean;
  /** Default `{ kind: 'idle' }`. */
  sendWindow?: SendWindowPolicy;
  /** Idle rule: required silence since the last bus activity. Default 20. */
  busIdleMs?: number;
  /** Minimum time between our own writes. Default 50. */
  interFrameGapMs?: number;
  /** Default 300. */
  defaultTimeoutMs?: number;
  /** Default 3. */
  defaultMaxAttempts?: number;
  /** Maximum number of waiting (not in-flight) requests. Default 32. */
  maxQueueLength?: number;
}

interface Entry {
  readonly bytes: Buffer;
  readonly isAck?: (frame: Buffer) => boolean;
  readonly coalesceKey?: string;
  readonly timeoutMs: number;
  readonly maxAttempts: number;
  readonly resolve: (result: TxResult) => void;
  readonly reject: (error: unknown) => void;
  attempts: number;
  lastError?: unknown;
  /** `send`: waiting for a write opportunity; `ack`: written, waiting for the ack until `ackDeadline`. */
  phase: 'send' | 'ack';
  /** When the current wait for a write opportunity started (fallback reference). */
  waitStartedAt: number;
  /** Pending after-frame window time, if a trigger was seen during this wait. */
  windowAt: number | null;
  ackDeadline: number;
}

interface WindowConfig {
  readonly opensWindow: (frame: Buffer) => boolean;
  readonly delayMs: number;
  readonly fallbackAfterMs: number;
}

function nonNegative(name: string, value: number): number {
  if (!(value >= 0) || !Number.isFinite(value)) {
    throw new RangeError(`TxScheduler: ${name} must be a finite number >= 0, got ${value}`);
  }
  return value;
}

function positive(name: string, value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError(`TxScheduler: ${name} must be a finite number > 0, got ${value}`);
  }
  return value;
}

function positiveInt(name: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new RangeError(`TxScheduler: ${name} must be an integer >= 1, got ${value}`);
  }
  return value;
}

/**
 * Half-duplex transmit scheduler: writes one request at a time when the bus allows it, waits for its ack,
 * retransmits with an upper bound, and reports the outcome through the returned promise.
 */
export class TxScheduler {
  private readonly clock: Clock;
  private readonly writeFn: (bytes: Buffer) => void;
  private readonly readOnly: boolean;
  private readonly window: WindowConfig | null;
  private readonly busIdleMs: number;
  private readonly interFrameGapMs: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxAttempts: number;
  private readonly maxQueueLength: number;

  private readonly queue: Entry[] = [];
  private current: Entry | null = null;
  private lastBusActivityAt = -Infinity;
  private lastOwnTxAt = -Infinity;
  private timer: TimerHandle | undefined;
  private hasTimer = false;
  private pumping = false;
  private repump = false;

  constructor(options: TxSchedulerOptions) {
    this.clock = options.clock;
    this.writeFn = options.write;
    this.readOnly = options.readOnly ?? false;
    this.busIdleMs = nonNegative('busIdleMs', options.busIdleMs ?? 20);
    this.interFrameGapMs = nonNegative('interFrameGapMs', options.interFrameGapMs ?? 50);
    this.defaultTimeoutMs = positive('defaultTimeoutMs', options.defaultTimeoutMs ?? 300);
    this.defaultMaxAttempts = positiveInt('defaultMaxAttempts', options.defaultMaxAttempts ?? 3);
    this.maxQueueLength = positiveInt('maxQueueLength', options.maxQueueLength ?? 32);
    const policy = options.sendWindow ?? { kind: 'idle' };
    this.window = policy.kind === 'after-frame'
      ? {
        opensWindow: policy.opensWindow ?? (() => true),
        delayMs: nonNegative('sendWindow.delayMs', policy.delayMs ?? 0),
        fallbackAfterMs: nonNegative('sendWindow.fallbackAfterMs', policy.fallbackAfterMs ?? 1000),
      }
      : null;
  }

  /** Number of in-flight plus waiting requests. */
  get pending(): number {
    return (this.current === null ? 0 : 1) + this.queue.length;
  }

  /** Queues a request. Resolves on ack (or right after the write for fire-and-forget); rejects with a bus error. */
  enqueue(req: TxRequest): Promise<TxResult> {
    if (this.readOnly) {
      return Promise.reject(new ReadOnlyError());
    }
    let timeoutMs: number;
    let maxAttempts: number;
    try {
      if (req.bytes.length === 0) {
        throw new RangeError('TxScheduler: request bytes must not be empty');
      }
      timeoutMs = positive('timeoutMs', req.timeoutMs ?? this.defaultTimeoutMs);
      maxAttempts = positiveInt('maxAttempts', req.maxAttempts ?? this.defaultMaxAttempts);
    } catch (err) {
      return Promise.reject(err);
    }

    return new Promise<TxResult>((resolve, reject) => {
      const entry: Entry = {
        bytes: Buffer.from(req.bytes),
        isAck: req.isAck,
        coalesceKey: req.coalesceKey,
        timeoutMs,
        maxAttempts,
        resolve,
        reject,
        attempts: 0,
        phase: 'send',
        waitStartedAt: 0,
        windowAt: null,
        ackDeadline: 0,
      };
      const key = req.coalesceKey;
      const existing = key === undefined ? -1 : this.queue.findIndex((e) => e.coalesceKey === key);
      if (existing !== -1) {
        const replaced = this.queue[existing];
        this.queue[existing] = entry;
        replaced.reject(new SupersededError(key as string));
      } else if (this.queue.length >= this.maxQueueLength) {
        reject(new QueueFullError(this.maxQueueLength));
        return;
      } else {
        this.queue.push(entry);
      }
      this.pump();
    });
  }

  /** Feeds a received frame: records bus activity, resolves a matching ack, and may open a send window. */
  onFrame(frame: Buffer): void {
    const now = this.clock.now();
    this.lastBusActivityAt = now;
    const inFlight = this.current;
    const echo = inFlight !== null && frame.equals(inFlight.bytes);

    if (inFlight !== null && inFlight.phase === 'ack' && !echo && inFlight.isAck?.(frame)) {
      this.finish({ attempts: inFlight.attempts, ack: Buffer.from(frame) });
    }

    if (this.window !== null && !echo && this.window.opensWindow(frame)) {
      const next = this.promote(now);
      if (next !== null && next.phase === 'send' && next.windowAt === null) {
        next.windowAt = now + this.window.delayMs;
      }
    }
    this.pump();
  }

  /** Records raw bus activity (bytes seen even without a complete frame). */
  onBusActivity(): void {
    this.lastBusActivityAt = this.clock.now();
    this.pump();
  }

  /** Rejects the in-flight and all waiting requests with `TxAbortedError` and clears timers. */
  abortAll(reason: Error): void {
    const victims = this.current === null ? [...this.queue] : [this.current, ...this.queue];
    this.current = null;
    this.queue.length = 0;
    this.clearTimer();
    for (const entry of victims) {
      entry.reject(new TxAbortedError(reason));
    }
  }

  /** Makes the head of the queue the in-flight request if none is in flight. */
  private promote(now: number): Entry | null {
    if (this.current === null) {
      const next = this.queue.shift();
      if (next !== undefined) {
        this.startWaiting(next, now);
        this.current = next;
      }
    }
    return this.current;
  }

  private startWaiting(entry: Entry, now: number): void {
    entry.phase = 'send';
    entry.waitStartedAt = now;
    entry.windowAt = null;
  }

  private finish(result: TxResult): void {
    const entry = this.current;
    if (entry !== null) {
      this.current = null;
      entry.resolve(result);
    }
  }

  private fail(error: unknown): void {
    const entry = this.current;
    if (entry !== null) {
      this.current = null;
      entry.reject(error);
    }
  }

  /** Runs the state machine until it has to wait, then arms a single timer for the next deadline. */
  private pump(): void {
    if (this.pumping) {
      this.repump = true;
      return;
    }
    this.pumping = true;
    try {
      let deadline: number | null;
      do {
        this.repump = false;
        deadline = this.step();
      } while (this.repump);
      this.clearTimer();
      if (deadline !== null) {
        const delay = Math.max(0, deadline - this.clock.now());
        this.hasTimer = true;
        this.timer = this.clock.setTimeout(() => {
          this.hasTimer = false;
          this.timer = undefined;
          this.pump();
        }, delay);
      }
    } finally {
      this.pumping = false;
    }
  }

  /** Advances as far as possible. Returns the next time it needs to be woken up, or null when idle. */
  private step(): number | null {
    for (;;) {
      const now = this.clock.now();
      const entry = this.promote(now);
      if (entry === null) {
        return null;
      }

      if (entry.phase === 'ack') {
        if (now < entry.ackDeadline) {
          return entry.ackDeadline;
        }
        if (!this.retryOrFail(entry, now)) {
          continue;
        }
      }

      const decision = this.sendDecision(entry, now);
      if (decision !== 'now') {
        return decision;
      }
      this.attemptWrite(entry, now);
      if (this.repump) {
        return null;
      }
    }
  }

  /** Moves a timed-out or failed entry back to waiting, or rejects it. Returns false when it was rejected. */
  private retryOrFail(entry: Entry, now: number): boolean {
    if (entry.attempts >= entry.maxAttempts) {
      this.fail(new TxTimeoutError(entry.attempts, entry.lastError));
      return false;
    }
    this.startWaiting(entry, now);
    return true;
  }

  /** `'now'` when a write may happen immediately; otherwise the next time worth re-checking (or null). */
  private sendDecision(entry: Entry, now: number): 'now' | number | null {
    const gapAt = this.lastOwnTxAt + this.interFrameGapMs;
    const idleAt = Math.max(this.lastBusActivityAt + this.busIdleMs, gapAt);
    const win = this.window;
    if (win === null) {
      return now >= idleAt ? 'now' : idleAt;
    }

    if (entry.windowAt !== null && now >= entry.windowAt) {
      entry.windowAt = null;
      if (now >= gapAt) {
        return 'now';
      }
    }
    const fallbackAt = entry.waitStartedAt + win.fallbackAfterMs;
    if (now >= fallbackAt) {
      if (now >= idleAt) {
        return 'now';
      }
      return entry.windowAt === null ? idleAt : Math.min(idleAt, entry.windowAt);
    }
    return entry.windowAt === null ? fallbackAt : Math.min(fallbackAt, entry.windowAt);
  }

  private attemptWrite(entry: Entry, now: number): void {
    entry.attempts++;
    entry.windowAt = null;
    this.lastOwnTxAt = now;
    if (entry.isAck !== undefined) {
      // Enter the ack phase before writing so an ack delivered synchronously from write() is not missed.
      entry.phase = 'ack';
      entry.ackDeadline = now + entry.timeoutMs;
    }
    try {
      this.writeFn(Buffer.from(entry.bytes));
    } catch (err) {
      entry.lastError = err;
      if (this.current === entry) {
        this.retryOrFail(entry, this.clock.now());
      }
      return;
    }
    if (this.current === entry && entry.isAck === undefined) {
      this.finish({ attempts: entry.attempts });
    }
  }

  private clearTimer(): void {
    if (this.hasTimer) {
      this.clock.clearTimeout(this.timer);
      this.hasTimer = false;
      this.timer = undefined;
    }
  }
}
