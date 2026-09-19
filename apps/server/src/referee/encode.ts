import { IX, MAX_SEATS } from "@blankcheck/shared";

/*
 * Referee instruction encoders. Every instruction starts with `u32 ix` then `u16 table_idx`
 * (little-endian, packed), matching programs/referee/src/blank_check.h.
 */

class W {
  private b: number[] = [];
  u8(v: number) {
    if (!Number.isInteger(v) || v < 0 || v > 0xff) throw new Error(`u8 out of range: ${v}`);
    this.b.push(v);
    return this;
  }
  u16(v: number) {
    return this.u8(v & 0xff).u8((v >>> 8) & 0xff);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16((v >>> 16) & 0xffff);
  }
  u64(v: bigint) {
    for (let i = 0n; i < 8n; i++) this.u8(Number((v >> (8n * i)) & 0xffn));
    return this;
  }
  bytes(x: Uint8Array, len?: number) {
    if (len !== undefined && x.length !== len) throw new Error(`expected ${len} bytes, got ${x.length}`);
    for (const v of x) this.b.push(v);
    return this;
  }
  done() {
    return Uint8Array.from(this.b);
  }
}

const hdr = (ix: number, tableIdx: number) => new W().u32(ix).u16(tableIdx);

/** The 32-byte seed the table account is derived from: "table" + u64 LE game_id, zero padded. */
export function tableSeed(gameId: bigint): Uint8Array {
  const seed = new Uint8Array(32);
  seed.set([0x74, 0x61, 0x62, 0x6c, 0x65], 0); // "table"
  new DataView(seed.buffer).setBigUint64(5, gameId, true);
  return seed;
}

export function encCreateTable(a: { tableIdx: number; gameId: bigint; hearts: number; wallets: Uint8Array[]; proof: Uint8Array }) {
  if (a.wallets.length < 2 || a.wallets.length > MAX_SEATS) throw new Error("bad seat count");
  const w = hdr(IX.CREATE_TABLE, a.tableIdx).u64(a.gameId).u8(a.wallets.length).u8(a.hearts);
  for (const x of a.wallets) w.bytes(x, 32);
  return w.u32(a.proof.length).bytes(a.proof).done();
}

export function encCommitRound(a: { tableIdx: number; round: number; shellCount: number; liveCount: number; firstSeat: number; commit: Uint8Array }) {
  return hdr(IX.COMMIT_ROUND, a.tableIdx).u8(a.round).u8(a.shellCount).u8(a.liveCount).u8(a.firstSeat).bytes(a.commit, 32).done();
}

export function encPullTrigger(a: { tableIdx: number; walletIdx: number; round: number; shot: number; shooter: number; target: number }) {
  return hdr(IX.PULL_TRIGGER, a.tableIdx).u16(a.walletIdx).u8(a.round).u8(a.shot).u8(a.shooter).u8(a.target).done();
}

export function encResolveShot(a: { tableIdx: number; round: number; shot: number; isLive: boolean; window: number; envelopes: Uint8Array[] }) {
  const w = hdr(IX.RESOLVE_SHOT, a.tableIdx).u8(a.round).u8(a.shot).u8(a.isLive ? 1 : 0).u8(a.window).u8(a.envelopes.length);
  for (const e of a.envelopes) w.bytes(e, 32);
  return w.done();
}

export function encSeal(a: { tableIdx: number; round: number; window: number; envelopes: Uint8Array[] }) {
  const w = hdr(IX.SEAL, a.tableIdx).u8(a.round).u8(a.window).u8(a.envelopes.length);
  for (const e of a.envelopes) w.bytes(e, 32);
  return w.done();
}

export function encAccuse(a: { tableIdx: number; walletIdx: number; round: number; accuser: number; accused: number }) {
  return hdr(IX.ACCUSE, a.tableIdx).u16(a.walletIdx).u8(a.round).u8(a.accuser).u8(a.accused).done();
}

export function encReveal(a: { tableIdx: number; round: number; seat: number; mode: 0 | 1; entries: { cheat: number; shell: number; salt: Uint8Array }[] }) {
  const w = hdr(IX.REVEAL, a.tableIdx).u8(a.round).u8(a.seat).u8(a.mode).u8(a.entries.length);
  for (const e of a.entries) w.u8(e.cheat).u8(e.shell).bytes(e.salt, 32);
  return w.done();
}

export function encRevealShells(a: { tableIdx: number; round: number; shells: number[]; salt: Uint8Array }) {
  const w = hdr(IX.REVEAL_SHELLS, a.tableIdx).u8(a.round).u8(a.shells.length);
  for (const s of a.shells) w.u8(s);
  return w.bytes(a.salt, 32).done();
}
