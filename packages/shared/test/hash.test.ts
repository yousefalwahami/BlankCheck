import { describe, expect, it } from "vitest";
import vectors from "./vectors.json";
import {
  decodeRefereeEvent,
  encodeRefereeEvent,
  envelopeHash,
  envelopePreimage,
  fromHex,
  shellsHash,
  shellsPreimage,
  toHex,
} from "../src";

describe("envelope hash", () => {
  for (const [i, v] of vectors.envelopes.entries()) {
    it(`matches vector ${i}`, () => {
      const table = fromHex(v.table);
      const salt = fromHex(v.salt);
      expect(toHex(envelopePreimage(table, v.round, v.window, v.seat, v.cheat, v.shell, salt))).toBe(v.preimage);
      expect(toHex(envelopeHash(table, v.round, v.window, v.seat, v.cheat, v.shell, salt))).toBe(v.hash);
    });
  }

  it("changes when any field changes", () => {
    const v = vectors.envelopes[1];
    const base = toHex(envelopeHash(fromHex(v.table), v.round, v.window, v.seat, v.cheat, v.shell, fromHex(v.salt)));
    const tweaked = [
      envelopeHash(fromHex(v.table), v.round + 1, v.window, v.seat, v.cheat, v.shell, fromHex(v.salt)),
      envelopeHash(fromHex(v.table), v.round, v.window, v.seat, 0, v.shell, fromHex(v.salt)),
      envelopeHash(fromHex(v.table), v.round, v.window, v.seat, v.cheat, v.shell, new Uint8Array(32)),
    ].map(toHex);
    for (const t of tweaked) expect(t).not.toBe(base);
  });

  it("rejects bad sizes", () => {
    expect(() => envelopeHash(new Uint8Array(31), 0, 0, 0, 0, 0, new Uint8Array(32))).toThrow();
    expect(() => envelopeHash(new Uint8Array(32), 256, 0, 0, 0, 0, new Uint8Array(32))).toThrow();
  });
});

describe("shell-order hash", () => {
  for (const [i, v] of vectors.shells.entries()) {
    it(`matches vector ${i}`, () => {
      const table = fromHex(v.table);
      const salt = fromHex(v.salt);
      expect(toHex(shellsPreimage(table, v.round, v.shells, salt))).toBe(v.preimage);
      expect(toHex(shellsHash(table, v.round, v.shells, salt))).toBe(v.hash);
    });
  }
});

describe("referee events", () => {
  it("round-trips", () => {
    const e = { kind: 7, round: 2, windowOrShot: 4, seatA: 1, seatB: 3, value: 1, value2: 0, gameId: 123456789012345n };
    const b = encodeRefereeEvent(e);
    expect(b.length).toBe(16);
    expect(decodeRefereeEvent(b)).toMatchObject({ ...e, kindName: "VERDICT" });
  });
});
