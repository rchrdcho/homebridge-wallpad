// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sum8, xor8 } from '../../../src/framing/checksum.js';
import { sampleFrames } from '../../helpers/sample-rule.js';

describe('sum8', () => {
  it('sums [from, to) modulo 256', () => {
    assert.equal(sum8(Uint8Array.of(1, 2, 3, 4), 1, 3), 5);
    assert.equal(sum8(Uint8Array.of(0xff, 0x02), 0, 2), 0x01);
  });

  it('returns 0 for an empty range', () => {
    assert.equal(sum8(Uint8Array.of(9, 9), 1, 1), 0);
    assert.equal(sum8(new Uint8Array(0), 0, 0), 0);
  });

  it('matches the checksum byte of every sample frame (including the 0x101 carry case)', () => {
    for (const f of sampleFrames()) {
      assert.equal(sum8(f, 1, f.length - 2), f[f.length - 2]);
    }
  });

  it('handles long ranges that overflow many times', () => {
    assert.equal(sum8(new Uint8Array(1000).fill(0xff), 0, 1000), (0xff * 1000) & 0xff);
  });
});

describe('xor8', () => {
  it('xors [from, to)', () => {
    assert.equal(xor8(Uint8Array.of(0xf0, 0x0f, 0xff, 0x01), 0, 3), 0x00);
    assert.equal(xor8(Uint8Array.of(0xf0, 0x0f, 0xff, 0x01), 1, 4), 0xf1);
  });

  it('returns 0 for an empty range', () => {
    assert.equal(xor8(Uint8Array.of(9), 0, 0), 0);
  });
});

for (const [name, fn] of [['sum8', sum8], ['xor8', xor8]] as const) {
  describe(`${name} range validation`, () => {
    const bytes = Uint8Array.of(1, 2, 3);
    for (const [from, to] of [[-1, 2], [0, -1], [2, 1], [0, 4], [0.5, 2], [0, NaN]]) {
      it(`throws RangeError for [${from}, ${to})`, () => {
        assert.throws(() => fn(bytes, from, to), RangeError);
      });
    }
  });
}
