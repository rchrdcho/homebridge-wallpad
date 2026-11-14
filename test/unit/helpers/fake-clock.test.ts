// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { FakeClock } from '../../helpers/fake-clock.js';

describe('FakeClock', () => {
  it('starts at the given time (default 0)', () => {
    assert.equal(new FakeClock().now(), 0);
    assert.equal(new FakeClock(1000).now(), 1000);
  });

  it('advance() moves time forward', () => {
    const clock = new FakeClock();
    clock.advance(25);
    assert.equal(clock.now(), 25);
  });

  it('does not run timers before they are due', () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 10);
    clock.advance(9);
    assert.equal(fired, false);
    clock.advance(1);
    assert.equal(fired, true);
  });

  it('runs due timers in expiry order with now() set to each expiry time', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    clock.setTimeout(() => log.push(`b@${clock.now()}`), 20);
    clock.setTimeout(() => log.push(`a@${clock.now()}`), 10);
    clock.setTimeout(() => log.push(`c@${clock.now()}`), 30);
    clock.advance(100);
    assert.deepEqual(log, ['a@10', 'b@20', 'c@30']);
    assert.equal(clock.now(), 100);
  });

  it('runs timers with the same expiry in registration order', () => {
    const clock = new FakeClock();
    const log: number[] = [];
    clock.setTimeout(() => log.push(1), 5);
    clock.setTimeout(() => log.push(2), 5);
    clock.setTimeout(() => log.push(3), 5);
    clock.advance(5);
    assert.deepEqual(log, [1, 2, 3]);
  });

  it('runs timers registered by callbacks within the same advance()', () => {
    const clock = new FakeClock();
    const log: string[] = [];
    clock.setTimeout(() => {
      log.push(`outer@${clock.now()}`);
      clock.setTimeout(() => log.push(`inner@${clock.now()}`), 15);
      clock.setTimeout(() => log.push(`late@${clock.now()}`), 100);
    }, 10);
    clock.advance(50);
    assert.deepEqual(log, ['outer@10', 'inner@25']);
    assert.equal(clock.pendingCount(), 1);
  });

  it('advance(0) runs zero-delay timers', () => {
    const clock = new FakeClock();
    let fired = false;
    clock.setTimeout(() => {
      fired = true;
    }, 0);
    clock.advance(0);
    assert.equal(fired, true);
  });

  it('clearTimeout() cancels a pending timer', () => {
    const clock = new FakeClock();
    let fired = false;
    const handle = clock.setTimeout(() => {
      fired = true;
    }, 10);
    clock.clearTimeout(handle);
    clock.advance(20);
    assert.equal(fired, false);
    assert.equal(clock.pendingCount(), 0);
  });

  it('clearTimeout() from inside a callback cancels a timer due in the same advance()', () => {
    const clock = new FakeClock();
    let fired = false;
    const later = clock.setTimeout(() => {
      fired = true;
    }, 20);
    clock.setTimeout(() => clock.clearTimeout(later), 10);
    clock.advance(30);
    assert.equal(fired, false);
  });

  it('clearTimeout() ignores unknown handles', () => {
    const clock = new FakeClock();
    clock.clearTimeout(undefined);
    clock.clearTimeout(12345);
    assert.equal(clock.pendingCount(), 0);
  });

  it('pendingCount() reports outstanding timers', () => {
    const clock = new FakeClock();
    clock.setTimeout(() => undefined, 10);
    clock.setTimeout(() => undefined, 20);
    assert.equal(clock.pendingCount(), 2);
    clock.advance(10);
    assert.equal(clock.pendingCount(), 1);
    clock.advance(10);
    assert.equal(clock.pendingCount(), 0);
  });

  it('rejects negative advance()', () => {
    assert.throws(() => new FakeClock().advance(-1), RangeError);
  });
});
