import { TABLE_OFFSETS, TABLE_SIZE, TABLE_STATUS, parseTable, replayRound, toHex, verifyTapeEnvelope, verifyTapeShells } from "@blankcheck/shared";
import { describe, expect, it } from "vitest";
import { encPullTrigger, tableSeed } from "../src/referee/encode";
import { MockReferee } from "../src/referee/MockReferee";
import { ERR } from "../src/referee/program";
import { TxQueue } from "../src/referee/txQueue";
import { simulateGame } from "../src/sim";

describe("table layout", () => {
  it("matches the C struct size and key offsets", () => {
    expect(TABLE_SIZE).toBe(74850);
    expect(TABLE_OFFSETS.pot).toBe(58);
    expect(TABLE_OFFSETS.chips).toBe(60);
    expect(TABLE_OFFSETS.buyIns).toBe(72);
    expect(TABLE_OFFSETS.seatWallet).toBe(90);
    expect(TABLE_OFFSETS.env).toBe(1122);
  });
});

describe("encoding", () => {
  it("packs little-endian headers", () => {
    expect(toHex(encPullTrigger({ tableIdx: 2, walletIdx: 3, round: 1, shot: 2, shooter: 0, target: 4 }))).toBe("020000000200" + "0300" + "01020004");
    expect(toHex(tableSeed(1n)).slice(0, 26)).toBe("7461626c65" + "0100000000000000");
  });
});

describe("full games against the chain mirror", () => {
  const seeds = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel", "india", "juliet"];
  for (const [i, seed] of seeds.entries()) {
    const seats = (i % 5) + 2;
    const rounds = (i % 4) + 2;
    const rebuy = [1, 0.8, 0.5, 0][i % 4];
    it(`game "${seed}" (${seats} seats, ${rounds} rounds, rebuy ${rebuy}): every transaction is accepted and the tape verifies`, async () => {
      const { state, receipts, referee, tableKey } = await simulateGame({ seed, seats, rounds, rebuy });
      const failed = receipts.filter((r) => !r.ok);
      expect(failed, JSON.stringify(failed)).toEqual([]);
      expect(state.phase).toBe("TAPE");

      // The chain agrees with the engine about the winner, every stack, every buy-in, and the pot.
      const t = parseTable(referee.tableData()!)!;
      expect(t.status).toBe(TABLE_STATUS.FINISHED);
      expect(t.winner).toBe(state.winner);
      expect(t.chips.slice(0, state.seats.length)).toEqual(state.seats.map((x) => x.chips));
      expect(t.buyIns.slice(0, state.seats.length)).toEqual(state.seats.map((x) => x.buyIns));
      expect(t.pot).toBe(state.pot);
      // Chips are conserved: everything bought is on the table or in the pot.
      const bought = state.seats.reduce((n, x) => n + x.buyIns * 3, 0);
      expect(state.seats.reduce((n, x) => n + x.chips, 0) + state.pot).toBe(bought);

      // Every revealed envelope and shell order re-hashes to what's stored on "chain".
      const key = toHex(tableKey);
      for (const r of state.tape) {
        expect(verifyTapeShells(key, r)).toBe(true);
        expect(replayRound(r).every((x) => x.ok)).toBe(true);
        for (const e of r.envelopes) {
          expect(verifyTapeEnvelope(key, r.round, e)).toBe(true);
          expect(toHex(t.env(r.round, e.window, e.seat))).toBe(e.hash);
        }
      }
    });
  }
});

describe("the referee enforces its rules", () => {
  it("rejects a pull from the wrong seat and a forged reveal", async () => {
    const ref = new MockReferee();
    const { key } = await ref.prepareTable(7n);
    const host = ref.hostAddress();
    expect((await ref.createTable({ gameId: 7n, wallets: [host, host, host], buyInChips: 3, rounds: 2 })).ok).toBe(true);
    const commit = new Uint8Array(32);
    expect((await ref.run({ kind: "commitRound", round: 0, shellCount: 2, liveCount: 1, firstSeat: 1, commit })).ok).toBe(true);
    const wrong = await ref.run({ kind: "pullTrigger", round: 0, shot: 0, shooter: 0, target: 1, auth: { type: "host" } });
    expect(wrong.ok).toBe(false);
    expect(wrong.error).toContain("TURN");
    expect((await ref.run({ kind: "pullTrigger", round: 0, shot: 0, shooter: 1, target: 0, auth: { type: "host" } })).ok).toBe(true);
    const env = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2), new Uint8Array(32).fill(3)];
    expect((await ref.run({ kind: "resolveShot", round: 0, shot: 0, isLive: true, window: 0, envelopes: env })).ok).toBe(true);
    expect((await ref.run({ kind: "accuse", round: 0, accuser: 1, accused: 2, auth: { type: "host" } })).ok).toBe(true);
    const forged = await ref.run({ kind: "reveal", round: 0, seat: 2, mode: 0, entries: [{ cheat: 0, shell: 255, salt: new Uint8Array(32) }] });
    expect(forged.ok).toBe(false);
    expect(forged.error).toContain("HASH");
    expect(key.length).toBe(32);
    expect(ERR.HASH).toBe(0x200d);
  });

  it("a passkey seat needs a valid Face ID signature", async () => {
    const ref = new MockReferee();
    const { wallet } = await ref.bindWallet("cred", "11".repeat(64));
    const host = ref.hostAddress();
    await ref.createTable({ gameId: 9n, wallets: [wallet, host], buyInChips: 3, rounds: 2 });
    await ref.run({ kind: "commitRound", round: 0, shellCount: 2, liveCount: 1, firstSeat: 0, commit: new Uint8Array(32) });
    const r = await ref.run({
      kind: "pullTrigger",
      round: 0,
      shot: 0,
      shooter: 0,
      target: 1,
      auth: { type: "passkey", assertion: { signatureR: "01", signatureS: "02", authenticatorData: "AA==", clientDataJSON: "e30=" }, prepared: { challenge: "x", publicKey: "11".repeat(64) } },
    });
    expect(r.ok).toBe(false);
    expect(r.signer).toBe("passkey");
    expect(r.error).toContain("NOT_SEAT");
  });
});

describe("tx queue", () => {
  it("runs in order and retries network failures", async () => {
    const q = new TxQueue(2);
    const order: number[] = [];
    let flaky = 0;
    const a = q.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push(1);
      return { kind: "A", ms: 1, ok: true, mock: true, signer: "host" };
    });
    const b = q.enqueue(async () => {
      order.push(2);
      flaky++;
      return flaky < 3
        ? { kind: "B", ms: 1, ok: false, mock: true, signer: "host", retryable: true }
        : { kind: "B", ms: 1, ok: true, mock: true, signer: "host" };
    });
    expect((await a).ok).toBe(true);
    expect((await b).ok).toBe(true);
    expect(order).toEqual([1, 2, 2, 2]);
  });
});
