import { MAX_ROUNDS, MAX_SEATS, MAX_WINDOWS } from "./constants";

/*
 * Byte layout of the referee's `Table` account (bc_table_t in programs/referee/src/blank_check.h).
 * Packed, little-endian. The C header static-asserts the same offsets and total size.
 */
const FIELDS = [
  ["magic", 4],
  ["host", 32],
  ["gameId", 8],
  ["status", 1],
  ["numSeats", 1],
  ["startHearts", 1],
  ["round", 1],
  ["currentSeat", 1],
  ["shot", 1],
  ["window", 1],
  ["triggerPulled", 1],
  ["pendingTarget", 1],
  ["pendingAccuser", 1],
  ["pendingAccused", 1],
  ["winner", 1],
  ["hearts", MAX_SEATS],
  ["busted", MAX_SEATS],
  ["accuseUsed", MAX_SEATS],
  ["seatWallet", MAX_SEATS * 32],
  ["shellsCommit", MAX_ROUNDS * 32],
  ["shellCount", MAX_ROUNDS],
  ["liveCount", MAX_ROUNDS],
  ["windowCount", MAX_ROUNDS],
  ["env", MAX_ROUNDS * MAX_WINDOWS * MAX_SEATS * 32],
] as const;

type FieldName = (typeof FIELDS)[number][0];

export const TABLE_OFFSETS = (() => {
  const o = {} as Record<FieldName, number>;
  let at = 0;
  for (const [name, size] of FIELDS) {
    o[name] = at;
    at += size;
  }
  return o;
})();

export const TABLE_SIZE = FIELDS.reduce((n, [, size]) => n + size, 0); // 74834
export const TABLE_MAGIC = [0x42, 0x43, 0x4b, 0x31]; // "BCK1"
export const ROUND_NONE = 0xff;

export function envOffset(round: number, window: number, seat: number): number {
  return TABLE_OFFSETS.env + ((round * MAX_WINDOWS + window) * MAX_SEATS + seat) * 32;
}

export type ParsedTable = {
  gameId: bigint;
  status: number;
  numSeats: number;
  round: number;
  currentSeat: number;
  shot: number;
  window: number;
  winner: number;
  hearts: number[];
  shellsCommit: (round: number) => Uint8Array;
  shellCount: (round: number) => number;
  windowCount: (round: number) => number;
  env: (round: number, window: number, seat: number) => Uint8Array;
};

/** Parse raw Table account data (as read from the chain) so anyone can check the tape against it. */
export function parseTable(data: Uint8Array): ParsedTable | null {
  if (data.length < TABLE_SIZE) return null;
  for (let i = 0; i < 4; i++) if (data[i] !== TABLE_MAGIC[i]) return null;
  const O = TABLE_OFFSETS;
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
  return {
    gameId: dv.getBigUint64(O.gameId, true),
    status: data[O.status],
    numSeats: data[O.numSeats],
    round: data[O.round],
    currentSeat: data[O.currentSeat],
    shot: data[O.shot],
    window: data[O.window],
    winner: data[O.winner],
    hearts: Array.from(data.subarray(O.hearts, O.hearts + MAX_SEATS)),
    shellsCommit: (r) => data.slice(O.shellsCommit + r * 32, O.shellsCommit + r * 32 + 32),
    shellCount: (r) => data[O.shellCount + r],
    windowCount: (r) => data[O.windowCount + r],
    env: (r, w, s) => data.slice(envOffset(r, w, s), envOffset(r, w, s) + 32),
  };
}
