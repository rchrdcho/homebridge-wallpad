// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Formats bytes as upper-case, two-digit hex joined by `sep` (default `' '`), e.g. `"F7 20 01"`.
 */
export function toHex(bytes: Uint8Array, sep = ' '): string {
  const parts = new Array<string>(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    parts[i] = bytes[i].toString(16).toUpperCase().padStart(2, '0');
  }
  return parts.join(sep);
}

const SEPARATORS = /[\s:-]/g;
const HEX_ONLY = /^[0-9a-fA-F]*$/;

/**
 * Parses hex text into a Buffer, ignoring whitespace, `:` and `-`, case-insensitively.
 * Throws `RangeError` on non-hex characters or an odd number of digits.
 */
export function fromHex(text: string): Buffer {
  const digits = text.replace(SEPARATORS, '');
  if (!HEX_ONLY.test(digits)) {
    throw new RangeError(`fromHex: invalid hex characters in ${JSON.stringify(text)}`);
  }
  if (digits.length % 2 !== 0) {
    throw new RangeError(`fromHex: odd number of hex digits in ${JSON.stringify(text)}`);
  }
  return Buffer.from(digits, 'hex');
}
