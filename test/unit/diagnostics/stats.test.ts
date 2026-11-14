// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Stats } from '../../../src/diagnostics/stats.js';
import { FakeClock } from '../../helpers/fake-clock.js';

describe('Stats', () => {
  it('starts with zero counters, null timestamps and since = now', () => {
    const clock = new FakeClock(500);
    const s = new Stats(clock).snapshot();
    assert.deepEqual(s, {
      rxBytes: 0,
      rxFrames: 0,
      rxDropped: { checksum: 0, garbage: 0, overflow: 0, 'too-long': 0 },
      rxDroppedBytes: { checksum: 0, garbage: 0, overflow: 0, 'too-long': 0 },
      txFrames: 0,
      txRetries: 0,
      txSucceeded: 0,
      txFailed: 0,
      connects: 0,
      disconnects: 0,
      lastRxAt: null,
      lastTxAt: null,
      since: 500,
    });
  });

  it('onRxBytes() accumulates bytes and updates lastRxAt', () => {
    const clock = new FakeClock(100);
    const stats = new Stats(clock);
    stats.onRxBytes(10);
    clock.advance(20);
    stats.onRxBytes(5);
    const s = stats.snapshot();
    assert.equal(s.rxBytes, 15);
    assert.equal(s.lastRxAt, 120);
  });

  it('onRxFrame() counts frames without touching lastRxAt', () => {
    const stats = new Stats(new FakeClock(100));
    stats.onRxFrame();
    stats.onRxFrame();
    const s = stats.snapshot();
    assert.equal(s.rxFrames, 2);
    assert.equal(s.lastRxAt, null);
  });

  it('onRxDrop() counts occurrences and bytes per reason', () => {
    const stats = new Stats(new FakeClock());
    stats.onRxDrop('checksum', 15);
    stats.onRxDrop('checksum', 1);
    stats.onRxDrop('garbage', 3);
    stats.onRxDrop('overflow', 60);
    stats.onRxDrop('too-long', 1);
    const s = stats.snapshot();
    assert.deepEqual(s.rxDropped, { checksum: 2, garbage: 1, overflow: 1, 'too-long': 1 });
    assert.deepEqual(s.rxDroppedBytes, { checksum: 16, garbage: 3, overflow: 60, 'too-long': 1 });
  });

  it('onTx() counts every write, counts retries separately, and updates lastTxAt', () => {
    const clock = new FakeClock(0);
    const stats = new Stats(clock);
    clock.advance(10);
    stats.onTx(false);
    clock.advance(10);
    stats.onTx(true);
    stats.onTx(true);
    const s = stats.snapshot();
    assert.equal(s.txFrames, 3);
    assert.equal(s.txRetries, 2);
    assert.equal(s.lastTxAt, 20);
  });

  it('onTxResult() counts successes and failures', () => {
    const stats = new Stats(new FakeClock());
    stats.onTxResult(true);
    stats.onTxResult(true);
    stats.onTxResult(false);
    const s = stats.snapshot();
    assert.equal(s.txSucceeded, 2);
    assert.equal(s.txFailed, 1);
  });

  it('onConnect() / onDisconnect() count connection events', () => {
    const stats = new Stats(new FakeClock());
    stats.onConnect();
    stats.onDisconnect();
    stats.onConnect();
    const s = stats.snapshot();
    assert.equal(s.connects, 2);
    assert.equal(s.disconnects, 1);
  });

  it('snapshot() is frozen, including nested records', () => {
    const s = new Stats(new FakeClock()).snapshot();
    assert.ok(Object.isFrozen(s));
    assert.ok(Object.isFrozen(s.rxDropped));
    assert.ok(Object.isFrozen(s.rxDroppedBytes));
  });

  it('snapshot() is not affected by later updates', () => {
    const stats = new Stats(new FakeClock());
    stats.onRxDrop('garbage', 2);
    stats.onRxBytes(4);
    const before = stats.snapshot();
    stats.onRxDrop('garbage', 2);
    stats.onRxBytes(4);
    assert.equal(before.rxBytes, 4);
    assert.equal(before.rxDropped.garbage, 1);
    assert.equal(before.rxDroppedBytes.garbage, 2);
  });

  it('reset() zeroes everything and moves since to now', () => {
    const clock = new FakeClock(0);
    const stats = new Stats(clock);
    stats.onRxBytes(1);
    stats.onRxFrame();
    stats.onRxDrop('checksum', 1);
    stats.onTx(true);
    stats.onTxResult(false);
    stats.onConnect();
    stats.onDisconnect();
    clock.advance(1234);
    stats.reset();
    assert.deepEqual(stats.snapshot(), new Stats(clock).snapshot());
    assert.equal(stats.snapshot().since, 1234);
  });
});
