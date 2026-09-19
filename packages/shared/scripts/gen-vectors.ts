/*
 * Generates packages/shared/test/vectors.json using node:crypto (an implementation independent of
 * @noble/hashes, which the game uses). The TS tests and the C host test both check against this file.
 * Run: pnpm --filter @blankcheck/shared vectors
 */
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const sha = (b: Uint8Array) => new Uint8Array(createHash("sha256").update(b).digest());
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fill = (n: number, f: (i: number) => number) => Uint8Array.from({ length: n }, (_, i) => f(i) & 0xff);

function envPre(table: Uint8Array, round: number, window: number, seat: number, cheat: number, shell: number, salt: Uint8Array) {
  const b = new Uint8Array(69);
  b.set(table, 0);
  b[32] = round;
  b[33] = window;
  b[34] = seat;
  b[35] = cheat;
  b[36] = shell;
  b.set(salt, 37);
  return b;
}

function shellPre(table: Uint8Array, round: number, shells: number[], salt: Uint8Array) {
  const b = new Uint8Array(66 + shells.length);
  b.set(table, 0);
  b[32] = round;
  b[33] = shells.length;
  b.set(shells, 34);
  b.set(salt, 34 + shells.length);
  return b;
}

const envelopes = [
  { table: fill(32, (i) => i), round: 0, window: 0, seat: 0, cheat: 0, shell: 0xff, salt: fill(32, () => 0xff) },
  { table: fill(32, () => 0xab), round: 3, window: 7, seat: 2, cheat: 2, shell: 4, salt: fill(32, (i) => i * 7) },
  { table: sha(new TextEncoder().encode("blank-check")), round: 23, window: 15, seat: 5, cheat: 4, shell: 7, salt: sha(new TextEncoder().encode("salt")) },
].map((v) => {
  const pre = envPre(v.table, v.round, v.window, v.seat, v.cheat, v.shell, v.salt);
  return { ...v, table: hex(v.table), salt: hex(v.salt), preimage: hex(pre), hash: hex(sha(pre)) };
});

const shells = [
  { table: fill(32, (i) => i), round: 0, shells: [1, 0, 1, 1, 0], salt: fill(32, () => 0x42) },
  { table: fill(32, () => 0xab), round: 5, shells: [0, 1], salt: fill(32, (i) => i) },
].map((v) => {
  const pre = shellPre(v.table, v.round, v.shells, v.salt);
  return { ...v, table: hex(v.table), salt: hex(v.salt), preimage: hex(pre), hash: hex(sha(pre)) };
});

const out = fileURLToPath(new URL("../test/vectors.json", import.meta.url));
writeFileSync(out, JSON.stringify({ envelopes, shells }, null, 2) + "\n");
console.log(`wrote ${out}`);
