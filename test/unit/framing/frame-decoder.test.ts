// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { DropReason } from '../../../src/diagnostics/stats.js';
import { FrameDecoder, type FrameDecoderOptions } from '../../../src/framing/frame-decoder.js';
import type { FrameRule, MatchResult } from '../../../src/framing/frame-rule.js';
import { fromHex, toHex } from '../../../src/util/hex.js';
import { randomChunks } from '../../helpers/prng.js';
import { makeSampleFrame, sampleFrames, sampleRule } from '../../helpers/sample-rule.js';

interface Harness {
  decoder: FrameDecoder;
  frames: Buffer[];
  drops: { reason: DropReason; bytes: Buffer }[];
}

function harness(overrides: Partial<FrameDecoderOptions> = {}): Harness {
  const frames: Buffer[] = [];
  const drops: { reason: DropReason; bytes: Buffer }[] = [];
  const decoder = new FrameDecoder({
    rule: sampleRule(),
    onFrame: (f) => frames.push(f),
    onDrop: (reason, bytes) => drops.push({ reason, bytes }),
    ...overrides,
  });
  return { decoder, frames, drops };
}

const hexes = (bufs: Buffer[]) => bufs.map((b) => toHex(b));

/** Rule with fixed scripted results, for engine-contract tests. */
function scriptedRule(result: MatchResult, maxFrameLength = 4): FrameRule {
  return { maxFrameLength, match: () => result };
}

describe('FrameDecoder', () => {
  const [A, B, C] = sampleFrames();

  // §3.6 1
  it('emits one frame pushed in a single chunk', () => {
    const h = harness();
    h.decoder.push(A);
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
    assert.deepEqual(h.drops, []);
    assert.equal(h.decoder.buffered, 0);
  });

  // §3.6 2
  it('emits the frame only on the last of 15 single-byte pushes', () => {
    const h = harness();
    for (let i = 0; i < A.length; i++) {
      h.decoder.push(A.subarray(i, i + 1));
      assert.equal(h.frames.length, i === A.length - 1 ? 1 : 0, `after byte ${i}`);
    }
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
    assert.deepEqual(h.drops, []);
  });

  // §3.6 3
  it('emits one frame for every two-chunk split point', () => {
    for (let cut = 1; cut < A.length; cut++) {
      const h = harness();
      h.decoder.push(A.subarray(0, cut));
      h.decoder.push(A.subarray(cut));
      assert.deepEqual(hexes(h.frames), [toHex(A)], `cut at ${cut}`);
      assert.deepEqual(h.drops, [], `cut at ${cut}`);
    }
  });

  // §3.6 4
  it('emits three concatenated frames in order', () => {
    const h = harness();
    h.decoder.push(Buffer.concat([A, B, C]));
    assert.deepEqual(hexes(h.frames), hexes([A, B, C]));
  });

  // §3.6 5
  it('emits the same three frames for random chunkings (several seeds)', () => {
    const stream = Buffer.concat([A, B, C]);
    for (const seed of [1, 2, 3, 42, 1234, 99999]) {
      for (const maxChunk of [3, 7, 20]) {
        const h = harness();
        for (const chunk of randomChunks(stream, seed, maxChunk)) {
          h.decoder.push(chunk);
        }
        assert.deepEqual(hexes(h.frames), hexes([A, B, C]), `seed ${seed} maxChunk ${maxChunk}`);
        assert.deepEqual(h.drops, []);
      }
    }
  });

  // §3.6 6
  it('drops leading garbage as one 3-byte garbage drop', () => {
    const h = harness();
    h.decoder.push(Buffer.concat([fromHex('00 FF 13'), A]));
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
    assert.equal(h.drops.length, 1);
    assert.equal(h.drops[0].reason, 'garbage');
    assert.equal(toHex(h.drops[0].bytes), '00 FF 13');
  });

  // §3.6 7
  it('resynchronizes when reception starts mid-frame', () => {
    const h = harness();
    h.decoder.push(Buffer.concat([A.subarray(7), B]));
    assert.deepEqual(hexes(h.frames), [toHex(B)]);
    const dropped = h.drops.reduce((n, d) => n + d.bytes.length, 0);
    assert.equal(dropped, A.length - 7);
  });

  // §3.6 8
  it('drops a frame with a corrupted checksum and keeps the next one', () => {
    const bad = Buffer.from(A);
    bad[13] ^= 0x01;
    const h = harness();
    h.decoder.push(Buffer.concat([bad, B]));
    assert.deepEqual(hexes(h.frames), [toHex(B)]);
    assert.ok(h.drops.some((d) => d.reason === 'checksum'));
    const dropped = h.drops.reduce((n, d) => n + d.bytes.length, 0);
    assert.equal(dropped, bad.length);
  });

  // §3.6 9
  it('recovers from a bogus frame with AA and F7 in its body', () => {
    const bogus = fromHex('F7 20 AA F7 11 00 AA 00 00 F7 00 00 00 99 AA');
    assert.notEqual(bogus[13], 0); // checksum is wrong on purpose
    const h = harness();
    h.decoder.push(Buffer.concat([bogus, B]));
    assert.deepEqual(hexes(h.frames), [toHex(B)]);
    const dropped = h.drops.reduce((n, d) => n + d.bytes.length, 0);
    assert.equal(dropped, bogus.length);
  });

  it('recovers from the bogus frame regardless of chunking', () => {
    const bogus = fromHex('F7 20 AA F7 11 00 AA 00 00 F7 00 00 00 99 AA');
    const stream = Buffer.concat([bogus, B, C]);
    for (const seed of [5, 6, 7]) {
      const h = harness();
      for (const chunk of randomChunks(stream, seed, 4)) {
        h.decoder.push(chunk);
      }
      assert.deepEqual(hexes(h.frames), hexes([B, C]), `seed ${seed}`);
    }
  });

  // §3.6 10
  it('does not split a valid frame at an AA inside its body', () => {
    const withAA = makeSampleFrame(fromHex('20 21 01 AA AA 00 00 00 00 00 00 00'));
    assert.equal(withAA[4], 0xaa);
    const h = harness();
    h.decoder.push(Buffer.concat([withAA, A]));
    assert.deepEqual(hexes(h.frames), hexes([withAA, A]));
    assert.deepEqual(h.drops, []);
  });

  // §3.6 11
  it('reset() discards a half frame without a drop event', () => {
    const h = harness();
    h.decoder.push(A.subarray(0, 7));
    assert.equal(h.decoder.buffered, 7);
    h.decoder.reset();
    assert.equal(h.decoder.buffered, 0);
    h.decoder.push(B);
    assert.deepEqual(hexes(h.frames), [toHex(B)]);
    assert.deepEqual(h.drops, []);
  });

  // §3.6 12
  it('keeps memory bounded on an endless stream of start bytes', () => {
    const h = harness();
    const maxBuffer = 15 * 4;
    for (let i = 0; i < 15 * 10; i++) {
      h.decoder.push(Uint8Array.of(0xf7));
      assert.ok(h.decoder.buffered <= maxBuffer, `buffered ${h.decoder.buffered} at ${i}`);
    }
    h.decoder.push(Buffer.alloc(15 * 10, 0xf7));
    assert.ok(h.decoder.buffered <= maxBuffer);
    assert.equal(h.frames.length, 0);
    h.decoder.push(A);
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
  });

  // §3.6 13
  it('emits copies: mutating an emitted frame does not affect later frames', () => {
    const frames: Buffer[] = [];
    const decoder = new FrameDecoder({
      rule: sampleRule(),
      onFrame: (f) => {
        frames.push(Buffer.from(f));
        f.fill(0);
      },
    });
    decoder.push(Buffer.concat([A, B]));
    assert.deepEqual(hexes(frames), hexes([A, B]));
  });

  it('copies input: mutating a pushed chunk later does not affect decoding', () => {
    const h = harness();
    const chunk = Buffer.from(A.subarray(0, 10));
    h.decoder.push(chunk);
    chunk.fill(0);
    h.decoder.push(A.subarray(10));
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
  });

  it('emits drops as copies', () => {
    const h = harness();
    h.decoder.push(fromHex('00 01'));
    const dropped = h.drops[0].bytes;
    dropped.fill(0xee);
    h.decoder.push(A);
    assert.deepEqual(hexes(h.frames), [toHex(A)]);
  });

  // §3.6 14
  it('throws instead of looping forever when a rule returns skip count 0', () => {
    const h = harness({ rule: scriptedRule({ kind: 'skip', count: 0, reason: 'garbage' }) });
    assert.throws(() => h.decoder.push(fromHex('01 02')), RangeError);
  });

  it('throws when a rule returns an out-of-range frame length', () => {
    for (const length of [0, 3, 1.5]) {
      const h = harness({ rule: scriptedRule({ kind: 'frame', length }) });
      assert.throws(() => h.decoder.push(fromHex('01 02')), RangeError, `length ${length}`);
    }
  });

  it('throws when a rule skips more bytes than are buffered', () => {
    const h = harness({ rule: scriptedRule({ kind: 'skip', count: 3, reason: 'garbage' }) });
    assert.throws(() => h.decoder.push(fromHex('01 02')), RangeError);
  });

  describe('overflow', () => {
    it('defaults maxBufferLength to rule.maxFrameLength * 4', () => {
      const h = harness({ rule: scriptedRule({ kind: 'need-more' }, 5) });
      h.decoder.push(Buffer.alloc(21, 1));
      assert.equal(h.decoder.buffered, 20);
      assert.equal(h.drops.length, 1);
      assert.equal(h.drops[0].reason, 'overflow');
      assert.equal(h.drops[0].bytes.length, 1);
    });

    it('drops the oldest bytes beyond maxBufferLength', () => {
      const h = harness({ rule: scriptedRule({ kind: 'need-more' }), maxBufferLength: 6 });
      h.decoder.push(fromHex('01 02 03 04'));
      h.decoder.push(fromHex('05 06 07 08 09'));
      assert.equal(h.decoder.buffered, 6);
      assert.deepEqual(h.drops.map((d) => [d.reason, toHex(d.bytes)]), [['overflow', '01 02 03']]);
    });

    it('rejects a maxBufferLength smaller than rule.maxFrameLength', () => {
      assert.throws(() => harness({ maxBufferLength: 14 }), RangeError);
      assert.throws(() => harness({ maxBufferLength: 15.5 }), RangeError);
    });

    it('rejects a rule with an invalid maxFrameLength', () => {
      assert.throws(() => harness({ rule: scriptedRule({ kind: 'need-more' }, 0) }), RangeError);
    });
  });

  describe('callback exceptions', () => {
    it('propagates an onFrame exception after removing the emitted frame from the buffer', () => {
      let calls = 0;
      const frames: Buffer[] = [];
      const decoder = new FrameDecoder({
        rule: sampleRule(),
        onFrame: (f) => {
          calls++;
          if (calls === 1) {
            throw new Error('boom');
          }
          frames.push(f);
        },
      });
      assert.throws(() => decoder.push(Buffer.concat([A, B])), /boom/);
      assert.equal(decoder.buffered, B.length);
      decoder.push(new Uint8Array(0));
      assert.deepEqual(hexes(frames), [toHex(B)]);
      assert.equal(decoder.buffered, 0);
    });

    it('propagates an onDrop exception after removing the dropped bytes', () => {
      const frames: Buffer[] = [];
      const decoder = new FrameDecoder({
        rule: sampleRule(),
        onFrame: (f) => frames.push(f),
        onDrop: () => {
          throw new Error('drop-boom');
        },
      });
      assert.throws(() => decoder.push(Buffer.concat([fromHex('00 01'), A])), /drop-boom/);
      assert.equal(decoder.buffered, A.length);
      decoder.push(new Uint8Array(0));
      assert.deepEqual(hexes(frames), [toHex(A)]);
    });
  });

  it('handles push() re-entered from onFrame without losing or duplicating frames', () => {
    const frames: Buffer[] = [];
    let reentered = false;
    const decoder = new FrameDecoder({
      rule: sampleRule(),
      onFrame: (f) => {
        frames.push(f);
        if (!reentered) {
          reentered = true;
          decoder.push(C);
        }
      },
    });
    decoder.push(Buffer.concat([A, B]));
    assert.deepEqual(hexes(frames), hexes([A, B, C]));
    assert.equal(decoder.buffered, 0);
  });

  it('works without onDrop', () => {
    const frames: Buffer[] = [];
    const decoder = new FrameDecoder({ rule: sampleRule(), onFrame: (f) => frames.push(f) });
    decoder.push(Buffer.concat([fromHex('00 01'), A]));
    assert.deepEqual(hexes(frames), [toHex(A)]);
  });
});
