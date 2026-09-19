import { MAX_SHELLS, MIN_SHELLS, MONEY, type Phase, type PublicEventKind } from "@blankcheck/shared";
import type { Rng } from "./rng";
import type { GameState, SeatState } from "./types";

/** Buying in is blocked only while a shot or a verdict is being settled (the chain must stay in order). */
export const BUY_IN_PHASES: Phase[] = ["LOBBY", "ROUND_START", "AWAIT_AIM", "AWAIT_TRIGGER", "LAST_CALL", "ROUND_END", "BUY_INS"];

/** A seat is in play when it has chips. Broke seats are skipped and can't be targeted. */
export const inPlay = (s: GameState, seat: number): boolean => (s.seats[seat]?.chips ?? 0) > 0;

export const fundedSeats = (s: GameState): number[] => s.seats.filter((x) => x.chips > 0).map((x) => x.seat);

/** Broke, but still has $12 in the wallet: can buy back in. */
export const canAfford = (seat: GameState["seats"][number]): boolean =>
  !seat.cleanedOut && seat.bankrollCents !== null && seat.bankrollCents >= MONEY.buyInCents;

/**
 * Next seat with chips clockwise after `from` (never `from` itself unless it's the only one).
 * Must match bc_next_seat() in programs/referee/src/blank_check.c.
 */
export function nextFunded(s: GameState, from: number): number {
  const n = s.seats.length;
  for (let i = 1; i <= n; i++) {
    const c = (from + i) % n;
    if (inPlay(s, c)) return c;
  }
  return from;
}

/**
 * The chip leaders who split the pot: everyone tied for the most chips (0 chips never leads).
 * Must match bc_end_round() in blank_check.c.
 */
export function potLeaders(s: GameState): number[] {
  const max = Math.max(0, ...s.seats.map((x) => x.chips));
  return max > 0 ? s.seats.filter((x) => x.chips === max).map((x) => x.seat) : [];
}

/** Profit in chips (chips − buy-ins × 3). The on-chain winner uses the same ranking. */
export const profitChips = (seat: GameState["seats"][number]): number => seat.chips - seat.buyIns * MONEY.buyInChips;

/** total in [2, 8], live in [1, total - 1], shuffled. */
export function generateShells(rng: Rng): (0 | 1)[] {
  const total = rng.int(MIN_SHELLS, MAX_SHELLS);
  const live = rng.int(1, total - 1);
  const shells: (0 | 1)[] = Array.from({ length: total }, (_, i) => (i < live ? 1 : 0));
  return rng.shuffle(shells);
}

export function shellsLeft(s: GameState): number {
  return Math.max(0, s.secret.shells.length - s.shot);
}

/** Public odds that the chambered shell is LIVE, from announced minus fired counts only. */
export function publicPLive(s: GameState): number {
  const liveLeft = Math.max(0, s.announced.live - s.fired.live);
  const blankLeft = Math.max(0, s.announced.blank - s.fired.blank);
  if (liveLeft + blankLeft === 0) return 0.5;
  return liveLeft / (liveLeft + blankLeft);
}

export function seatName(s: GameState, seat: number): string {
  return s.seats[seat]?.name ?? `Seat ${seat + 1}`;
}

export function pushLog(s: GameState, now: number, kind: PublicEventKind, text: string, seat?: number): void {
  s.log.push({ id: ++s.logSeq, t: now, kind, text, seat });
  if (s.log.length > 60) s.log.splice(0, s.log.length - 60);
}

export function envelopeKey(round: number, window: number, seat: number): string {
  return `${round}:${window}:${seat}`;
}

export function emptySecret(): GameState["secret"] {
  return {
    shells: [],
    current: [],
    shellSalt: new Uint8Array(32),
    commit: new Uint8Array(32),
    cards: {},
    used: {},
    pendingCheats: {},
    chamberCheats: [],
    peeks: {},
    envelopes: {},
  };
}

export function newGameState(room: string, config: GameState["config"], tableKey: Uint8Array = new Uint8Array(32)): GameState {
  return {
    room,
    phase: "LOBBY",
    config,
    seats: [],
    round: -1,
    currentSeat: 0,
    aimingAt: null,
    announced: { live: 0, blank: 0 },
    fired: { live: 0, blank: 0 },
    countIsOff: false,
    shot: 0,
    window: 0,
    pot: 0,
    busted: [],
    accuseUsed: [],
    rigged: null,
    lastCallEndsAt: null,
    buyInsEndAt: null,
    turnStartedAt: null,
    lastShooter: -1,
    pendingShot: null,
    lastShot: null,
    winner: null,
    results: null,
    log: [],
    logSeq: 0,
    publicShots: [],
    tableKey,
    tape: [],
    secret: emptySecret(),
  };
}

export function makeSeat(seat: number, name: string, kind: SeatState["kind"], extra: Partial<SeatState> = {}): SeatState {
  return {
    seat,
    name,
    kind,
    wallet: "",
    walletReady: false,
    chips: 0,
    buyIns: 0,
    bankrollCents: null,
    cleanedOut: false,
    connected: kind === "bot",
    ...extra,
  };
}
