// SPDX-License-Identifier: AGPL-3.0-only

import type { DropReason } from '../diagnostics/stats.js';
import type { FrameRule } from './frame-rule.js';

export interface FrameDecoderOptions {
  rule: FrameRule;
  /** Upper bound for pending bytes. Default: `rule.maxFrameLength * 4`. */
  maxBufferLength?: number;
  /** Receives each validated frame as a private copy. */
  onFrame(frame: Buffer): void;
  /** Receives discarded bytes (as a private copy) and the reason. */
  onDrop?(reason: DropReason, bytes: Buffer): void;
}

const EMPTY = Buffer.alloc(0);

/**
 * Turns an arbitrarily fragmented byte stream into validated frames using a pluggable {@link FrameRule},
 * resynchronizing after garbage or corrupted data.
 */
export class FrameDecoder {
  private readonly rule: FrameRule;
  private readonly maxBufferLength: number;
  private readonly onFrame: (frame: Buffer) => void;
  private readonly onDrop?: (reason: DropReason, bytes: Buffer) => void;
  /** Pending bytes. Always owned by the decoder (never aliases caller memory). */
  private pending: Buffer = EMPTY;

  constructor(options: FrameDecoderOptions) {
    const { rule } = options;
    if (!Number.isInteger(rule.maxFrameLength) || rule.maxFrameLength < 1) {
      throw new RangeError(`FrameDecoder: rule.maxFrameLength must be an integer >= 1, got ${rule.maxFrameLength}`);
    }
    const maxBufferLength = options.maxBufferLength ?? rule.maxFrameLength * 4;
    if (!Number.isInteger(maxBufferLength) || maxBufferLength < rule.maxFrameLength) {
      throw new RangeError(`FrameDecoder: maxBufferLength must be an integer >= rule.maxFrameLength, got ${maxBufferLength}`);
    }
    this.rule = rule;
    this.maxBufferLength = maxBufferLength;
    this.onFrame = options.onFrame;
    this.onDrop = options.onDrop;
  }

  /** Number of bytes currently buffered (for diagnostics). */
  get buffered(): number {
    return this.pending.length;
  }

  /**
   * Appends a chunk and emits every frame and drop it completes. Exceptions thrown by callbacks propagate;
   * bytes handled up to that point are already removed, and the rest is processed on the next `push`.
   */
  push(chunk: Uint8Array): void {
    if (chunk.length > 0) {
      this.pending = Buffer.concat([this.pending, chunk]);
    }
    for (;;) {
      this.drain();
      const excess = this.pending.length - this.maxBufferLength;
      if (excess <= 0) {
        return;
      }
      this.drop('overflow', excess);
    }
  }

  /** Discards buffered bytes without emitting a drop (e.g. on reconnect). */
  reset(): void {
    this.pending = EMPTY;
  }

  /** Applies the rule until it needs more data. State is committed before each callback. */
  private drain(): void {
    while (this.pending.length > 0) {
      const available = this.pending.length;
      const result = this.rule.match(this.pending);
      switch (result.kind) {
      case 'need-more':
        return;
      case 'frame': {
        if (!Number.isInteger(result.length) || result.length < 1 || result.length > available) {
          throw new RangeError(`FrameDecoder: rule returned invalid frame length ${result.length} (buffered ${available})`);
        }
        const frame = this.take(result.length);
        this.onFrame(frame);
        break;
      }
      case 'skip':
        if (!Number.isInteger(result.count) || result.count < 1 || result.count > available) {
          throw new RangeError(`FrameDecoder: rule returned invalid skip count ${result.count} (buffered ${available})`);
        }
        this.drop(result.reason, result.count);
        break;
      }
    }
  }

  private drop(reason: DropReason, count: number): void {
    const bytes = this.take(count);
    this.onDrop?.(reason, bytes);
  }

  /** Removes `count` bytes from the front and returns them as a copy. */
  private take(count: number): Buffer {
    const out = Buffer.from(this.pending.subarray(0, count));
    this.pending = count === this.pending.length ? EMPTY : this.pending.subarray(count);
    return out;
  }
}
