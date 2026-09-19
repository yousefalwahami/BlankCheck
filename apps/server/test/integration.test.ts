import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { io as connect, type Socket } from "socket.io-client";
import type { ChainTx, Fx, PrivateView, PublicState, TapeData } from "@blankcheck/shared";

process.env.TIME_SCALE = "0.02";
process.env.REFEREE_MODE = "mock";

const { createGameServer } = await import("../src/server");
const { computeAwards, replayRound, verifyTapeEnvelope, verifyTapeShells } = await import("@blankcheck/shared");

let server: ReturnType<typeof createGameServer>;
let url = "";

beforeAll(async () => {
  server = createGameServer();
  await new Promise<void>((r) => server.http.listen(0, r));
  url = `http://localhost:${(server.http.address() as AddressInfo).port}`;
});

afterAll(() => server.close());

const ask = <T = any>(s: Socket, ev: string, payload: unknown = {}) => new Promise<T>((r) => s.emit(ev, payload, r));

/** Bots buy in on their own a moment after sitting down; keep asking until the dealer can start. */
async function startWhenEveryoneBoughtIn(tv: Socket) {
  for (let i = 0; i < 100; i++) {
    const r = await ask(tv, "game:start");
    if (r.ok) return;
    expect(r.error).toMatch(/buy in/);
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error("nobody bought in");
}

/** A phone without Face ID: ask to buy in, then confirm with a tap. */
async function buyIn(phone: Socket) {
  const priv = new Promise<PrivateView>((resolve) => phone.on("private", (p: PrivateView) => p.challenge?.kind === "buyin" && resolve(p)));
  for (let i = 0; i < 50; i++) {
    const r = await ask(phone, "bank:buyin");
    if (r.ok) break;
    await new Promise((res) => setTimeout(res, 50)); // the wallet may still be opening
  }
  const p = await priv;
  expect((await ask(phone, "bank:buyin:signed", { challengeId: p.challenge!.id })).ok).toBe(true);
}

describe("a full game over sockets", () => {
  it("TV + one phone + three bots play to Review the Tape", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const phone = connect(url, { transports: ["websocket"] });
    const txs: ChainTx[] = [];
    const fxs: Fx["type"][] = [];
    tv.on("chain:tx", (t: ChainTx) => txs.push(t));

    const created = await ask(tv, "room:create", { rounds: 3, faceIdOnTrigger: true });
    expect(created.ok).toBe(true);
    const room = created.room as string;
    expect(room).toMatch(/^[A-Z]{4}$/);

    const joined = await ask(phone, "room:join", { room, name: "Maya", playerId: "player-maya-1" });
    expect(joined).toMatchObject({ ok: true, seat: 0 });
    for (const personality of ["gary", "accountant", "mercy"]) expect((await ask(tv, "bot:add", { personality })).ok).toBe(true);

    // The phone plays: buys in whenever it can, aims at itself on good odds, else at the next seat.
    let state: PublicState | null = null;
    let priv: PrivateView | null = null;
    let busy = false;
    let dirty = false;
    const act = async (): Promise<void> => {
      if (!state || !priv) return;
      if (busy) {
        dirty = true;
        return;
      }
      busy = true;
      dirty = false;
      try {
        if (priv.challenge?.kind === "buyin") await ask(phone, "bank:buyin:signed", { challengeId: priv.challenge.id });
        else if (priv.canBuyIn && !priv.challenge) await ask(phone, "bank:buyin");
        if (priv.canCheat && Math.random() < 0.3) await ask(phone, "cheat:play");
        if (state.currentSeat === 0 && state.phase === "AWAIT_AIM") {
          const live = state.announced.live - state.fired.live;
          const blank = state.announced.blank - state.fired.blank;
          const others = state.seats.filter((x) => x.seat !== 0 && x.chips > 0);
          await ask(phone, "turn:aim", { target: live <= blank || !others.length ? 0 : others[0].seat });
        } else if (priv.challenge?.kind === "trigger" && state.phase === "AWAIT_TRIGGER") {
          await ask(phone, "turn:signed", { challengeId: priv.challenge.id });
        }
      } finally {
        busy = false;
      }
      if (dirty) return act();
    };
    phone.on("state", (s: PublicState) => {
      state = s;
      void act();
    });
    phone.on("private", (p: PrivateView) => {
      priv = p;
      void act();
    });

    const tape = await new Promise<TapeData>((resolve) => {
      tv.on("fx", (fx: Fx) => {
        fxs.push(fx.type);
        if (fx.type === "tape") resolve(fx.tape);
      });
      void startWhenEveryoneBoughtIn(tv);
    });

    expect(fxs).toContain("round");
    expect(fxs).toContain("shot");
    expect(fxs).toContain("gameOver");
    expect(txs.length).toBeGreaterThan(5);
    expect(txs.filter((t) => !t.ok)).toEqual([]);
    expect(tape.failedTxs).toBe(0);

    // Money: everyone bought in, the cashier paid out chips × $4, and profits add up.
    expect(txs.filter((t) => t.kind === "BUY_IN_$").length).toBeGreaterThanOrEqual(4);
    const { results, transfers } = tape.money;
    expect(results).toHaveLength(4);
    for (const r of results) expect(r.profitCents).toBe(r.cashOutCents - r.buyIns * 1200);
    const paid = transfers.filter((x) => x.kind === "cashOut").reduce((n, x) => n + x.cents, 0);
    expect(paid).toBe(results.reduce((n, r) => n + r.cashOutCents, 0));
    expect(results.find((r) => r.seat === tape.winner)!.profitCents).toBe(Math.max(...results.map((r) => r.profitCents)));

    for (const r of tape.rounds) {
      expect(verifyTapeShells(tape.tableKey, r)).toBe(true);
      expect(replayRound(r).every((x) => x.ok)).toBe(true);
      for (const e of r.envelopes) {
        expect(verifyTapeEnvelope(tape.tableKey, r.round, e)).toBe(true);
        expect(e.revealOk).toBe(true);
      }
      expect(r.shellsOk).toBe(true);
    }
    expect(computeAwards(tape)).toHaveLength(7);

    tv.close();
    phone.close();
  }, 60_000);

  it("a player who drops out doesn't freeze the table", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const phone = connect(url, { transports: ["websocket"] });
    const { room } = await ask(tv, "room:create", { rounds: 2 });
    expect((await ask(phone, "room:join", { room, name: "Ghost", playerId: "player-ghost-1" })).ok).toBe(true);
    await buyIn(phone);
    await ask(tv, "bot:add", { personality: "accountant" });
    await ask(tv, "bot:add", { personality: "intern" });
    phone.close(); // bought in, then left before the game even started
    const tape = await new Promise<TapeData>((resolve) => {
      tv.on("fx", (fx: Fx) => fx.type === "tape" && resolve(fx.tape));
      void startWhenEveryoneBoughtIn(tv);
    });
    expect(tape.rounds.length).toBeGreaterThan(0);
    tv.close();
  }, 60_000);

  it("rejects bad payloads and outsiders", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const stranger = connect(url, { transports: ["websocket"] });
    const { room } = await ask(tv, "room:create", { rounds: 3 });
    expect((await ask(stranger, "room:join", { room: "zz", name: "x", playerId: "abcdefgh" })).ok).toBe(false);
    expect((await ask(stranger, "bot:add", { personality: "gary" })).error).toBe("Not the host");
    expect((await ask(stranger, "game:start")).error).toBe("Not the host");
    expect((await ask(stranger, "turn:aim", { target: 0 })).error).toMatch(/Join/);
    expect((await ask(tv, "game:start")).error).toMatch(/at least 2/);
    expect(room).toBeTruthy();
    tv.close();
    stranger.close();
  });
});
