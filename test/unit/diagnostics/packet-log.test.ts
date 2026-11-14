// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { PacketLog } from '../../../src/diagnostics/packet-log.js';
import { FakeClock } from '../../helpers/fake-clock.js';

describe('PacketLog', () => {
  it('throws RangeError for an invalid capacity', () => {
    assert.throws(() => new PacketLog(0, new FakeClock()), RangeError);
  });

  it('records direction, bytes, note and the clock time', () => {
    const clock = new FakeClock(1000);
    const log = new PacketLog(10, clock);
    log.record('rx', Uint8Array.of(0xf7, 0x20));
    clock.advance(5);
    log.record('tx', Buffer.from([0xaa]), 'retry 2/3');

    const entries = log.entries();
    assert.equal(entries.length, 2);
    assert.equal(entries[0].at, 1000);
    assert.equal(entries[0].direction, 'rx');
    assert.deepEqual(entries[0].bytes, Buffer.from([0xf7, 0x20]));
    assert.equal(entries[0].note, undefined);
    assert.equal(entries[1].at, 1005);
    assert.equal(entries[1].direction, 'tx');
    assert.deepEqual(entries[1].bytes, Buffer.from([0xaa]));
    assert.equal(entries[1].note, 'retry 2/3');
  });

  it('stores bytes as a Buffer even when given a plain Uint8Array', () => {
    const log = new PacketLog(2, new FakeClock());
    log.record('rx', Uint8Array.of(1, 2, 3));
    assert.ok(Buffer.isBuffer(log.entries()[0].bytes));
  });

  it('copies bytes so later caller mutations do not change the log', () => {
    const log = new PacketLog(2, new FakeClock());
    const input = Buffer.from([1, 2, 3]);
    log.record('rx', input);
    input[0] = 0xff;
    assert.deepEqual(log.entries()[0].bytes, Buffer.from([1, 2, 3]));
  });

  it('copies bytes from a subarray view', () => {
    const log = new PacketLog(2, new FakeClock());
    const parent = Buffer.from([9, 1, 2, 9]);
    log.record('rx', parent.subarray(1, 3));
    parent.fill(0);
    assert.deepEqual(log.entries()[0].bytes, Buffer.from([1, 2]));
  });

  it('keeps only the newest capacity entries', () => {
    const log = new PacketLog(2, new FakeClock());
    log.record('rx', Uint8Array.of(1));
    log.record('rx', Uint8Array.of(2));
    log.record('rx', Uint8Array.of(3));
    assert.deepEqual(log.entries().map((e) => e.bytes[0]), [2, 3]);
  });

  it('entries() returns a snapshot that is not affected by later records', () => {
    const log = new PacketLog(5, new FakeClock());
    log.record('rx', Uint8Array.of(1));
    const snapshot = log.entries();
    log.record('rx', Uint8Array.of(2));
    assert.equal(snapshot.length, 1);
  });

  it('clear() empties the log', () => {
    const log = new PacketLog(5, new FakeClock());
    log.record('rx', Uint8Array.of(1));
    log.clear();
    assert.deepEqual(log.entries(), []);
    log.record('tx', Uint8Array.of(2));
    assert.equal(log.entries().length, 1);
  });
});
