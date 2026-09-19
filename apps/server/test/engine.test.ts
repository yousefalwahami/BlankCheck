import { Cheat, MONEY, envelopeHash, toHex } from "@blankcheck/shared";
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
const extras = { refereeMode: "mock", bankMode: "mock", tableAddress: null, explorerUrl: "", onChainActions: 0 } as const;

function run(s: GameState, a: Action): { s: GameState; fx: Effect[] } {
  const r = step(s, a, ctx());
  if (r.error) throw new Error(`${a.type}: ${r.error}`);
  return { s: r.state, fx: r.effects };
}

function tryRun(s: GameState, a: Action) {
  return step(s, a, ctx());
}

const chains = (fx: Effect[]) => fx.flatMap((e) => (e.type === "chain" ? [e.call] : []));
const fxOf = (fx: Effect[], type: string) => fx.flatMap((e) => (e.type === "fx" && e.fx.type === type ? [e.fx] : []));

/** A started game with a fixed shell order and seat 0 to act. Everyone bought in at the lobby. */
function game(shells: (0 | 1)[], seats = 3, rounds = 3, bankroll: number = MONEY.bankrollCents): GameState {
  let s = newGameState("TEST", { rounds, faceIdOnTrigger: false }, new Uint8Array(32).fill(7));
  for (let i = 0; i < seats; i++) s.seats.push(makeSeat(i, `P${i}`, "human", { bankrollCents: bankroll }));
  for (let i = 0; i < seats; i++) s = run(s, { type: "BUY_IN", seat: i }).s;
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

const chips = (s: GameState) => s.seats.map((x) => x.chips);

beforeEach(() => {
  clock = 10_000;
});

describe("buying in", () => {
  it("costs $12 for 3 chips, and the lobby buy-in doesn't touch the chain", () => {
    let s = newGameState("T", { rounds: 3, faceIdOnTrigger: false });
    s.seats.push(makeSeat(0, "A", "human", { bankrollCents: 6000 }), makeSeat(1, "B", "human", { bankrollCents: 6000 }));
    expect(tryRun(s, { type: "START" }).error).toMatch(/buy in/);
    const r = run(s, { type: "BUY_IN", seat: 0 });
    expect(r.s.seats[0]).toMatchObject({ chips: 3, buyIns: 1, bankrollCents: 4800 });
    expect(chains(r.fx)).toEqual([]);
    s = run(r.s, { type: "BUY_IN", seat: 1 }).s;
    expect(tryRun(s, { type: "BUY_IN", seat: 1 }).error).toMatch(/still have chips/);
    expect(run(s, { type: "START" }).s.phase).toBe("ROUND_START");
  });

  it("needs $12 in the wallet", () => {
    const s = newGameState("T", { rounds: 3, faceIdOnTrigger: false });
    s.seats.push(makeSeat(0, "A", "human", { bankrollCents: 1100 }));
    expect(tryRun(s, { type: "BUY_IN", seat: 0 }).error).toMatch(/\$12/);
  });
});

describe("turn order", () => {
  it("a blank on yourself means you go again", () => {
    let s = game([0, 1, 1]);
    s = shoot(s, 0, 0).s;
    expect(s.currentSeat).toBe(0);
    expect(chips(s)).toEqual([3, 3, 3]);
  });

  it("a blank at someone else passes the gun clockwise", () => {
    let s = game([0, 1, 1]);
    s = shoot(s, 0, 2).s;
    expect(s.currentSeat).toBe(1);
  });

  it("a live shell knocks one of the target's chips into the pot", () => {
    let s = game([1, 0, 1]);
    const r = shoot(s, 0, 2);
    s = r.s;
    expect(chips(s)).toEqual([3, 3, 2]);
    expect(s.pot).toBe(1);
    expect(fxOf(r.fx, "shot")[0]).toMatchObject({ live: true, chipsLeft: 2, pot: 1, broke: false });
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

describe("going broke", () => {
  it("a broke player is skipped, can't be targeted, and can buy back in", () => {
    let s = game([1, 1, 0, 0, 0, 0, 0, 0]);
    s.seats[1].chips = 1;
    const r = shoot(s, 0, 1);
    s = r.s;
    expect(s.seats[1].chips).toBe(0);
    expect(fxOf(r.fx, "broke")[0]).toMatchObject({ seat: 1, cleanedOut: false });
    expect(s.currentSeat).toBe(2); // skipped seat 1
    expect(tryRun(s, { type: "AIM", seat: 2, target: 1 }).error).toMatch(/broke/);
    const b = run(s, { type: "BUY_IN", seat: 1 });
    expect(b.s.seats[1]).toMatchObject({ chips: 3, buyIns: 2, bankrollCents: 3600 });
    expect(chains(b.fx)).toEqual([expect.objectContaining({ kind: "buyIn", seat: 1 })]);
  });

  it("can't buy in while a shot is being settled", () => {
    let s = game([1, 0, 0]);
    s.seats[2].chips = 0;
    s = run(s, { type: "AIM", seat: 0, target: 1 }).s;
    s = run(s, { type: "PULL", seat: 0, auth: host }).s;
    expect(tryRun(s, { type: "BUY_IN", seat: 2 }).error).toMatch(/finish this shot/);
  });

  it("without $12 left, broke means cleaned out", () => {
    const s = game([1, 0, 0], 3, 3, MONEY.buyInCents); // exactly one buy-in in the wallet
    s.seats[1].chips = 1;
    const r = shoot(s, 0, 1);
    expect(r.s.seats[1].cleanedOut).toBe(true);
    expect(fxOf(r.fx, "broke")[0]).toMatchObject({ cleanedOut: true });
  });
});

describe("cheats", () => {
  it("HOT LOAD turns a blank live", () => {
    let s = game([0, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 0).s;
    expect(s.seats[0].chips).toBe(2);
    expect(s.fired.live).toBe(1);
    expect(s.tape[0].shots[0]).toMatchObject({ committed: 0, fired: 1, cheats: [{ seat: 1, cheat: Cheat.HOT_LOAD }] });
  });

  it("DUD turns a live shell blank", () => {
    let s = game([1, 0]);
    s.secret.cards[2] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 2 }).s;
    s = shoot(s, 0, 1).s;
    expect(s.seats[1].chips).toBe(3);
  });

  it("SWAP trades the chambered shell with the next", () => {
    let s = game([1, 0, 0]);
    s.secret.cards[0] = Cheat.SWAP;
    s = run(s, { type: "CHEAT", seat: 0 }).s;
    expect(s.secret.current).toEqual([0, 1, 0]);
    expect(s.secret.shells).toEqual([1, 0, 0]);
  });

  it("PEEK shows only the peeker, for 2 seconds", () => {
    let s = game([1, 0]);
    s = run(s, { type: "CHEAT", seat: 2 }).s;
    expect(privateView(s, 2, clock, null).peek).toMatchObject({ shell: 0, live: true });
    expect(privateView(s, 1, clock, null).peek).toBeNull();
    expect(privateView(s, 2, clock + 2001, null).peek).toBeNull();
  });

  it("seals one envelope per seat every shot; the cheater's is the only non-NONE", () => {
    let s = game([0, 1]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 0).s;
    const envs = Object.values(s.secret.envelopes);
    expect(envs).toHaveLength(3);
    expect(envs.filter((e) => e.cheat !== Cheat.NONE)).toMatchObject([{ seat: 1, cheat: Cheat.HOT_LOAD, shell: 0, window: 0 }]);
    for (const e of envs) expect(toHex(envelopeHash(s.tableKey, e.round, e.window, e.seat, e.cheat, e.shell, e.salt))).toBe(toHex(e.hash));
  });
});

describe("the count", () => {
  it("flags a mismatch when more LIVE fire than announced", () => {
    let s = game([0, 1, 0]);
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = shoot(s, 0, 2).s;
    expect(s.countIsOff).toBe(false);
    const r = shoot(s, 1, 2);
    expect(r.s.countIsOff).toBe(true);
    expect(fxOf(r.fx, "mismatch")).toHaveLength(1);
  });
});

describe("RIGGED!", () => {
  it("GUILTY: the accuser takes ALL of the cheater's chips", () => {
    let s = game([0, 1, 1]);
    s.seats[1].chips = 5;
    s.secret.cards[1] = Cheat.HOT_LOAD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    const acc = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host });
    expect(chains(acc.fx).map((c) => c.kind)).toEqual(["seal", "accuse", "reveal"]);
    const v = run(acc.s, { type: "VERDICT" });
    s = v.s;
    expect(s.rigged).toMatchObject({ verdict: "GUILTY", chipsMoved: 5 });
    expect(chips(s)).toEqual([3, 0, 8]);
    expect(fxOf(v.fx, "verdict")[0]).toMatchObject({ from: 1, to: 2, chips: 5, broke: true });
    expect(fxOf(v.fx, "broke")[0]).toMatchObject({ seat: 1 });
    s = run(s, { type: "RESUME" }).s;
    expect(s.phase).toBe("AWAIT_AIM");
  });

  it("INNOCENT: the accuser pays one chip to the accused", () => {
    let s = game([0, 1, 1]);
    s = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    expect(s.rigged).toMatchObject({ verdict: "INNOCENT", chipsMoved: 1 });
    expect(chips(s)).toEqual([3, 4, 2]);
  });

  it("one accusation per player per round, and BUSTED can't be piled on", () => {
    let s = game([1, 0, 1]);
    s.secret.cards[1] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 1 }).s;
    s = run(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    s = run(s, { type: "RESUME" }).s;
    expect(tryRun(s, { type: "ACCUSE", accuser: 2, accused: 0, auth: host }).error).toMatch(/already/);
    expect(tryRun(s, { type: "ACCUSE", accuser: 0, accused: 1, auth: host }).error).toMatch(/broke|BUSTED/);
  });

  it("an accusation during a shot is rejected", () => {
    let s = game([1, 0]);
    s = run(s, { type: "AIM", seat: 0, target: 1 }).s;
    s = run(s, { type: "PULL", seat: 0, auth: host }).s;
    expect(tryRun(s, { type: "ACCUSE", accuser: 2, accused: 1, auth: host }).error).toMatch(/Wait/);
  });

  it("a verdict that leaves the shooter broke passes the gun", () => {
    let s = game([0, 1, 1]);
    s.secret.cards[0] = Cheat.DUD;
    s = run(s, { type: "CHEAT", seat: 0 }).s;
    s = run(s, { type: "ACCUSE", accuser: 1, accused: 0, auth: host }).s;
    s = run(s, { type: "VERDICT" }).s;
    expect(s.seats[0].chips).toBe(0);
    s = run(s, { type: "RESUME" }).s;
    expect(s.currentSeat).toBe(1);
  });
});

describe("rounds, the pot, and cashing out", () => {
  it("at round end the chip leader takes the pot", () => {
    let s = game([1, 1]);
    s = shoot(s, 0, 1).s; // P1 3→2, pot 1
    s = shoot(s, 1, 2).s; // P2 3→2, pot 2 → gun empty
    expect(s.phase).toBe("LAST_CALL");
    const end = run(s, { type: "LAST_CALL_END" });
    s = end.s;
    expect(s.phase).toBe("ROUND_END");
    expect(chips(s)).toEqual([5, 2, 2]);
    expect(s.pot).toBe(0);
    expect(fxOf(end.fx, "potAward")[0]).toMatchObject({ winners: [0], chipsEach: 2, carried: 0 });
    expect(chains(end.fx)).toEqual([{ kind: "endRound", round: 0 }]);
    s = run(s, { type: "NEXT_ROUND" }).s;
    expect(s.round).toBe(1);
    expect(s.currentSeat).toBe(2); // after the last shooter
  });

  it("ties split the pot and the remainder carries over", () => {
    let s = game([1]);
    s = shoot(s, 0, 2).s; // P2 3→2, pot 1 → gun empty
    s.pot = 3;
    s = run(s, { type: "LAST_CALL_END" }).s;
    expect(chips(s)).toEqual([4, 4, 2]);
    expect(s.pot).toBe(1);
  });

  it("with fewer than two players holding chips, the round ends early", () => {
    const s = game([1, 1, 1, 1], 2);
    s.seats[1].chips = 1;
    const r = shoot(s, 0, 1);
    expect(r.s.phase).toBe("ROUND_END");
    expect(r.s.seats[0].chips).toBe(4); // took the pot
  });

  it("between rounds, broke players get a buy-in window; buying in deals the next round", () => {
    let s = game([1, 1, 1, 1], 2);
    s.seats[1].chips = 1;
    s = shoot(s, 0, 1).s;
    const next = run(s, { type: "NEXT_ROUND" });
    s = next.s;
    expect(s.phase).toBe("BUY_INS");
    expect(fxOf(next.fx, "buyInWindow")).toHaveLength(1);
    const b = run(s, { type: "BUY_IN", seat: 1 });
    expect(b.s.phase).toBe("ROUND_START");
    expect(b.s.round).toBe(1);
  });

  it("nobody buys back in → the game cashes out early", () => {
    let s = game([1, 1, 1, 1], 2, 5);
    s.seats[1].chips = 1;
    s = shoot(s, 0, 1).s;
    s = run(s, { type: "NEXT_ROUND" }).s;
    const end = run(s, { type: "BUY_INS_END" });
    expect(end.s.phase).toBe("OVER");
    expect(chains(end.fx)).toEqual([expect.objectContaining({ kind: "commitRound", shellCount: 0 })]);
  });

  it("after the last round everyone cashes out at $4 a chip; biggest profit wins", () => {
    let s = game([1], 3, 1);
    s = shoot(s, 0, 2).s; // P2 → 2, pot 1 → gun empty
    s = run(s, { type: "LAST_CALL_END" }).s; // P0 & P1 tie at 3: the 1-chip pot carries
    s.seats[1].buyIns = 2; // P1 paid for a second buy-in
    const over = run(s, { type: "NEXT_ROUND" });
    s = over.s;
    expect(s.phase).toBe("OVER");
    expect(s.results).toEqual([
      { seat: 0, chips: 3, buyIns: 1, spentCents: 1200, cashOutCents: 1200, profitCents: 0 },
      { seat: 1, chips: 3, buyIns: 2, spentCents: 2400, cashOutCents: 1200, profitCents: -1200 },
      { seat: 2, chips: 2, buyIns: 1, spentCents: 1200, cashOutCents: 800, profitCents: -400 },
    ]);
    expect(s.winner).toBe(0);
    expect(over.fx.some((e) => e.type === "cashOut")).toBe(true);
    expect(s.seats[0].bankrollCents).toBe(4800 + 1200);
  });

  it("the tape reveals every seat for every round, plus the shell orders", () => {
    let s = game([1, 1], 2, 1);
    s = shoot(s, 0, 1).s;
    s = shoot(s, 1, 0).s;
    s = run(s, { type: "LAST_CALL_END" }).s; // 2–2: the 2-chip pot splits 1 each
    expect(chips(s)).toEqual([3, 3]);
    s = run(s, { type: "NEXT_ROUND" }).s;
    const r = run(s, { type: "TAPE" });
    const calls = chains(r.fx);
    expect(calls.filter((c) => c.kind === "reveal" && c.mode === 1)).toHaveLength(2);
    expect(calls.filter((c) => c.kind === "revealShells")).toHaveLength(1);
    expect(r.s.tape[0].envelopes).toHaveLength(4);
    expect(r.s.tape[0].pot).toMatchObject({ winners: [0, 1], chipsEach: 1, carried: 0 });
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
    const json = JSON.stringify(publicView(s, extras));
    for (const secret of ["secret", "salt", "card", "playerId", "credentialId", "publicKey"]) expect(json).not.toContain(`"${secret}":`);
  });

  it("a broke phone is told it can buy back in", () => {
    const s = game([0, 1, 1]);
    s.seats[1].chips = 0;
    expect(privateView(s, 1, clock, null).canBuyIn).toBe(true);
    expect(privateView(s, 0, clock, null).canBuyIn).toBe(false);
  });
});
