import { describe, expect, it } from "vitest";
import {
  Cheat,
  computeAwards,
  envelopeHash,
  envelopesMatchShots,
  flattenTapeEvents,
  replayRound,
  shellsHash,
  toHex,
  verifyTapeEnvelope,
  verifyTapeShells,
  type TapeData,
  type TapeRound,
} from "../src";

const table = new Uint8Array(32).fill(9);
const tableKey = toHex(table);
const salt = new Uint8Array(32).fill(1);

function round(): TapeRound {
  const shells: (0 | 1)[] = [0, 1, 0];
  return {
    round: 0,
    shells,
    shellSalt: toHex(salt),
    commit: toHex(shellsHash(table, 0, shells, salt)),
    announced: { live: 1, blank: 2 },
    firstSeat: 0,
    shots: [
      // Seat 1 HOT LOADs shell 0 (a blank) and seat 0 eats it.
      { shot: 0, window: 0, shooter: 0, target: 0, shellIndex: 0, committed: 0, fired: 1, cheats: [{ seat: 1, cheat: 2 }], pLiveAnnounced: 1 / 3, hesitationMs: 900 },
      // Seat 0 SWAPs shell 1 (live) with shell 2 (blank): seat 1 shoots self and lives.
      { shot: 1, window: 1, shooter: 1, target: 1, shellIndex: 1, committed: 1, fired: 0, cheats: [{ seat: 0, cheat: 4 }], pLiveAnnounced: 0, hesitationMs: 3000 },
      { shot: 2, window: 2, shooter: 1, target: 0, shellIndex: 2, committed: 0, fired: 1, cheats: [], pLiveAnnounced: 0, hesitationMs: 100 },
    ],
    envelopes: [
      { window: 0, seat: 1, cheat: 2, shell: 0, salt: toHex(salt), hash: toHex(envelopeHash(table, 0, 0, 1, 2, 0, salt)), caught: false },
      { window: 1, seat: 0, cheat: 4, shell: 1, salt: toHex(salt), hash: toHex(envelopeHash(table, 0, 1, 0, 4, 1, salt)), caught: true },
      { window: 1, seat: 1, cheat: 0, shell: 0xff, salt: toHex(salt), hash: toHex(envelopeHash(table, 0, 1, 1, 0, 0xff, salt)), caught: false },
    ],
    accusations: [{ accuser: 1, accused: 0, verdict: "GUILTY", window: 2, chipsMoved: 3 }],
    buyIns: [{ seat: 0 }],
    pot: { winners: [1], chipsEach: 2, carried: 0 },
  };
}

describe("tape verification", () => {
  it("verifies envelopes and shell commits", () => {
    const r = round();
    for (const e of r.envelopes) expect(verifyTapeEnvelope(tableKey, 0, e)).toBe(true);
    expect(verifyTapeShells(tableKey, r)).toBe(true);
    const forged = { ...r.envelopes[0], cheat: Cheat.NONE as 0 };
    expect(verifyTapeEnvelope(tableKey, 0, forged)).toBe(false);
    expect(verifyTapeShells(tableKey, { ...r, shells: [1, 1, 0] })).toBe(false);
  });

  it("replays cheats against the committed order", () => {
    const r = round();
    expect(replayRound(r).every((s) => s.ok)).toBe(true);
    expect(envelopesMatchShots(r)).toBe(true);
    // A server that lied about a shot gets caught by the replay.
    r.shots[2].fired = 0;
    expect(replayRound(r)[2].ok).toBe(false);
  });
});

function tape(): TapeData {
  return {
    room: "ABCD",
    refereeMode: "mock",
    tableKey,
    tableAddress: null,
    explorerUrl: "",
    seats: [
      { seat: 0, name: "Maya", kind: "human" },
      { seat: 1, name: "Dev", kind: "human" },
      { seat: 2, name: "Gary", kind: "bot", personality: "gary" },
    ],
    winner: 1,
    rounds: [round()],
    money: {
      ticker: "BCUSD",
      bankMode: "mock",
      results: [
        { seat: 0, chips: 0, buyIns: 3, spentCents: 3600, cashOutCents: 0, profitCents: -3600 },
        { seat: 1, chips: 9, buyIns: 1, spentCents: 1200, cashOutCents: 3600, profitCents: 2400 },
        { seat: 2, chips: 3, buyIns: 1, spentCents: 1200, cashOutCents: 1200, profitCents: 0 },
      ],
      transfers: [],
    },
    onChainActions: 10,
    failedTxs: 0,
  };
}

describe("flattenTapeEvents", () => {
  const t = tape();
  const name = (s: number) => t.seats.find((x) => x.seat === s)?.name ?? `Seat ${s + 1}`;

  it("records lies, accusations, and self vs other shots", () => {
    const events = flattenTapeEvents(t, name);

    const hot = events.find((e) => e.kind === "lie" && e.search.includes("hot load"));
    expect(hot).toMatchObject({ id: "r0-lie-0-1", caught: false, seats: [1] });
    expect(hot!.search).toMatch(/got away/);

    const swap = events.find((e) => e.kind === "lie" && e.search.includes("swap"));
    expect(swap).toMatchObject({ id: "r0-lie-1-0", caught: true, seats: [0] });
    expect(swap!.search).toMatch(/caught/);

    const guilty = events.find((e) => e.kind === "rigged");
    expect(guilty).toMatchObject({ verdict: "GUILTY", seats: [1, 0] });
    expect(guilty!.search).toContain("guilty");

    const shots = events.filter((e) => e.kind === "shot");
    expect(shots).toHaveLength(3);
    expect(shots.filter((e) => e.search.includes("themselves"))).toHaveLength(2);
    expect(shots[0]).toMatchObject({ id: "r0-s0", committed: 0, fired: 1 });
    expect(shots[2]).toMatchObject({ id: "r0-s2", seats: [1, 0], committed: 0, fired: 1 });
    expect(shots[2].title).toContain("Maya");
    expect(shots[2].search).not.toContain("themselves");
  });

  it("orders round → shots → lies → accusation → buy-in → pot", () => {
    expect(flattenTapeEvents(t, name).map((e) => e.kind)).toEqual([
      "round",
      "shot",
      "shot",
      "shot",
      "lie",
      "lie",
      "rigged",
      "buyin",
      "pot",
    ]);
  });
});

describe("awards", () => {
  it("hands out awards", () => {
    const awards = Object.fromEntries(computeAwards(tape()).map((a) => [a.id, a]));
    expect(awards.liar.seats).toEqual([1]);
    expect(awards.honest.seats).toEqual([2]);
    expect(awards.sharpshooter.seats).toEqual([1]);
    expect(awards.luckiest.seats).toEqual([1]);
    expect(awards.slowest.seats).toEqual([1]);
    expect(awards.accuser.seats).toEqual([]);
    expect(awards.customer.seats).toEqual([0]);
    expect(awards.customer.detail).toContain("$36");
  });
});
