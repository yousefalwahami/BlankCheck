import { choice, noul } from "@typesafe-ai/sdk";
import { Cheat, TAUNTS, type BotId, type TauntId } from "@blankcheck/shared";
import type { Rng } from "../engine/rng";
import type { BotView } from "../engine/views";
import { askJev } from "./jev";
import { heuristicSuspicion } from "./suspicion";
import { TAUNT_CHOICES } from "./taunts";

/*
 * Bot brains (spec §8.3–8.4). Code does the math and makes the final move; Jev only answers
 * narrow judgment calls (who to aim at, is now a good moment to cheat, did X cheat, which line).
 * Personalities are just thresholds.
 */

export type Personality = {
  accuseAt: (rng: Rng) => number;
  /** Probability of playing the card at a given opportunity, before Jev's opinion. */
  cheatDrive: (v: BotView, rng: Rng) => number;
  aim: "odds" | "leader" | "saint" | "follow";
};

export const PERSONALITIES: Record<BotId, Personality> = {
  accountant: {
    accuseAt: () => 0.9,
    cheatDrive: (v) => (v.me.card === Cheat.PEEK ? 0.9 : 0.05),
    aim: "odds",
  },
  gary: {
    accuseAt: () => 0.4,
    cheatDrive: () => 0.95,
    aim: "leader",
  },
  mercy: {
    accuseAt: () => 0.7,
    cheatDrive: (v) => (v.me.chips <= 1 ? 0.5 : 0),
    aim: "saint",
  },
  intern: {
    accuseAt: (rng) => 0.3 + rng.next() * 0.6,
    cheatDrive: () => 0.35,
    aim: "follow",
  },
};

export type BotThought = {
  /** P(chambered shell is LIVE) as this bot believes it. */
  pLive: number;
  aim: number;
  cheatNow: boolean;
  suspicion: Record<number, number>;
  taunt: TauntId | null;
  usedJev: boolean;
};

function believedPLive(v: BotView): number {
  if (v.me.peekedLive !== null) return v.me.peekedLive ? 1 : 0;
  return v.odds.pLiveNext;
}

function leader(v: BotView, rng: Rng): number {
  const max = Math.max(...v.others.map((o) => o.chips));
  return rng.pick(v.others.filter((o) => o.chips === max)).seat;
}

function weakest(v: BotView, rng: Rng): number {
  const min = Math.min(...v.others.map((o) => o.chips));
  return rng.pick(v.others.filter((o) => o.chips === min)).seat;
}

/** Code-only aim. Hard rule (spec §8.3): if the shell can't be live, shoot yourself. */
export function heuristicAim(id: BotId, v: BotView, rng: Rng): number {
  const p = believedPLive(v);
  if (p === 0) return v.me.seat;
  if (p === 1 || v.others.length === 0) return v.others.length ? leader(v, rng) : v.me.seat;
  switch (PERSONALITIES[id].aim) {
    case "odds":
      return p < 0.5 ? v.me.seat : weakest(v, rng);
    case "leader":
      return p < 0.25 ? v.me.seat : leader(v, rng);
    case "saint":
      return p <= 0.4 ? v.me.seat : rng.pick(v.others).seat;
    case "follow":
      return rng.next() < 1 - p ? v.me.seat : rng.pick(v.others).seat;
  }
}

/** Ask Jev (if configured) and combine its answers with the personality. */
export async function think(id: BotId, v: BotView, rng: Rng, opts: { wantAim: boolean; wantTaunt: boolean }): Promise<BotThought> {
  const pLive = believedPLive(v);
  const heur = heuristicSuspicion({ countIsOff: v.odds.countIsOff, seats: v.others });
  const aimOptions: Record<string, string> = {
    self: `Shoot myself. If it's a blank I keep my turn. (P(live) = ${pLive.toFixed(2)})`,
    ...Object.fromEntries(v.others.map((o) => [`seat_${o.seat}`, `Shoot ${o.name} (${o.chips} chips)`])),
  };
  const state = {
    you: v.me,
    personality: id,
    odds: { ...v.odds, pLiveBelieved: pLive },
    others: v.others,
    announced: v.announced,
    fired: v.fired,
    round: v.round + 1,
  };
  const answers =
    v.others.length > 0
      ? await askJev(state, {
          ...(opts.wantAim ? { aim: choice("Who should I shoot with the chambered shell? Think in odds.", aimOptions) } : {}),
          cheatNow: noul("Playing my cheat card right now would help me without getting caught"),
          ...Object.fromEntries(v.others.map((o) => [`sus_${o.seat}`, noul(`${o.name} played a cheat card this round`)])),
          ...(opts.wantTaunt ? { taunt: choice("Which line fits this moment best?", TAUNT_CHOICES) } : {}),
        })
      : null;

  const a = answers as Record<string, { choice?: string; noul?: number }> | null;
  let aim = heuristicAim(id, v, rng);
  if (opts.wantAim && a?.aim?.choice) {
    const c = a.aim.choice;
    const jevAim = c === "self" ? v.me.seat : Number(c.replace("seat_", ""));
    // Hard rules override Jev; the Intern follows blindly, others take Jev's pick when it agrees with the odds.
    if (pLive === 0) aim = v.me.seat;
    else if (pLive === 1 && jevAim === v.me.seat) aim = heuristicAim(id, v, rng);
    else if (id === "intern" || (jevAim === v.me.seat) === (pLive < 0.5)) aim = jevAim;
  }

  const drive = PERSONALITIES[id].cheatDrive(v, rng);
  const jevCheat = a?.cheatNow?.noul;
  const cheatP = jevCheat === undefined ? drive : drive * (0.4 + 0.6 * jevCheat);
  const cheatNow = !!v.me.card && !v.me.cardUsed && rng.next() < cheatP;

  const suspicion: Record<number, number> = {};
  for (const o of v.others) {
    const j = a?.[`sus_${o.seat}`]?.noul;
    suspicion[o.seat] = j === undefined ? heur[o.seat] : 0.65 * j + 0.35 * heur[o.seat];
  }
  const tauntChoice = a?.taunt?.choice as TauntId | undefined;
  return { pLive, aim, cheatNow, suspicion, taunt: tauntChoice && tauntChoice in TAUNTS ? tauntChoice : null, usedJev: !!answers };
}

/** Whom (if anyone) to call RIGGED! on. */
export function pickAccusation(id: BotId, v: BotView, suspicion: Record<number, number>, rng: Rng): number | null {
  if (v.me.usedRiggedThisRound) return null;
  const threshold = PERSONALITIES[id].accuseAt(rng);
  const candidates = v.others.filter((o) => !o.busted && o.chips > 0);
  if (!candidates.length) return null;
  // Guilty hands over EVERY chip; a wrong call costs one. Go after the biggest expected payout.
  const ev = (o: (typeof candidates)[number]) => (suspicion[o.seat] ?? 0) * o.chips - (1 - (suspicion[o.seat] ?? 0));
  const best = candidates.reduce((a, b) => (ev(b) > ev(a) ? b : a));
  const p = suspicion[best.seat] ?? 0;
  // A wrong call on your last chip leaves you broke; only Gary gambles like that.
  if (v.me.chips <= 1 && id !== "gary" && p < 0.95) return null;
  const juicy = id !== "accountant" && p >= 0.3 && ev(best) >= 2;
  return p >= threshold || juicy ? best.seat : null;
}

/** Card timing: HOT LOAD hurts someone else's self-shot, DUD saves you, PEEK/SWAP on your own turn. */
export function goodMomentForCard(v: BotView, ctx: { amShooter: boolean; aimingAt: number | null; shooter: number }): boolean {
  const card = v.me.card;
  if (!card || v.me.cardUsed) return false;
  switch (card) {
    case Cheat.PEEK:
      return ctx.amShooter && ctx.aimingAt === null;
    case Cheat.HOT_LOAD:
      // Someone is about to shoot someone who isn't me: make it hurt.
      return ctx.aimingAt !== null && ctx.aimingAt !== v.me.seat;
    case Cheat.DUD:
      return ctx.aimingAt === v.me.seat;
    case Cheat.SWAP:
      return ctx.amShooter ? v.odds.pLiveNext >= 0.5 : ctx.aimingAt === v.me.seat;
    default:
      return false;
  }
}
