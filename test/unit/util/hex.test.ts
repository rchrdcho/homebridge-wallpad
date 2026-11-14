// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fromHex, toHex } from '../../../src/util/hex.js';

describe('toHex', () => {
  it('formats bytes as upper-case 2-digit hex separated by a space', () => {
    assert.equal(toHex(Uint8Array.of(0xf7, 0x20, 0x01, 0x0a)), 'F7 20 01 0A');
  });

  it('uses a custom separator', () => {
    assert.equal(toHex(Uint8Array.of(0xf7, 0x20), ':'), 'F7:20');
    assert.equal(toHex(Uint8Array.of(0xf7, 0x20), ''), 'F720');
  });

  it('returns an empty string for empty input', () => {
    assert.equal(toHex(new Uint8Array(0)), '');
  });

  it('accepts a Buffer', () => {
    assert.equal(toHex(Buffer.from([0x00, 0xff])), '00 FF');
  });
});

describe('fromHex', () => {
  it('parses space-separated hex', () => {
    assert.deepEqual(fromHex('F7 20 01'), Buffer.from([0xf7, 0x20, 0x01]));
  });

  it('returns a Buffer', () => {
    assert.ok(Buffer.isBuffer(fromHex('00')));
  });

  it('ignores mixed separators and is case-insensitive', () => {
    assert.deepEqual(fromHex('f7:20-01 aa'), Buffer.from([0xf7, 0x20, 0x01, 0xaa]));
    assert.deepEqual(fromHex('F720aA'), Buffer.from([0xf7, 0x20, 0xaa]));
  });

  it('returns an empty Buffer for empty or separator-only input', () => {
    assert.equal(fromHex('').length, 0);
    assert.equal(fromHex(' :- ').length, 0);
  });

  it('round-trips with toHex', () => {
    const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    assert.deepEqual(fromHex(toHex(bytes)), bytes);
    assert.deepEqual(fromHex(toHex(bytes, '')), bytes);
  });

  it('throws RangeError on an odd number of hex digits', () => {
    assert.throws(() => fromHex('F7 2'), RangeError);
    assert.throws(() => fromHex('A'), RangeError);
  });

  it('throws RangeError on non-hex characters', () => {
    assert.throws(() => fromHex('F7 G0'), RangeError);
    assert.throws(() => fromHex('0x20'), RangeError);
    assert.throws(() => fromHex('F7,20'), RangeError);
  });
});
