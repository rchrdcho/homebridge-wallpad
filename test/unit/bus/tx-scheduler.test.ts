// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  QueueFullError, ReadOnlyError, SupersededError, TxAbortedError, TxTimeoutError,
} from '../../../src/bus/errors.js';
import { TxScheduler, type TxRequest, type TxResult, type TxSchedulerOptions } from '../../../src/bus/tx-scheduler.js';
import { fromHex, toHex } from '../../../src/util/hex.js';
import { FakeClock } from '../../helpers/fake-clock.js';

interface Write {
  at: number;
  hex: string;
}

interface Tracked {
  state: 'pending' | 'fulfilled' | 'rejected';
  value?: TxResult;
  error?: unknown;
}

interface Harness {
  clock: FakeClock;
  sched: TxScheduler;
  writes: Write[];
  writeHook: { fn?: (bytes: Buffer) => void };
}

let current: Harness | undefined;

function setup(options: Partial<TxSchedulerOptions> = {}, start = 1000): Harness {
  const clock = new FakeClock(start);
  const writes: Write[] = [];
  const writeHook: Harness['writeHook'] = {};
  const sched = new TxScheduler({
    clock,
    write: (bytes) => {
      writes.push({ at: clock.now(), hex: toHex(bytes) });
      writeHook.fn?.(bytes);
    },
    ...options,
  });
  current = { clock, sched, writes, writeHook };
  return current;
}

function track(p: Promise<TxResult>): Tracked {
  const t: Tracked = { state: 'pending' };
  p.then(
    (value) => {
      t.state = 'fulfilled';
      t.value = value;
    },
    (error: unknown) => {
      t.state = 'rejected';
      t.error = error;
    },
  );
  return t;
}

/** Lets promise callbacks run. */
const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

const CMD = fromHex('F7 20 21 01 11 01 00 00 00 00 00 00 00 54 AA');
const CMD2 = fromHex('F7 20 22 01 11 01 00 00 00 00 00 00 00 55 AA');
const ACK = fromHex('F7 20 01 21 9F 00 00 00 00 00 00 00 00 E1 AA');
const ACK2 = fromHex('F7 20 01 22 9F 00 00 00 00 00 00 00 00 E2 AA');
const OTHER = fromHex('F7 20 01 4A 81 00 00 00 00 00 00 00 00 EC AA');

const isAckFor = (ack: Buffer) => (f: Buffer) => f.equals(ack);

function req(bytes: Buffer, extra: Partial<TxRequest> = {}): TxRequest {
  return { bytes, ...extra };
}

/** Times (relative to `base`) of every write. */
const writeTimes = (h: Harness, base = 1000) => h.writes.map((w) => w.at - base);

afterEach(() => {
  // §4.4 15: no timer may outlive a test
  if (current) {
    const h = current;
    current = undefined;
    h.sched.abortAll(new Error('test teardown'));
    assert.equal(h.clock.pendingCount(), 0, 'timers leaked after abortAll');
  }
});

/** Asserts that the scheduler has fully settled with no timers left. */
function assertIdle(h: Harness): void {
  assert.equal(h.sched.pending, 0);
  assert.equal(h.clock.pendingCount(), 0);
}

describe('TxScheduler (idle policy)', () => {
  // §4.4 1
  it('writes a fire-and-forget request immediately and resolves', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD)));
    assert.deepEqual(h.writes, [{ at: 1000, hex: toHex(CMD) }]);
    await flush();
    assert.equal(t.state, 'fulfilled');
    assert.deepEqual(t.value, { attempts: 1 });
    assertIdle(h);
  });

  // §4.4 2
  it('resolves with the ack frame when the ack arrives in time', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(100);
    await flush();
    assert.equal(t.state, 'pending');
    h.sched.onFrame(ACK);
    await flush();
    assert.equal(t.state, 'fulfilled');
    assert.equal(t.value?.attempts, 1);
    assert.equal(toHex(t.value?.ack ?? Buffer.alloc(0)), toHex(ACK));
    assert.equal(h.writes.length, 1);
    assertIdle(h);
  });

  it('returns the ack as a copy', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    const frame = Buffer.from(ACK);
    h.sched.onFrame(frame);
    frame.fill(0);
    await flush();
    assert.equal(toHex(t.value?.ack ?? Buffer.alloc(0)), toHex(ACK));
  });

  // §4.4 3
  it('retries every timeoutMs and rejects with TxTimeoutError after maxAttempts attempts', async () => {
    const h = setup({ defaultTimeoutMs: 300, defaultMaxAttempts: 3 });
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(899);
    await flush();
    assert.deepEqual(writeTimes(h), [0, 300, 600]);
    assert.equal(t.state, 'pending');
    h.clock.advance(1);
    await flush();
    assert.equal(t.state, 'rejected');
    assert.ok(t.error instanceof TxTimeoutError);
    assert.equal(t.error.attempts, 3);
    assertIdle(h);
  });

  it('honours per-request timeoutMs and maxAttempts', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK), timeoutMs: 100, maxAttempts: 2 })));
    h.clock.advance(200);
    await flush();
    assert.deepEqual(writeTimes(h), [0, 100]);
    assert.ok(t.error instanceof TxTimeoutError);
    assert.equal(t.error.attempts, 2);
  });

  it('maxAttempts 1 means a single attempt', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK), maxAttempts: 1 })));
    h.clock.advance(300);
    await flush();
    assert.equal(h.writes.length, 1);
    assert.ok(t.error instanceof TxTimeoutError);
  });

  // §4.4 4
  it('resolves with attempts 2 when the ack follows the retry', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(310);
    h.sched.onFrame(ACK);
    await flush();
    assert.deepEqual(writeTimes(h), [0, 300]);
    assert.equal(t.state, 'fulfilled');
    assert.equal(t.value?.attempts, 2);
    assertIdle(h);
  });

  // §4.4 5
  it('waits busIdleMs after bus activity before writing', () => {
    const h = setup({ busIdleMs: 20 });
    h.sched.onBusActivity();
    h.clock.advance(5);
    void track(h.sched.enqueue(req(CMD)));
    assert.equal(h.writes.length, 0);
    h.clock.advance(14);
    assert.equal(h.writes.length, 0);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [20]);
  });

  it('treats onFrame as bus activity', () => {
    const h = setup({ busIdleMs: 20 });
    h.sched.onFrame(OTHER);
    void track(h.sched.enqueue(req(CMD)));
    h.clock.advance(19);
    assert.equal(h.writes.length, 0);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [20]);
  });

  // §4.4 6
  it('keeps deferring while bus activity continues', () => {
    const h = setup({ busIdleMs: 20 });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    void track(h.sched.enqueue(req(CMD2)));
    assert.equal(h.writes.length, 1);
    // first request is waiting for its ack; keep the bus busy so the retry is deferred
    h.clock.advance(290);
    for (let i = 0; i < 20; i++) {
      h.sched.onBusActivity();
      h.clock.advance(10);
    }
    assert.equal(h.writes.length, 1, 'retry must wait for a quiet bus');
    h.clock.advance(9);
    assert.equal(h.writes.length, 1);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [0, 500]);
  });

  // §4.4 7
  it('spaces consecutive writes by interFrameGapMs, starting the next only after completion', async () => {
    const h = setup({ interFrameGapMs: 50, busIdleMs: 0 });
    const a = track(h.sched.enqueue(req(CMD)));
    const b = track(h.sched.enqueue(req(CMD2)));
    assert.deepEqual(writeTimes(h), [0]);
    h.clock.advance(49);
    assert.deepEqual(writeTimes(h), [0]);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [0, 50]);
    await flush();
    assert.equal(a.state, 'fulfilled');
    assert.equal(b.state, 'fulfilled');
    assertIdle(h);
  });

  it('does not write the next request until the current one is acked', () => {
    const h = setup({ interFrameGapMs: 50, busIdleMs: 20 });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    void track(h.sched.enqueue(req(CMD2)));
    h.clock.advance(100);
    assert.deepEqual(writeTimes(h), [0]);
    h.sched.onFrame(ACK);
    h.clock.advance(19);
    assert.deepEqual(writeTimes(h), [0]);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [0, 120]);
  });

  // §4.4 8
  it('does not treat an echo of the request bytes as its ack', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: () => true })));
    h.sched.onFrame(Buffer.from(CMD));
    await flush();
    assert.equal(t.state, 'pending');
    h.sched.onFrame(ACK);
    await flush();
    assert.equal(t.state, 'fulfilled');
    assert.equal(toHex(t.value?.ack ?? Buffer.alloc(0)), toHex(ACK));
  });

  it('ignores ack-looking frames for a different request', async () => {
    const h = setup();
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.sched.onFrame(ACK2);
    await flush();
    assert.equal(t.state, 'pending');
  });

  // §4.4 9
  it('coalesces queued requests with the same key, keeping the original position', async () => {
    const h = setup({ busIdleMs: 0, interFrameGapMs: 0 });
    const head = track(h.sched.enqueue(req(OTHER, { isAck: isAckFor(ACK2) })));
    const v1 = track(h.sched.enqueue(req(fromHex('01'), { coalesceKey: 'light' })));
    const other = track(h.sched.enqueue(req(fromHex('02'))));
    const v2 = track(h.sched.enqueue(req(fromHex('03'), { coalesceKey: 'light' })));
    assert.equal(h.sched.pending, 3);
    await flush();
    assert.equal(v1.state, 'rejected');
    assert.ok(v1.error instanceof SupersededError);
    h.sched.onFrame(ACK2);
    h.clock.advance(0);
    await flush();
    assert.deepEqual(h.writes.map((w) => w.hex), [toHex(OTHER), '03', '02']);
    assert.equal(head.state, 'fulfilled');
    assert.equal(v2.state, 'fulfilled');
    assert.equal(other.state, 'fulfilled');
    assertIdle(h);
  });

  it('allows coalescing into a full queue', async () => {
    const h = setup({ maxQueueLength: 1 });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    const v1 = track(h.sched.enqueue(req(fromHex('01'), { coalesceKey: 'k' })));
    const v2 = track(h.sched.enqueue(req(fromHex('02'), { coalesceKey: 'k' })));
    await flush();
    assert.ok(v1.error instanceof SupersededError);
    assert.equal(v2.state, 'pending');
  });

  // §4.4 10
  it('does not replace an in-flight request with the same key', async () => {
    const h = setup({ busIdleMs: 0, interFrameGapMs: 0 });
    const a = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK), coalesceKey: 'light' })));
    const b = track(h.sched.enqueue(req(CMD2, { coalesceKey: 'light' })));
    assert.equal(h.sched.pending, 2);
    h.sched.onFrame(ACK);
    h.clock.advance(0);
    await flush();
    assert.equal(a.state, 'fulfilled');
    assert.equal(b.state, 'fulfilled');
    assert.deepEqual(h.writes.map((w) => w.hex), [toHex(CMD), toHex(CMD2)]);
  });

  // §4.4 11
  it('rejects every request in readOnly mode without writing', async () => {
    const h = setup({ readOnly: true });
    const t = track(h.sched.enqueue(req(CMD)));
    await flush();
    assert.ok(t.error instanceof ReadOnlyError);
    assert.equal(h.writes.length, 0);
    assertIdle(h);
  });

  // §4.4 12
  it('rejects with QueueFullError beyond maxQueueLength waiting requests', async () => {
    const h = setup({ maxQueueLength: 2 });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    void track(h.sched.enqueue(req(fromHex('01'))));
    void track(h.sched.enqueue(req(fromHex('02'))));
    const overflow = track(h.sched.enqueue(req(fromHex('03'))));
    await flush();
    assert.ok(overflow.error instanceof QueueFullError);
    assert.equal(h.sched.pending, 3);
  });

  // §4.4 13
  it('retries when write throws and reports the last cause on final failure', async () => {
    const h = setup({ interFrameGapMs: 50, defaultMaxAttempts: 3 });
    let n = 0;
    h.writeHook.fn = () => {
      throw new Error(`EPIPE ${++n}`);
    };
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(1000);
    await flush();
    assert.deepEqual(writeTimes(h), [0, 50, 100]);
    assert.ok(t.error instanceof TxTimeoutError);
    assert.equal(t.error.attempts, 3);
    assert.ok(t.error.cause instanceof Error);
    assert.equal(t.error.cause.message, 'EPIPE 3');
    assertIdle(h);
  });

  it('recovers when write throws once', async () => {
    const h = setup({ interFrameGapMs: 50 });
    let first = true;
    h.writeHook.fn = () => {
      if (first) {
        first = false;
        throw new Error('EAGAIN');
      }
    };
    const t = track(h.sched.enqueue(req(CMD)));
    h.clock.advance(50);
    await flush();
    assert.deepEqual(t.value, { attempts: 2 });
  });

  // §4.4 14
  it('abortAll rejects everything, clears timers, and accepts new requests afterwards', async () => {
    const h = setup();
    const a = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    const b = track(h.sched.enqueue(req(CMD2)));
    const c = track(h.sched.enqueue(req(OTHER)));
    const reason = new Error('socket closed');
    h.sched.abortAll(reason);
    await flush();
    for (const t of [a, b, c]) {
      assert.ok(t.error instanceof TxAbortedError);
      assert.equal(t.error.cause, reason);
    }
    assertIdle(h);
    const d = track(h.sched.enqueue(req(CMD)));
    h.clock.advance(50);
    await flush();
    assert.equal(d.state, 'fulfilled');
    assertIdle(h);
  });

  it('copies request bytes at enqueue', () => {
    const h = setup({ busIdleMs: 20 });
    h.sched.onBusActivity();
    const bytes = Buffer.from(CMD);
    void track(h.sched.enqueue(req(bytes)));
    bytes.fill(0);
    h.clock.advance(20);
    assert.equal(h.writes[0].hex, toHex(CMD));
  });

  it('counts in-flight and queued requests in pending', () => {
    const h = setup();
    assert.equal(h.sched.pending, 0);
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    assert.equal(h.sched.pending, 1);
    void track(h.sched.enqueue(req(CMD2)));
    assert.equal(h.sched.pending, 2);
  });

  it('handles onFrame called synchronously from write (echo)', async () => {
    const h = setup();
    h.writeHook.fn = (bytes) => h.sched.onFrame(bytes);
    const t = track(h.sched.enqueue(req(CMD, { isAck: () => true })));
    await flush();
    assert.equal(t.state, 'pending');
    h.sched.onFrame(ACK);
    await flush();
    assert.equal(t.state, 'fulfilled');
  });

  it('accepts an ack delivered synchronously from inside write', async () => {
    const h = setup();
    h.writeHook.fn = () => h.sched.onFrame(ACK);
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(1000);
    await flush();
    assert.equal(t.state, 'fulfilled');
    assert.equal(t.value?.attempts, 1);
    assert.equal(h.writes.length, 1);
    assertIdle(h);
  });

  it('handles abortAll called from inside write', async () => {
    const h = setup();
    const reason = new Error('closed while writing');
    h.writeHook.fn = () => h.sched.abortAll(reason);
    const a = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    await flush();
    assert.ok(a.error instanceof TxAbortedError);
    assertIdle(h);
  });

  it('rejects invalid requests with RangeError', async () => {
    const h = setup();
    const bad: Partial<TxRequest>[] = [{ maxAttempts: 0 }, { maxAttempts: 1.5 }, { timeoutMs: 0 }, { timeoutMs: NaN }];
    for (const extra of bad) {
      const t = track(h.sched.enqueue(req(CMD, extra)));
      await flush();
      assert.ok(t.error instanceof RangeError, JSON.stringify(extra));
    }
    const empty = track(h.sched.enqueue(req(Buffer.alloc(0))));
    await flush();
    assert.ok(empty.error instanceof RangeError);
    assert.equal(h.writes.length, 0);
  });

  it('rejects invalid options with RangeError', () => {
    const clock = new FakeClock();
    const write = () => undefined;
    const bad: Partial<TxSchedulerOptions>[] = [
      { busIdleMs: -1 }, { interFrameGapMs: NaN }, { defaultTimeoutMs: 0 }, { defaultMaxAttempts: 0 },
      { maxQueueLength: 0 }, { sendWindow: { kind: 'after-frame', delayMs: -1 } },
      { sendWindow: { kind: 'after-frame', fallbackAfterMs: -5 } },
    ];
    for (const o of bad) {
      assert.throws(() => new TxScheduler({ clock, write, ...o }), RangeError, JSON.stringify(o));
    }
  });
});

describe('TxScheduler (after-frame policy)', () => {
  const TRIGGER = fromHex('F7 20 21 01 01 00 00 00 00 00 00 00 00 43 AA');
  const notState = (f: Buffer) => !(f[2] === 0x01 && f[4] === 0x81);

  // §4.4 16
  it('writes delayMs after a trigger frame and not before, even on a quiet bus', () => {
    const h = setup({ sendWindow: { kind: 'after-frame', delayMs: 5 } });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    h.clock.advance(500);
    assert.equal(h.writes.length, 0);
    h.sched.onFrame(TRIGGER);
    h.clock.advance(4);
    assert.equal(h.writes.length, 0);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [505]);
  });

  it('writes synchronously on the trigger with the default delay of 0', () => {
    const h = setup({ sendWindow: { kind: 'after-frame' } });
    void track(h.sched.enqueue(req(CMD)));
    h.clock.advance(10);
    assert.equal(h.writes.length, 0);
    h.sched.onFrame(OTHER);
    assert.deepEqual(writeTimes(h), [10]);
  });

  it('ignores busIdleMs under after-frame', () => {
    const h = setup({ busIdleMs: 1000, sendWindow: { kind: 'after-frame' } });
    void track(h.sched.enqueue(req(CMD)));
    h.sched.onBusActivity();
    h.sched.onFrame(TRIGGER);
    assert.equal(h.writes.length, 1);
  });

  // §4.4 17
  it('does not open a window for frames rejected by opensWindow', () => {
    const h = setup({ sendWindow: { kind: 'after-frame', opensWindow: notState } });
    void track(h.sched.enqueue(req(CMD)));
    h.sched.onFrame(OTHER); // state frame
    assert.equal(h.writes.length, 0);
    h.clock.advance(10);
    h.sched.onFrame(TRIGGER);
    assert.deepEqual(writeTimes(h), [10]);
  });

  it('does not open a window on an echo of the in-flight request', () => {
    const h = setup({ interFrameGapMs: 0, sendWindow: { kind: 'after-frame' } });
    void track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK), timeoutMs: 100 })));
    h.sched.onFrame(TRIGGER);
    assert.equal(h.writes.length, 1);
    h.clock.advance(100); // timed out, waiting for a window to retry
    h.sched.onFrame(Buffer.from(CMD));
    assert.equal(h.writes.length, 1);
    h.sched.onFrame(TRIGGER);
    assert.equal(h.writes.length, 2);
  });

  // §4.4 18
  it('uses an ack frame that is also a trigger to send the next request, not the acked one', async () => {
    const h = setup({ interFrameGapMs: 0, sendWindow: { kind: 'after-frame' } });
    const a = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK) })));
    const b = track(h.sched.enqueue(req(CMD2)));
    h.sched.onFrame(TRIGGER);
    assert.deepEqual(h.writes.map((w) => w.hex), [toHex(CMD)]);
    h.clock.advance(10);
    h.sched.onFrame(ACK);
    assert.deepEqual(h.writes.map((w) => w.hex), [toHex(CMD), toHex(CMD2)]);
    await flush();
    assert.equal(a.state, 'fulfilled');
    assert.equal(b.state, 'fulfilled');
    assertIdle(h);
  });

  // §4.4 19
  it('discards a window that opens before interFrameGapMs has elapsed', () => {
    const h = setup({ interFrameGapMs: 50, sendWindow: { kind: 'after-frame' } });
    void track(h.sched.enqueue(req(CMD)));
    void track(h.sched.enqueue(req(CMD2)));
    h.sched.onFrame(TRIGGER);
    assert.deepEqual(writeTimes(h), [0]);
    h.clock.advance(30);
    h.sched.onFrame(TRIGGER);
    h.clock.advance(30);
    assert.deepEqual(writeTimes(h), [0], 'window at 30 is discarded, not deferred');
    h.sched.onFrame(TRIGGER);
    assert.deepEqual(writeTimes(h), [0, 60]);
  });

  it('checks interFrameGapMs at the end of delayMs, not at the trigger', () => {
    const h = setup({ interFrameGapMs: 50, sendWindow: { kind: 'after-frame', delayMs: 10 } });
    void track(h.sched.enqueue(req(CMD)));
    void track(h.sched.enqueue(req(CMD2)));
    h.sched.onFrame(TRIGGER);
    h.clock.advance(10);
    assert.deepEqual(writeTimes(h), [10]);
    h.clock.advance(45); // t=55
    h.sched.onFrame(TRIGGER); // window at 65 -> gap 55 >= 50
    h.clock.advance(10);
    assert.deepEqual(writeTimes(h), [10, 65]);
  });

  // §4.4 20
  it('falls back to the idle rule after fallbackAfterMs without triggers', () => {
    const h = setup({ busIdleMs: 20, sendWindow: { kind: 'after-frame', opensWindow: notState, fallbackAfterMs: 1000 } });
    void track(h.sched.enqueue(req(CMD)));
    h.clock.advance(990);
    h.sched.onFrame(OTHER); // state frame: activity only
    h.clock.advance(10); // t=1000: fallback reached but bus busy until 1010
    assert.equal(h.writes.length, 0);
    h.clock.advance(9);
    assert.equal(h.writes.length, 0);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [1010]);
  });

  it('defaults fallbackAfterMs to 1000', () => {
    const h = setup({ busIdleMs: 0, sendWindow: { kind: 'after-frame' } });
    void track(h.sched.enqueue(req(CMD)));
    h.clock.advance(999);
    assert.equal(h.writes.length, 0);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [1000]);
  });

  // §4.4 21
  it('waits for a new window (or fallback) before retrying after a timeout', async () => {
    const h = setup({ interFrameGapMs: 0, sendWindow: { kind: 'after-frame', fallbackAfterMs: 1000 } });
    const t = track(h.sched.enqueue(req(CMD, { isAck: isAckFor(ACK), timeoutMs: 300, maxAttempts: 3 })));
    h.sched.onFrame(TRIGGER);
    h.clock.advance(400);
    assert.deepEqual(writeTimes(h), [0], 'no retry without a window');
    h.sched.onFrame(TRIGGER);
    assert.deepEqual(writeTimes(h), [0, 400]);
    h.clock.advance(300); // second timeout at 700; fallback for the 3rd attempt at 1700
    h.clock.advance(999);
    assert.deepEqual(writeTimes(h), [0, 400]);
    h.clock.advance(1);
    assert.deepEqual(writeTimes(h), [0, 400, 1700]);
    h.clock.advance(300);
    await flush();
    assert.ok(t.error instanceof TxTimeoutError);
    assert.equal(t.error.attempts, 3);
    assertIdle(h);
  });

  it('does not keep a window opened while no request was waiting', () => {
    const h = setup({ sendWindow: { kind: 'after-frame' } });
    h.sched.onFrame(TRIGGER);
    h.clock.advance(5);
    void track(h.sched.enqueue(req(CMD)));
    assert.equal(h.writes.length, 0);
  });
});
