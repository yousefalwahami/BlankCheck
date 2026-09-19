import { randomBytes } from "@blankcheck/shared";
import { seededRng, type Rng } from "./engine/rng";
import { makeSeat, newGameState, livingSeats, isAlive } from "./engine/rules";
import { step } from "./engine/step";
import type { Action, ChainCall, GameState } from "./engine/types";
import { canAccuse, canCheat } from "./engine/views";
import { MockReferee } from "./referee/MockReferee";
import type { Receipt, Referee } from "./referee/Referee";

export type HeadlessOpts = {
  seed: string;
  seats?: number;
  hearts?: number;
  deterministicSalts?: boolean;
  gameId?: bigint;
  /** Called after every chain receipt (the chain smoke test prints these live). */
  onReceipt?: (r: Receipt, call: ChainCall | "createTable") => void;
};

/**
 * Plays a whole game headlessly with random legal moves against any referee. Every seat is a bot
 * signed by the house key. Used by tests (MockReferee), the C trace recorder, and the chain smoke test.
 */
export async function playHeadless(referee: Referee, opts: HeadlessOpts) {
  const rng = seededRng(opts.seed);
  const policy = seededRng(`${opts.seed}:policy`);
  let saltN = 0;
  const salt = opts.deterministicSalts
    ? () => {
        const b = new Uint8Array(32);
        new DataView(b.buffer).setUint32(0, ++saltN, true);
        return b;
      }
    : () => randomBytes(32);

  const seededId = BigInt(rng.int(1, 2 ** 31));
  const gameId = opts.gameId ?? seededId; // a real chain needs a fresh table per run
  const { key, address } = await referee.prepareTable(gameId);
  let s = newGameState("SIMS", { hearts: opts.hearts ?? 2, faceIdOnTrigger: false }, key);
  const n = opts.seats ?? 4;
  for (let i = 0; i < n; i++) s.seats.push(makeSeat(i, `Bot${i}`, "bot", { wallet: referee.hostAddress(), walletReady: true }));

  const receipts: Receipt[] = [];
  const created = await referee.createTable({ gameId, wallets: s.seats.map((x) => x.wallet), hearts: s.config.hearts });
  receipts.push(created);
  opts.onReceipt?.(created, "createTable");

  let clock = 1_000;
  let timer: Action | null = null;
  const thenQueue: Action[] = [];
  let tapeRequested = false;

  const dispatch = async (a: Action): Promise<string | undefined> => {
    clock += 50;
    const r = step(s, a, { rng, now: clock, salt });
    if (r.error) return r.error;
    s = r.state;
    for (const e of r.effects) {
      if (e.type === "chain") {
        const rc = await referee.run(e.call);
        receipts.push(rc);
        opts.onReceipt?.(rc, e.call);
        if (e.then) thenQueue.push(e.then);
      } else if (e.type === "timer") timer = e.action;
      else if (e.type === "cancelTimer") timer = null;
      else if (e.type === "tape") tapeRequested = true;
    }
    return undefined;
  };

  await dispatch({ type: "START" });
  for (let guard = 0; guard < 5000 && !tapeRequested; guard++) {
    if (thenQueue.length) {
      await dispatch(thenQueue.shift()!);
      continue;
    }
    if (await randomMove(s, policy, dispatch)) continue;
    if (timer) {
      const t: Action = timer;
      timer = null;
      await dispatch(t);
      continue;
    }
    throw new Error(`simulation stuck in ${s.phase}`);
  }
  return { state: s, receipts, gameId, tableKey: key, tableAddress: address };
}

/** playHeadless against the in-memory chain mirror. */
export async function simulateGame(opts: HeadlessOpts & { trace?: boolean }) {
  const referee = new MockReferee();
  if (opts.trace) referee.trace = [];
  const out = await playHeadless(referee, opts);
  return { ...out, referee };
}

async function randomMove(s: GameState, p: Rng, dispatch: (a: Action) => Promise<string | undefined>): Promise<boolean> {
  const alive = livingSeats(s);
  if (s.phase === "AWAIT_AIM" || s.phase === "AWAIT_TRIGGER") {
    const roll = p.next();
    if (roll < 0.25) {
      const cheaters = alive.filter((x) => canCheat(s, x));
      if (cheaters.length) return !(await dispatch({ type: "CHEAT", seat: p.pick(cheaters) }));
    }
    if (roll < 0.35) {
      const accusers = alive.filter((x) => canAccuse(s, x));
      if (accusers.length) {
        const accuser = p.pick(accusers);
        const targets = alive.filter((x) => x !== accuser && !s.busted.includes(x));
        if (targets.length) return !(await dispatch({ type: "ACCUSE", accuser, accused: p.pick(targets), auth: { type: "host" } }));
      }
    }
    if (s.phase === "AWAIT_AIM") {
      const target = p.next() < 0.4 ? s.currentSeat : p.pick(alive);
      return !(await dispatch({ type: "AIM", seat: s.currentSeat, target }));
    }
    if (s.aimingAt !== null && isAlive(s, s.aimingAt)) return !(await dispatch({ type: "PULL", seat: s.currentSeat, auth: { type: "host" } }));
  }
  if (s.phase === "LAST_CALL" && p.next() < 0.3) {
    const accusers = alive.filter((x) => canAccuse(s, x));
    if (accusers.length) {
      const accuser = p.pick(accusers);
      const targets = alive.filter((x) => x !== accuser && !s.busted.includes(x));
      if (targets.length) return !(await dispatch({ type: "ACCUSE", accuser, accused: p.pick(targets), auth: { type: "host" } }));
    }
  }
  return false;
}
