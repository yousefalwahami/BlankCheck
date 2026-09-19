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

describe("a full game over sockets", () => {
  it("TV + one phone + three bots play to Review the Tape", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const phone = connect(url, { transports: ["websocket"] });
    const txs: ChainTx[] = [];
    const fxs: Fx["type"][] = [];
    tv.on("chain:tx", (t: ChainTx) => txs.push(t));

    const created = await ask(tv, "room:create", { hearts: 2, faceIdOnTrigger: true });
    expect(created.ok).toBe(true);
    const room = created.room as string;
    expect(room).toMatch(/^[A-Z]{4}$/);

    const joined = await ask(phone, "room:join", { room, name: "Maya", playerId: "player-maya-1" });
    expect(joined).toMatchObject({ ok: true, seat: 0 });
    for (const personality of ["gary", "accountant", "mercy"]) expect((await ask(tv, "bot:add", { personality })).ok).toBe(true);

    // The phone plays: aim at itself on good odds, else at the next seat. Always takes the challenge.
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
        if (priv.canCheat && Math.random() < 0.3) await ask(phone, "cheat:play");
        if (state.currentSeat === 0 && state.phase === "AWAIT_AIM") {
          const live = state.announced.live - state.fired.live;
          const blank = state.announced.blank - state.fired.blank;
          const others = state.seats.filter((x) => x.seat !== 0 && x.hearts > 0);
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
      void ask(tv, "game:start").then((r) => expect(r.ok).toBe(true));
    });

    expect(fxs).toContain("round");
    expect(fxs).toContain("shot");
    expect(fxs).toContain("gameOver");
    expect(txs.length).toBeGreaterThan(5);
    expect(txs.filter((t) => !t.ok)).toEqual([]);
    expect(tape.failedTxs).toBe(0);

    for (const r of tape.rounds) {
      expect(verifyTapeShells(tape.tableKey, r)).toBe(true);
      expect(replayRound(r).every((x) => x.ok)).toBe(true);
      for (const e of r.envelopes) {
        expect(verifyTapeEnvelope(tape.tableKey, r.round, e)).toBe(true);
        expect(e.revealOk).toBe(true);
      }
      expect(r.shellsOk).toBe(true);
    }
    expect(computeAwards(tape)).toHaveLength(6);

    tv.close();
    phone.close();
  }, 60_000);

  it("a player who drops out doesn't freeze the table", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const phone = connect(url, { transports: ["websocket"] });
    const { room } = await ask(tv, "room:create", { hearts: 1 });
    expect((await ask(phone, "room:join", { room, name: "Ghost", playerId: "player-ghost-1" })).ok).toBe(true);
    await ask(tv, "bot:add", { personality: "accountant" });
    await ask(tv, "bot:add", { personality: "intern" });
    phone.close(); // gone before the game even starts
    const tape = await new Promise<TapeData>((resolve) => {
      tv.on("fx", (fx: Fx) => fx.type === "tape" && resolve(fx.tape));
      void ask(tv, "game:start");
    });
    expect(tape.rounds.length).toBeGreaterThan(0);
    tv.close();
  }, 60_000);

  it("rejects bad payloads and outsiders", async () => {
    const tv = connect(url, { transports: ["websocket"] });
    const stranger = connect(url, { transports: ["websocket"] });
    const { room } = await ask(tv, "room:create", { hearts: 3 });
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
