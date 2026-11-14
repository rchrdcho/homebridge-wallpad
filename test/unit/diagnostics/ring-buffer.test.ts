// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { RingBuffer } from '../../../src/diagnostics/ring-buffer.js';

function filled(capacity: number, count: number): RingBuffer<number> {
  const rb = new RingBuffer<number>(capacity);
  for (let i = 1; i <= count; i++) {
    rb.push(i);
  }
  return rb;
}

describe('RingBuffer', () => {
  describe('constructor', () => {
    for (const bad of [0, -1, 1.5, NaN, Infinity]) {
      it(`throws RangeError for capacity ${bad}`, () => {
        assert.throws(() => new RingBuffer(bad), RangeError);
      });
    }

    it('accepts capacity 1 and exposes capacity', () => {
      const rb = new RingBuffer<string>(1);
      assert.equal(rb.capacity, 1);
      assert.equal(rb.size, 0);
    });
  });

  it('is empty initially', () => {
    const rb = new RingBuffer<number>(3);
    assert.deepEqual(rb.toArray(), []);
    assert.deepEqual(rb.latest(2), []);
  });

  it('keeps insertion order below capacity', () => {
    const rb = filled(5, 3);
    assert.equal(rb.size, 3);
    assert.deepEqual(rb.toArray(), [1, 2, 3]);
  });

  it('holds exactly capacity items when filled exactly', () => {
    const rb = filled(4, 4);
    assert.equal(rb.size, 4);
    assert.deepEqual(rb.toArray(), [1, 2, 3, 4]);
  });

  it('overwrites the oldest item when over capacity', () => {
    const rb = filled(4, 5);
    assert.equal(rb.size, 4);
    assert.deepEqual(rb.toArray(), [2, 3, 4, 5]);
  });

  it('stays correct after wrapping around several times', () => {
    const rb = filled(3, 10);
    assert.equal(rb.size, 3);
    assert.deepEqual(rb.toArray(), [8, 9, 10]);
  });

  it('works with capacity 1', () => {
    const rb = filled(1, 7);
    assert.equal(rb.size, 1);
    assert.deepEqual(rb.toArray(), [7]);
  });

  describe('latest()', () => {
    it('returns the newest n items oldest-first', () => {
      assert.deepEqual(filled(5, 4).latest(2), [3, 4]);
    });

    it('returns the newest n items after wrapping', () => {
      assert.deepEqual(filled(3, 8).latest(2), [7, 8]);
    });

    it('returns [] for n = 0', () => {
      assert.deepEqual(filled(3, 3).latest(0), []);
    });

    it('returns all items when n > size', () => {
      assert.deepEqual(filled(5, 2).latest(10), [1, 2]);
    });

    it('returns [] for negative n', () => {
      assert.deepEqual(filled(5, 2).latest(-1), []);
    });

    it('returns [] for NaN', () => {
      assert.deepEqual(filled(5, 2).latest(NaN), []);
    });
  });

  it('can be reused after clear()', () => {
    const rb = filled(3, 5);
    rb.clear();
    assert.equal(rb.size, 0);
    assert.deepEqual(rb.toArray(), []);
    rb.push(42);
    rb.push(43);
    assert.deepEqual(rb.toArray(), [42, 43]);
    rb.push(44);
    rb.push(45);
    assert.deepEqual(rb.toArray(), [43, 44, 45]);
  });

  it('returns a new array that does not alias internal state', () => {
    const rb = filled(3, 2);
    const arr = rb.toArray();
    arr.push(99);
    arr[0] = -1;
    assert.deepEqual(rb.toArray(), [1, 2]);
    const last = rb.latest(1);
    last[0] = -1;
    assert.deepEqual(rb.latest(1), [2]);
  });
});
