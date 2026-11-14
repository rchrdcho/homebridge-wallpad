// SPDX-License-Identifier: AGPL-3.0-only

/** Outcome of {@link FrameRule.match} for the bytes at the front of the decoder buffer. */
export type MatchResult =
  /** `buf[0..length)` is one complete, valid frame. */
  | { readonly kind: 'frame'; readonly length: number }
  /** More bytes are needed before a decision can be made. */
  | { readonly kind: 'need-more' }
  /** The first `count` (>= 1) bytes are not part of a frame and should be discarded. */
  | {
      readonly kind: 'skip';
      readonly count: number;
      readonly reason: 'garbage' | 'checksum' | 'too-long';
    };

/**
 * Vendor-specific, stateless framing rule: decides whether one frame can be taken from the front of a buffer.
 */
export interface FrameRule {
  /** Largest possible frame length. Used by the decoder to bound its buffer. */
  readonly maxFrameLength: number;
  /** Inspects the decoder's pending bytes. Must not modify `buf` and must be deterministic. */
  match(buf: Uint8Array): MatchResult;
}
