import type { Challenge, CheatCode, PrivateView, PublicState, RefereeMode, Seat } from "@blankcheck/shared";
import { isAlive, publicPLive, shellsLeft } from "./rules";
import type { GameState } from "./types";

/*
 * The security boundary (spec §9.3). The TV and every phone get publicView; each phone gets only its
 * own privateView; Jev gets botView (one bot's own secrets) or pitBossView (public only).
 */

export type ViewExtras = {
  refereeMode: RefereeMode;
  tableAddress: string | null;
  explorerUrl: string;
  onChainActions: number;
};

export function publicSeat(seat: GameState["seats"][number]): Seat {
  return {
    seat: seat.seat,
    name: seat.name,
    kind: seat.kind,
    personality: seat.personality,
    wallet: seat.wallet,
    walletReady: seat.walletReady,
    hearts: seat.hearts,
    connected: seat.connected,
  };
}

export function publicView(s: GameState, x: ViewExtras): PublicState {
  return {
    room: s.room,
    phase: s.phase,
    round: Math.max(0, s.round),
    seats: s.seats.map(publicSeat),
    currentSeat: s.currentSeat,
    aimingAt: s.aimingAt,
    announced: { ...s.announced },
    fired: { ...s.fired },
    shellsLeft: s.round < 0 ? 0 : shellsLeft(s),
    countIsOff: s.countIsOff,
    busted: [...s.busted],
    accuseUsed: [...s.accuseUsed],
    rigged: s.rigged
      ? { accuser: s.rigged.accuser, accused: s.rigged.accused, verdict: s.rigged.verdict, evidence: s.rigged.evidence, txUrl: s.rigged.txUrl }
      : null,
    lastCallEndsAt: s.lastCallEndsAt,
    turnStartedAt: s.turnStartedAt,
    winner: s.winner,
    config: { ...s.config },
    refereeMode: x.refereeMode,
    tableAddress: x.tableAddress,
    explorerUrl: x.explorerUrl,
    log: s.log.slice(-20),
    onChainActions: x.onChainActions,
  };
}

export function canCheat(s: GameState, seat: number): boolean {
  return (
    (s.phase === "AWAIT_AIM" || s.phase === "AWAIT_TRIGGER") &&
    isAlive(s, seat) &&
    s.secret.cards[seat] !== undefined &&
    !s.secret.used[seat] &&
    s.shot < s.secret.current.length
  );
}

export function canAccuse(s: GameState, seat: number): boolean {
  return (
    (s.phase === "AWAIT_AIM" || s.phase === "AWAIT_TRIGGER" || s.phase === "LAST_CALL") &&
    isAlive(s, seat) &&
    !s.accuseUsed.includes(seat)
  );
}

export function privateView(s: GameState, seat: number, now: number, challenge: Challenge | null): PrivateView {
  const peek = s.secret.peeks[seat];
  const used = s.secret.used[seat];
  const inRound = s.phase !== "LOBBY" && s.phase !== "OVER" && s.phase !== "TAPE";
  return {
    seat,
    card: inRound ? (s.secret.cards[seat] ?? null) : null,
    cardUsed: !!used,
    cardPlayedOnShell: used ? used.shell : null,
    peek: peek && peek.until > now ? { ...peek } : null,
    challenge,
    canCheat: canCheat(s, seat),
    canAccuse: canAccuse(s, seat),
    credentialId: s.seats[seat]?.credentialId ?? null,
  };
}

export type Odds = { pLiveNext: number; liveLeft: number; blankLeft: number; shellsLeft: number; countIsOff: boolean };

export function publicOdds(s: GameState): Odds {
  return {
    pLiveNext: Math.round(publicPLive(s) * 1000) / 1000,
    liveLeft: Math.max(0, s.announced.live - s.fired.live),
    blankLeft: Math.max(0, s.announced.blank - s.fired.blank),
    shellsLeft: shellsLeft(s),
    countIsOff: s.countIsOff,
  };
}

/* ───────────── Jev views ───────────── */

type PublicSeatSummary = { seat: number; name: string; hearts: number; busted: boolean; isBot: boolean };

type PublicBehavior = {
  selfShots: { pLive: number; live: boolean; hesitationMs: number }[];
  shotsAtOthers: number;
  avgHesitationMs: number;
  accusedThisRound: boolean;
};

/** What a bot may know: public state + its own card and peek + odds computed in code. */
export type BotView = {
  round: number;
  phase: GameState["phase"];
  me: {
    seat: number;
    name: string;
    hearts: number;
    card: CheatCode | null;
    cardUsed: boolean;
    /** Only if the peek was on the currently chambered shell. Someone may have swapped it since. */
    peekedLive: boolean | null;
    usedRiggedThisRound: boolean;
  };
  others: (PublicSeatSummary & PublicBehavior)[];
  odds: Odds;
  announced: { live: number; blank: number };
  fired: { live: number; blank: number };
};

/** What the Pit Boss may know: public state and public behavior only. No secret fields exist on this type. */
export type PitBossView = {
  round: number;
  announced: { live: number; blank: number };
  fired: { live: number; blank: number };
  countIsOff: boolean;
  odds: Odds;
  seats: (PublicSeatSummary & PublicBehavior)[];
};

function behavior(s: GameState, seat: number): PublicBehavior {
  const mine = s.publicShots.filter((x) => x.round === s.round && x.shooter === seat);
  const self = mine.filter((x) => x.target === seat);
  return {
    selfShots: self.map((x) => ({ pLive: Math.round(x.pLive * 100) / 100, live: x.live, hesitationMs: x.hesitationMs })),
    shotsAtOthers: mine.length - self.length,
    avgHesitationMs: mine.length ? Math.round(mine.reduce((n, x) => n + x.hesitationMs, 0) / mine.length) : 0,
    accusedThisRound: s.accuseUsed.includes(seat),
  };
}

function summary(s: GameState, seat: number): PublicSeatSummary {
  const x = s.seats[seat];
  return { seat, name: x.name, hearts: x.hearts, busted: s.busted.includes(seat), isBot: x.kind === "bot" };
}

export function botView(s: GameState, seat: number, now: number): BotView {
  const peek = s.secret.peeks[seat];
  const card = s.secret.cards[seat] ?? null;
  return {
    round: s.round,
    phase: s.phase,
    me: {
      seat,
      name: s.seats[seat].name,
      hearts: s.seats[seat].hearts,
      card,
      cardUsed: !!s.secret.used[seat],
      peekedLive: peek && peek.shell === s.shot && peek.until + 60_000 > now ? peek.live : null,
      usedRiggedThisRound: s.accuseUsed.includes(seat),
    },
    others: s.seats.filter((x) => x.seat !== seat && x.hearts > 0).map((x) => ({ ...summary(s, x.seat), ...behavior(s, x.seat) })),
    odds: publicOdds(s),
    announced: { ...s.announced },
    fired: { ...s.fired },
  };
}

export function pitBossView(s: GameState): PitBossView {
  return {
    round: s.round,
    announced: { ...s.announced },
    fired: { ...s.fired },
    countIsOff: s.countIsOff,
    odds: publicOdds(s),
    seats: s.seats.filter((x) => x.hearts > 0).map((x) => ({ ...summary(s, x.seat), ...behavior(s, x.seat) })),
  };
}
