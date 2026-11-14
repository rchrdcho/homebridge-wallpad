// SPDX-License-Identifier: AGPL-3.0-only

/** Deterministic PRNG (mulberry32). Returns floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Splits `bytes` into consecutive chunks of random size in [1, maxChunk]. */
export function randomChunks(bytes: Uint8Array, seed: number, maxChunk: number): Buffer[] {
  const rand = mulberry32(seed);
  const out: Buffer[] = [];
  let pos = 0;
  while (pos < bytes.length) {
    const size = 1 + Math.floor(rand() * maxChunk);
    out.push(Buffer.from(bytes.subarray(pos, pos + size)));
    pos += size;
  }
  return out;
}
