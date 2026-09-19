import { sha256 } from "@noble/hashes/sha2.js";

/*
 * Commit-reveal hash formats. These MUST match programs/referee/src/blank_check.c byte for byte.
 * Test vectors: packages/shared/test/vectors.json (checked by the TS tests and by the C host test).
 *
 * Envelope preimage (69 bytes):
 *   0  32  table account address
 *   32  1  round
 *   33  1  window
 *   34  1  seat
 *   35  1  cheat code (0 NONE, 1 PEEK, 2 HOT_LOAD, 3 DUD, 4 SWAP, 5 PALM, 6 COPYCAT)
 *   36  1  shell index affected (0xFF = none)
 *   37 32  salt
 *
 * Shell-order preimage (66 + n bytes):
 *   table(32) | round(1) | n(1) | shells[n] (0 blank, 1 live) | salt(32)
 */

export const ENVELOPE_PREIMAGE_SZ = 69;

function u8(v: number, what: string): number {
  if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`${what} out of range: ${v}`);
  return v;
}

function need32(b: Uint8Array, what: string): void {
  if (b.length !== 32) throw new Error(`${what} must be 32 bytes, got ${b.length}`);
}

export function envelopePreimage(
  table: Uint8Array,
  round: number,
  window: number,
  seat: number,
  cheat: number,
  shell: number,
  salt: Uint8Array,
): Uint8Array {
  need32(table, "table");
  need32(salt, "salt");
  const b = new Uint8Array(ENVELOPE_PREIMAGE_SZ);
  b.set(table, 0);
  b[32] = u8(round, "round");
  b[33] = u8(window, "window");
  b[34] = u8(seat, "seat");
  b[35] = u8(cheat, "cheat");
  b[36] = u8(shell, "shell");
  b.set(salt, 37);
  return b;
}

export function envelopeHash(
  table: Uint8Array,
  round: number,
  window: number,
  seat: number,
  cheat: number,
  shell: number,
  salt: Uint8Array,
): Uint8Array {
  return sha256(envelopePreimage(table, round, window, seat, cheat, shell, salt));
}

export function shellsPreimage(table: Uint8Array, round: number, shells: ArrayLike<number>, salt: Uint8Array): Uint8Array {
  need32(table, "table");
  need32(salt, "salt");
  const n = shells.length;
  const b = new Uint8Array(32 + 1 + 1 + n + 32);
  b.set(table, 0);
  b[32] = u8(round, "round");
  b[33] = u8(n, "n");
  for (let i = 0; i < n; i++) {
    const s = shells[i];
    if (s !== 0 && s !== 1) throw new Error(`shell ${i} must be 0 or 1`);
    b[34 + i] = s;
  }
  b.set(salt, 34 + n);
  return b;
}

export function shellsHash(table: Uint8Array, round: number, shells: ArrayLike<number>, salt: Uint8Array): Uint8Array {
  return sha256(shellsPreimage(table, round, shells, salt));
}

export { sha256 };
