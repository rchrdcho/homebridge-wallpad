// SPDX-License-Identifier: AGPL-3.0-only

import { sum8 } from '../../src/framing/checksum.js';
import type { FrameRule } from '../../src/framing/frame-rule.js';
import { startEndChecksumRule } from '../../src/framing/rules/start-end-checksum.js';
import { fromHex } from '../../src/util/hex.js';
import { SAMPLE_FRAMES } from '../fixtures/sample-daelim-2019.js';

/** Rule matching the public 2019 Daelim sample format: 15 bytes, F7 … sum8(1..13) AA. */
export function sampleRule(): FrameRule {
  return startEndChecksumRule({
    start: 0xf7, end: 0xaa, minLength: 15, maxLength: 15,
    validate: (f) => sum8(f, 1, f.length - 2) === f[f.length - 2],
  });
}

/** SAMPLE_FRAMES decoded to Buffers. */
export function sampleFrames(): Buffer[] {
  return SAMPLE_FRAMES.map((h) => fromHex(h));
}

/** Builds a valid sample-format frame from its 12 body bytes (indices 1..12). */
export function makeSampleFrame(body: Uint8Array): Buffer {
  if (body.length !== 12) {
    throw new RangeError('body must be 12 bytes');
  }
  const frame = Buffer.alloc(15);
  frame[0] = 0xf7;
  frame.set(body, 1);
  frame[13] = sum8(frame, 1, 13);
  frame[14] = 0xaa;
  return frame;
}
