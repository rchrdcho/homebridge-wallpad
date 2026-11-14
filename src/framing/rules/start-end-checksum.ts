// SPDX-License-Identifier: AGPL-3.0-only

import type { FrameRule, MatchResult } from '../frame-rule.js';

export interface StartEndChecksumOptions {
  /** Start byte (0x00–0xFF). */
  start: number;
  /** End byte (0x00–0xFF). When omitted, frames are delimited by length and `validate` only. */
  end?: number;
  /** Minimum frame length, including start and end bytes. */
  minLength: number;
  /** Maximum frame length, including start and end bytes. */
  maxLength: number;
  /** Receives a whole candidate frame (start..end inclusive) and decides whether it is valid. */
  validate(frame: Uint8Array): boolean;
  /**
   * Narrows the candidate to one length (e.g. read from a header). Return `null` to try every length in
   * `minLength..maxLength`. A hint above `maxLength` yields `too-long`; one below `minLength` or non-integer
   * is treated as a false start (`garbage`).
   */
  lengthHint?(buf: Uint8Array): number | null;
}

const NEED_MORE: MatchResult = Object.freeze({ kind: 'need-more' });

function checkByte(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`startEndChecksumRule: ${name} must be an integer in 0..255, got ${value}`);
  }
}

/**
 * Generic rule for "start byte … checksum … [end byte]" formats. A candidate is accepted only when its end byte
 * (if any) matches and `validate` passes, so an end-byte value inside the body never truncates a frame.
 */
export function startEndChecksumRule(opts: StartEndChecksumOptions): FrameRule {
  const { start, end, minLength, maxLength, validate, lengthHint } = opts;
  checkByte('start', start);
  if (end !== undefined) {
    checkByte('end', end);
  }
  const minAllowed = end === undefined ? 1 : 2;
  if (!Number.isInteger(minLength) || minLength < minAllowed) {
    throw new RangeError(`startEndChecksumRule: minLength must be an integer >= ${minAllowed}, got ${minLength}`);
  }
  if (!Number.isInteger(maxLength) || maxLength < minLength) {
    throw new RangeError(`startEndChecksumRule: maxLength must be an integer >= minLength, got ${maxLength}`);
  }

  return {
    maxFrameLength: maxLength,
    match(buf: Uint8Array): MatchResult {
      if (buf.length === 0) {
        return NEED_MORE;
      }
      if (buf[0] !== start) {
        const next = buf.indexOf(start, 1);
        return { kind: 'skip', count: next === -1 ? buf.length : next, reason: 'garbage' };
      }

      let from = minLength;
      let to = maxLength;
      const hint = lengthHint?.(buf) ?? null;
      if (hint !== null) {
        if (hint > maxLength) {
          return { kind: 'skip', count: 1, reason: 'too-long' };
        }
        if (!Number.isInteger(hint) || hint < minLength) {
          return { kind: 'skip', count: 1, reason: 'garbage' };
        }
        from = to = hint;
      }

      let endMatched = false;
      for (let len = from; len <= to; len++) {
        if (len > buf.length) {
          return NEED_MORE;
        }
        if (end !== undefined && buf[len - 1] !== end) {
          continue;
        }
        endMatched = true;
        if (validate(buf.subarray(0, len))) {
          return { kind: 'frame', length: len };
        }
      }
      return { kind: 'skip', count: 1, reason: endMatched ? 'checksum' : 'garbage' };
    },
  };
}
