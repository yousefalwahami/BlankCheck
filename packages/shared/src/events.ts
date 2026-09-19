import { EVT } from "./constants";

/*
 * Fixed 16-byte referee event (tsys_emit_event):
 *   u8 kind, u8 round, u8 window_or_shot, u8 seat_a, u8 seat_b, u8 value, u8 value2, u8 pad, u64 game_id (LE)
 */
export type RefereeEvent = {
  kind: number;
  kindName: string;
  round: number;
  windowOrShot: number;
  seatA: number;
  seatB: number;
  value: number;
  value2: number;
  gameId: bigint;
};

const KIND_NAMES: Record<number, string> = Object.fromEntries(Object.entries(EVT).map(([k, v]) => [v, k]));

export const EVENT_SZ = 16;

export function encodeRefereeEvent(e: Omit<RefereeEvent, "kindName">): Uint8Array {
  const b = new Uint8Array(EVENT_SZ);
  b[0] = e.kind;
  b[1] = e.round;
  b[2] = e.windowOrShot;
  b[3] = e.seatA;
  b[4] = e.seatB;
  b[5] = e.value;
  b[6] = e.value2;
  new DataView(b.buffer).setBigUint64(8, e.gameId, true);
  return b;
}

export function decodeRefereeEvent(b: Uint8Array): RefereeEvent | null {
  if (b.length < EVENT_SZ) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  return {
    kind: b[0],
    kindName: KIND_NAMES[b[0]] ?? `UNKNOWN_${b[0]}`,
    round: b[1],
    windowOrShot: b[2],
    seatA: b[3],
    seatB: b[4],
    value: b[5],
    value2: b[6],
    gameId: dv.getBigUint64(8, true),
  };
}
