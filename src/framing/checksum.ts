// SPDX-License-Identifier: AGPL-3.0-only

function checkRange(fn: string, bytes: Uint8Array, from: number, to: number): void {
  if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from > to || to > bytes.length) {
    throw new RangeError(`${fn}: invalid range [${from}, ${to}) for length ${bytes.length}`);
  }
}

/** Sum of `bytes[from..to)` truncated to 8 bits. Throws `RangeError` on an invalid range. */
export function sum8(bytes: Uint8Array, from: number, to: number): number {
  checkRange('sum8', bytes, from, to);
  let acc = 0;
  for (let i = from; i < to; i++) {
    acc = (acc + bytes[i]) & 0xff;
  }
  return acc;
}

/** XOR of `bytes[from..to)`. Throws `RangeError` on an invalid range. */
export function xor8(bytes: Uint8Array, from: number, to: number): number {
  checkRange('xor8', bytes, from, to);
  let acc = 0;
  for (let i = from; i < to; i++) {
    acc ^= bytes[i];
  }
  return acc;
}
