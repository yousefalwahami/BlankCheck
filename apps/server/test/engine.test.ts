import { Cheat, envelopeHash, toHex } from "@blankcheck/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { seededRng } from "../src/engine/rng";
import { makeSeat, newGameState } from "../src/engine/rules";
import { step } from "../src/engine/step";
import type { Action, Effect, GameState, StepCtx } from "../src/engine/types";
import { pitBossView, privateView, publicView } from "../src/engine/views";

let clock = 0;
let saltN = 0;
const rng = seededRng("engine-test");
const ctx = (): StepCtx => ({ rng, now: clock, salt: () => new Uint8Array(32).fill(++saltN & 0xff) });
const host = { type: "host" } as const;

function run(s: GameState, a: Action): { s: GameState; fx: Effect[] } {
  const r = step(s, a, ctx());
  if (r.error) throw new Error(`${a.type}: ${r.error}`);
  return { s: r.state, fx: r.effects };
}

function tryRun(s: GameState, a: Action) {
  return step(s, a, ctx());
}

/** A started game with a fixed shell order and seat 0 to act. */
function game(shells: (0 | 1)[], seats = 3, hearts = 3): GameState {
  let s = newGameState("TEST", { hearts, faceIdOnTrigger: false }, new Uint8Array(32).fill(7));
  for (let i = 0; i < seats; i++) s.seats.push(makeSeat(i, `P${i}`, "human"));
  s = run(s, { type: "START" }).s;
  s.secret.shells = shells.slice();
  s.secret.current = shells.slice();
  s.announced = { live: shells.filter((x) => x).length, blank: shells.filter((x) => !x).length };
  s.currentSeat = 0;
  for (let i = 0; i < seats; i++) s.secret.cards[i] = Cheat.PEEK;
  return run(s, { type: "BEGIN_TURNS" }).s;
}

function shoot(s: GameState, shooter: number, target: number): { s: GameState; fx: Effect[] } {
  s = run(s, { type: "AIM", seat: shooter, target }).s;
  s = run(s, { type: "PULL", seat: shooter, auth: host }).s;
  const fired = run(s, { type: "FIRE" });
  const adv = run(fired.s, { type: "ADVANCE" });
  return { s: adv.s, fx: [...fired.fx, ...adv.fx] };
}

beforeEach(() => {
  clock = 10_000;
});

describe("turn order", () => {
  it("a blank on yourself means you go again", () => {
    let s = game([0, 1, 1]);
    s = shoot(s, 0, 0).s;
    expect(s.currentSeat).toBe(0);
    expect(s.seats[0].hearts).toBe(3);
  });

  it("a blank at someone else passes the gun clockwise", () => {
    let s = game([0, 1, 1]);
    s = shoot(s, 0, 2).s;
    expect(s.currentSeat).toBe(1);
  });

  it("a live shell costs the target a heart and passes the gun", () => {
    let s = game([1, 0, 1]);
    s = shoot(s, 0, 0).s;
    expect(s.seats[0].hearts).toBe(2);
    expect(s.currentSeat).toBe(1);
  });

  it("only the current seat can aim or pull", () => {
    const s = game([1, 0]);
    expect(tryRun(s, { type: "AIM", seat: 1, target: 0 }).error).toMatch(/not your turn/);
    expect(tryRun(s, { type: "PULL", seat: 0, auth: host }).error).toMatch(/target/);
  });

  it("records hesitation", () => {
    let s = game([1, 0, 1]);
    clock += 2500;
    s = shoot(s, 0, 1).s;
    expect(s.tape[0].shots[0].hesitationMs).toBe(2500);
  });
});

describe("cheats", () => {
  it("HOT LOAD turns a blank live", () => {
    let s = game([0, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 0).s;
    expect(s.seats[0].hearts).toBe(2);
    expect(s.fired.live).toBe(1);
    expect(s.tape[0].shots[0]).toMatchObject({ committed: 0, fired: 1, cheats: [{ seat: 1, cheat: Cheat.HOT_LOAD }] });
  });

  it("DUD turns a live shell blank", () => {
    let s = game([1, 0]);
    s.secret.cards[2] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 2 }).s;
    s = shoot(s, 0, 1).s;
    expect(s.seats[1].hearts).toBe(3);
  });

  it("SWAP trades the chambered shell with the next", () => {
    let s = game([1, 0, 0]);
    s.secret.cards[0] = Cheat.SWAP;
    s = run(s, { type: "CHEAT", seat: 0 }).s;
    expect(s.secret.current).toEqual([0, 1, 0]);
    expect(s.secret.shells).toEqual([1, 0, 0]); // the commitment never changes
  });

  it("HOT LOAD then DUD on the same shell leaves a blank", () => {
    let s = game([1, 1, 0]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s.secret.cards[2] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = run(s, { type: "CHEAT", seat: 2 }).s;
    expect(s.secret.current[0]).toBe(0);
  });

  it("PEEK shows only the peeker, for 2 seconds", () => {
    let s = game([1, 0]);
    s = run(s, { type: "CHEAT", seat: 2 }).s;
    expect(privateView(s, 2, clock, null).peek).toMatchObject({ shell: 0, live: true });
    expect(privateView(s, 1, clock, null).peek).toBeNull();
    expect(privateView(s, 2, clock + 2001, null).peek).toBeNull();
    expect(JSON.stringify(publicView(s, { refereeMode: "mock", tableAddress: null, explorerUrl: "", onChainActions: 0 }))).not.toContain("peek");
  });

  it("one card per round, and no cheating mid-shot", () => {
    let s = game([1, 0, 1]);
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    expect(tryRun(s, { type: "CHEAT", seat: 1 }).error).toMatch(/already/);
    s = run(s, { type: "AIM", seat: 0, target: 1 }).s;
    s = run(s, { type: "PULL", seat: 0, auth: host }).s;
    expect(tryRun(s, { type: "CHEAT", seat: 2 }).error).toMatch(/can't play/);
  });

  it("seals one envelope per seat every shot; the cheater's is the only non-NONE", () => {
    let s = game([0, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    const r = shoot(s, 0, 0);
    s = r.s;
    const resolve = r.fx.find((e) => e.type === "chain" && e.call.kind === "resolveShot");
    expect(resolve && resolve.type === "chain" && resolve.call.kind === "resolveShot" && resolve.call.envelopes.length).toBe(3);
    const envs = Object.values(s.secret.envelopes);
    expect(envs).toHaveLength(3);
    expect(envs.filter((e) => e.cheat !== Cheat.NONE)).toMatchObject([{ seat: 1, cheat: Cheat.HOT_LOAD, shell: 0, window: 0 }]);
    for (const e of envs) {
      expect(toHex(envelopeHash(s.tableKey, e.round, e.window, e.seat, e.cheat, e.shell, e.salt))).toBe(toHex(e.hash));
    }
  });
});

describe("the count", () => {
  it("flags a mismatch when more LIVE fire than announced", () => {
    let s = game([0, 1, 0]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 2).s; // live (hot loaded)
    expect(s.countIsOff).toBe(false);
    const r = shoot(s, 1, 2); // live
    expect(r.s.countIsOff).toBe(true);
    expect(r.fx.some((e) => e.type === "fx" && e.fx.type === "mismatch")).toBe(true);
  });
});

describe("RIGGED!", () => {
  it("GUILTY: the cheater loses a heart and is BUSTED", () => {
    let s = game([0, 1, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    const acc = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host });
    s = acc.s;
    expect(s.phase).toBe("RIGGED");
    const kinds = acc.fx.flatMap((e) => (e.type === "chain" ? [e.call.kind] : []));
    expect(kinds).toEqual(["seal", "accuse", "reveal"]); // flush before opening
    s = run(s, { type: "VERDICT" }).s;
    expect(s.rigged?.verdict).toBe("GUILTY");
    expect(s.seats[1].hearts).toBe(2);
    expect(s.busted).toContain(1);
    s = run(s, { type: "RESUME" }).s;
    expect(s.phase).toBe("AWAIT_AIM");
    expect(tryRun(s, { type: "ACCUSE", accuser: 0, accused: 1, auth: host }).error).toMatch(/BUSTED/);
  });

  it("INNOCENT: the accuser pays", () => {
    let s = game([0, 1, 1]);
    s = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    expect(s.rigged?.verdict).toBe("INNOCENT");
    expect(s.seats[2].hearts).toBe(2);
    expect(s.seats[1].hearts).toBe(3);
  });

  it("one accusation per player per round, reset next round", () => {
    let s = game([1, 0]);
    s = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    s = run(s, { type: "RESUME" }).s;
    expect(tryRun(s, { type: "ACCUSE", accuser: 2, accused: 0, auth: host }).error).toMatch(/already/);
    s = shoot(s, 0, 1).s;
    s = shoot(s, 1, 0).s; // gun empty → Last Call
    expect(s.phase).toBe("LAST_CALL");
    s = run(s, { type: "LAST_CALL_END" }).s;
    expect(s.accuseUsed).toEqual([]);
  });

  it("an accusation during a shot is rejected", () => {
    let s = game([1, 0]);
    s = run(s, { type: "AIM", seat: 0, target: 1 }).s;
    s = run(s, { type: "PULL", seat: 0, auth: host }).s;
    expect(tryRun(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).error).toMatch(/Wait/);
  });

  it("a verdict that kills the shooter passes the gun", () => {
    let s = game([0, 1, 1], 3, 1);
    s.secret.cards[0] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 0 }).s;
    s = run(s, { type: "ACCUSE", accuser: 1, accused: 0, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    expect(s.seats[0].hearts).toBe(0);
    s = run(s, { type: "RESUME" }).s;
    expect(s.currentSeat).toBe(1);
    expect(s.phase).toBe("AWAIT_AIM");
  });

  it("works during Last Call and restarts the countdown", () => {
    let s = game([0, 1]);
    s = shoot(s, 0, 1).s;
    s = shoot(s, 1, 2).s;
    expect(s.phase).toBe("LAST_CALL");
    const r = run(s, { type: "ACCUSE", accuser: 0, accused: 2, auth: host });
    expect(r.fx.some((e) => e.type === "cancelTimer")).toBe(true);
    s = run(r.s, { type: "VERDICT" }).s;
    s = run(s, { type: "RESUME" }).s;
    expect(s.phase).toBe("LAST_CALL");
  });
});

describe("rounds and game over", () => {
  it("Last Call hands the next round to the player after the last shooter", () => {
    let s = game([0, 1]);
    s = shoot(s, 0, 1).s; // blank at P1 → P1
    s = shoot(s, 1, 2).s; // live at P2 → gun empty
    expect(s.phase).toBe("LAST_CALL");
    s = run(s, { type: "LAST_CALL_END" }).s;
    expect(s.round).toBe(1);
    expect(s.currentSeat).toBe(2);
    expect(s.phase).toBe("ROUND_START");
    expect(Object.keys(s.secret.cards)).toHaveLength(3);
  });

  it("eliminated players are skipped and the last one standing wins", () => {
    let s = game([1, 1, 1, 1], 3, 1);
    s = shoot(s, 0, 1).s; // P1 out
    expect(s.seats[1].hearts).toBe(0);
    expect(s.currentSeat).toBe(2);
    const r = shoot(s, 2, 0); // P0 out
    s = r.s;
    expect(s.phase).toBe("OVER");
    expect(s.winner).toBe(2);
    s = run(s, { type: "TAPE" }).s;
    expect(s.phase).toBe("TAPE");
  });

  it("the tape reveals every seat for every round, plus the shell orders", () => {
    let s = game([1, 1, 1], 2, 1);
    s = shoot(s, 0, 1).s;
    const r = run(s, { type: "TAPE" });
    const calls = r.fx.flatMap((e) => (e.type === "chain" ? [e.call] : []));
    expect(calls.filter((c) => c.kind === "reveal" && c.mode === 1)).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "revealShells")).toHaveLength(1);
    expect(r.s.tape[0].envelopes).toHaveLength(2);
  });
});

describe("views", () => {
  it("the Pit Boss never sees secrets", () => {
    let s = game([0, 1, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 0).s;
    const json = JSON.stringify(pitBossView(s));
    for (const secret of ["card", "salt", "shells", "current", "envelopes", "cheat", "peek", "peekedLive"]) {
      expect(json).not.toContain(`"${secret}":`);
    }
  });

  it("public state carries no secrets", () => {
    let s = game([0, 1, 1]);
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    const json = JSON.stringify(publicView(s, { refereeMode: "mock", tableAddress: null, explorerUrl: "", onChainActions: 0 }));
    for (const secret of ["secret", "salt", "card", "playerId", "credentialId", "publicKey"]) expect(json).not.toContain(`"${secret}":`);
  });
});
