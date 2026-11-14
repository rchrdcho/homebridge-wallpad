// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { sum8 } from '../../../src/framing/checksum.js';
import { startEndChecksumRule, type StartEndChecksumOptions } from '../../../src/framing/rules/start-end-checksum.js';
import { fromHex } from '../../../src/util/hex.js';
import { sampleFrames, sampleRule } from '../../helpers/sample-rule.js';

/** Variable-length test format: 02 LEN payload… SUM 03, LEN = total frame length, SUM = sum8(1..len-2). */
function varOptions(overrides: Partial<StartEndChecksumOptions> = {}): StartEndChecksumOptions {
  return {
    start: 0x02, end: 0x03, minLength: 4, maxLength: 8,
    validate: (f) => sum8(f, 1, f.length - 2) === f[f.length - 2],
    ...overrides,
  };
}

function varFrame(payload: number[]): Buffer {
  const len = payload.length + 4;
  const f = Buffer.from([0x02, len, ...payload, 0, 0x03]);
  f[len - 2] = sum8(f, 1, len - 2);
  return f;
}

describe('startEndChecksumRule', () => {
  describe('options validation', () => {
    const base = varOptions();
    const bad: [string, Partial<StartEndChecksumOptions>][] = [
      ['minLength > maxLength', { minLength: 9, maxLength: 8 }],
      ['start < 0', { start: -1 }],
      ['start > 255', { start: 256 }],
      ['start not an integer', { start: 1.5 }],
      ['end > 255', { end: 0x100 }],
      ['end < 0', { end: -1 }],
      ['minLength < 1', { minLength: 0 }],
      ['minLength < 2 with an end byte', { minLength: 1 }],
      ['maxLength not an integer', { maxLength: 7.5 }],
    ];
    for (const [name, o] of bad) {
      it(`throws RangeError when ${name}`, () => {
        assert.throws(() => startEndChecksumRule({ ...base, ...o }), RangeError);
      });
    }

    it('allows minLength 1 without an end byte', () => {
      assert.doesNotThrow(() => startEndChecksumRule({ ...base, end: undefined, minLength: 1 }));
    });

    it('exposes maxLength as maxFrameLength', () => {
      assert.equal(startEndChecksumRule(base).maxFrameLength, 8);
    });
  });

  describe('garbage before start', () => {
    it('skips up to the next start byte', () => {
      const r = sampleRule().match(fromHex('00 FF 13 F7 20'));
      assert.deepEqual(r, { kind: 'skip', count: 3, reason: 'garbage' });
    });

    it('skips the whole buffer when there is no start byte', () => {
      const r = sampleRule().match(fromHex('00 FF 13 AA'));
      assert.deepEqual(r, { kind: 'skip', count: 4, reason: 'garbage' });
    });

    it('returns need-more for an empty buffer', () => {
      assert.deepEqual(sampleRule().match(new Uint8Array(0)), { kind: 'need-more' });
    });
  });

  it('matches a complete sample frame', () => {
    for (const f of sampleFrames()) {
      assert.deepEqual(sampleRule().match(f), { kind: 'frame', length: 15 });
    }
  });

  it('matches only the first frame when more data follows', () => {
    const [a, b] = sampleFrames();
    assert.deepEqual(sampleRule().match(Buffer.concat([a, b.subarray(0, 4)])), { kind: 'frame', length: 15 });
  });

  it('returns need-more when the buffer is shorter than the candidate length', () => {
    const f = sampleFrames()[0];
    for (let n = 1; n < 15; n++) {
      assert.deepEqual(sampleRule().match(f.subarray(0, n)), { kind: 'need-more' }, `length ${n}`);
    }
  });

  it('skips 1 byte as garbage when the end byte does not match', () => {
    const f = Buffer.from(sampleFrames()[0]);
    f[14] = 0x00;
    assert.deepEqual(sampleRule().match(f), { kind: 'skip', count: 1, reason: 'garbage' });
  });

  it('skips 1 byte as checksum when the end byte matches but validation fails', () => {
    const f = Buffer.from(sampleFrames()[0]);
    f[13] ^= 0x01;
    assert.deepEqual(sampleRule().match(f), { kind: 'skip', count: 1, reason: 'checksum' });
  });

  it('does not call validate on candidates whose end byte does not match', () => {
    let calls = 0;
    const rule = startEndChecksumRule(varOptions({ validate: () => {
      calls++;
      return false;
    } }));
    rule.match(fromHex('02 06 01 01 01 03 01 01'));
    // only length 6 ends with 03
    assert.equal(calls, 1);
  });

  describe('variable length without hint', () => {
    it('tries candidates shortest first', () => {
      const f = varFrame([0x10]);
      const rule = startEndChecksumRule(varOptions());
      assert.deepEqual(rule.match(Buffer.concat([f, varFrame([1, 2, 3])])), { kind: 'frame', length: 5 });
    });

    it('does not cut at an end byte inside the body when the checksum does not match there', () => {
      // payload contains 03; frame length 7. Candidate length 4 ends in 03? build so index 3 is 03.
      const f = varFrame([0x11, 0x03, 0x22]);
      assert.equal(f[3], 0x03);
      const rule = startEndChecksumRule(varOptions());
      assert.deepEqual(rule.match(f), { kind: 'frame', length: 7 });
    });

    it('returns need-more while a longer candidate is still possible', () => {
      const f = varFrame([0x11, 0x03, 0x22]);
      const rule = startEndChecksumRule(varOptions());
      // the first 4 bytes end with 03 but fail validation; longer candidates need more data
      assert.deepEqual(rule.match(f.subarray(0, 5)), { kind: 'need-more' });
    });

    it('skips 1 once all candidates up to maxLength fail', () => {
      const rule = startEndChecksumRule(varOptions());
      assert.deepEqual(rule.match(fromHex('02 00 00 00 00 00 00 00 00')), { kind: 'skip', count: 1, reason: 'garbage' });
      assert.deepEqual(rule.match(fromHex('02 01 05 03 00 00 00 00 00')), { kind: 'skip', count: 1, reason: 'checksum' });
    });
  });

  describe('lengthHint', () => {
    const hinted = (o: Partial<StartEndChecksumOptions> = {}) =>
      startEndChecksumRule(varOptions({ lengthHint: (b) => (b.length >= 2 ? b[1] : null), ...o }));

    it('uses only the hinted length', () => {
      const f = varFrame([0x11, 0x03, 0x22]);
      assert.deepEqual(hinted().match(f), { kind: 'frame', length: 7 });
    });

    it('returns need-more until the hinted length is buffered', () => {
      const f = varFrame([0x11, 0x03, 0x22]);
      assert.deepEqual(hinted().match(f.subarray(0, 6)), { kind: 'need-more' });
    });

    it('skips 1 as checksum when the hinted frame fails validation', () => {
      const f = varFrame([0x11, 0x03, 0x22]);
      f[5] ^= 0xff;
      assert.deepEqual(hinted().match(f), { kind: 'skip', count: 1, reason: 'checksum' });
    });

    it('returns too-long when the hint exceeds maxLength', () => {
      assert.deepEqual(hinted().match(fromHex('02 09 00')), { kind: 'skip', count: 1, reason: 'too-long' });
    });

    it('skips 1 as garbage when the hint is below minLength or not an integer', () => {
      assert.deepEqual(hinted().match(fromHex('02 03 00')), { kind: 'skip', count: 1, reason: 'garbage' });
      assert.deepEqual(hinted({ lengthHint: () => 5.5 }).match(fromHex('02 03 00')), { kind: 'skip', count: 1, reason: 'garbage' });
    });

    it('falls back to all candidates when the hint returns null', () => {
      const f = varFrame([0x10]);
      assert.deepEqual(hinted({ lengthHint: () => null }).match(f), { kind: 'frame', length: 5 });
    });
  });

  describe('without end byte', () => {
    it('frames on length and validation alone', () => {
      const rule = startEndChecksumRule({
        start: 0x02, minLength: 3, maxLength: 3,
        validate: (f) => f[2] === sum8(f, 0, 2),
      });
      assert.deepEqual(rule.match(fromHex('02 05 07 99')), { kind: 'frame', length: 3 });
      assert.deepEqual(rule.match(fromHex('02 05 08 99')), { kind: 'skip', count: 1, reason: 'checksum' });
    });
  });

  it('does not modify the input buffer', () => {
    const f = Buffer.from(sampleFrames()[0]);
    const copy = Buffer.from(f);
    sampleRule().match(f);
    assert.deepEqual(f, copy);
  });
});
