/* Limits. Must match programs/referee/src/blank_check.h. */
export const MAX_SEATS = 6;
export const MIN_SEATS = 2;
export const MAX_ROUNDS = 24;
export const MAX_WINDOWS = 16; /* seal windows per round (shots + flushes) */
export const MAX_SHELLS = 8;
export const MIN_SHELLS = 2;

/*
 * Money. Chips are the table currency; fake dollars live in each player's wallet (a Thru token,
 * or an in-memory bank offline). $12 buys 3 chips; cashing out pays $4 a chip.
 */
export const MONEY = {
  ticker: "BCUSD",
  decimals: 2,
  chipCents: 400,
  buyInChips: 3,
  buyInCents: 1200,
  /** Every new wallet is funded with this much play money (5 buy-ins). */
  bankrollCents: 6000,
} as const;

export const DEFAULT_ROUNDS = 5;
export const DEMO_ROUNDS = 3;
export const MAX_GAME_ROUNDS = 12;

export function dollars(cents: number): string {
  const sign = cents < 0 ? "−" : "";
  return `${sign}$${(Math.abs(cents) / 100).toFixed(Math.abs(cents) % 100 === 0 ? 0 : 2)}`;
}

/** Shell index meaning "no shell" in an envelope preimage. */
export const NO_SHELL = 0xff;
/** Seat index meaning "nobody" on-chain. */
export const NO_SEAT = 0xff;

export const Cheat = {
  NONE: 0,
  PEEK: 1,
  HOT_LOAD: 2,
  DUD: 3,
  SWAP: 4,
  PALM: 5,
  COPYCAT: 6,
} as const;

/** MVP cheat codes (PALM and COPYCAT are stretch cards). */
export type CheatCode = 0 | 1 | 2 | 3 | 4;
export type PlayableCheat = 1 | 2 | 3 | 4;
export const PLAYABLE_CHEATS: PlayableCheat[] = [1, 2, 3, 4];

export const CHEAT_INFO: Record<CheatCode, { key: string; name: string; emoji: string; blurb: string }> = {
  0: { key: "NONE", name: "Nothing", emoji: "✉️", blurb: "An honest envelope." },
  1: { key: "PEEK", name: "PEEK", emoji: "👁", blurb: "Privately see if the chambered shell is LIVE or BLANK." },
  2: { key: "HOT_LOAD", name: "HOT LOAD", emoji: "🔴", blurb: "The chambered shell becomes LIVE." },
  3: { key: "DUD", name: "DUD", emoji: "⚪", blurb: "The chambered shell becomes BLANK." },
  4: { key: "SWAP", name: "SWAP", emoji: "🔀", blurb: "Blindly swap the chambered shell with the next one." },
};

/** Referee instruction numbers (u32 little-endian at offset 0). */
export const IX = {
  CREATE_TABLE: 0,
  COMMIT_ROUND: 1,
  PULL_TRIGGER: 2,
  RESOLVE_SHOT: 3,
  SEAL: 4,
  ACCUSE: 5,
  REVEAL: 6,
  REVEAL_SHELLS: 7,
  BUY_IN: 8,
  END_ROUND: 9,
} as const;

/** 16-byte event kinds emitted by the referee. */
export const EVT = {
  TABLE_CREATED: 1,
  ROUND_COMMITTED: 2,
  TRIGGER_PULLED: 3,
  SHOT_RESOLVED: 4,
  SEALED: 5,
  ACCUSED: 6,
  VERDICT: 7,
  ENVELOPE_OPENED: 8,
  SHELLS_REVEALED: 9,
  GAME_OVER: 10,
  BUY_IN: 11,
  POT_AWARDED: 12,
} as const;

export const TABLE_STATUS = { LOBBY: 0, PLAYING: 1, FINISHED: 2 } as const;

/* Timings (ms). The server owns these; the UI uses them for animation. */
export const TIMING = {
  roundIntro: 3200,
  shotAnim: 1800,
  riggedTheater: 4200,
  verdictShow: 3200,
  lastCall: 5000,
  peekVisible: 2000,
  botThinkMin: 1100,
  botThinkMax: 2200,
  gameOverToTape: 2500,
  potAward: 2600,
  /** Between rounds, how long to wait for broke players to buy back in. */
  buyInWindow: 20000,
  botRebuyDelay: 1500,
} as const;

export const BOT_IDS = ["accountant", "gary", "mercy", "intern"] as const;
export type BotId = (typeof BOT_IDS)[number];

export const BOTS: Record<BotId, { name: string; emoji: string; tagline: string }> = {
  accountant: { name: "The Accountant", emoji: "🧮", tagline: "Pure odds. Rarely cheats." },
  gary: { name: "Uncle Gary", emoji: "🍺", tagline: "Cheats every round. Accuses everyone." },
  mercy: { name: "Sister Mercy", emoji: "🙏", tagline: "Never cheats. (Mostly.)" },
  intern: { name: "The Intern", emoji: "🐣", tagline: "Does whatever the model says." },
};

/** Pre-written, original trash talk. Jev picks one; it never writes prose. */
export const TAUNTS = {
  odds: "Bold move with those odds.",
  tape: "Check the tape.",
  sweat: "Somebody's sweating.",
  honest: "I have never cheated in my life.",
  count: "Funny, I counted differently.",
  face: "Look me in the Face ID.",
  chain: "The chain remembers, friend.",
  lucky: "Lucky isn't a strategy.",
  quiet: "Awfully quiet over there.",
  deal: "Deal me in. Deal me out. Whatever.",
} as const;
export type TauntId = keyof typeof TAUNTS;

export const SEAT_COLORS = ["#e4572e", "#29a19c", "#f3a712", "#a8c686", "#9b5de5", "#4ea8de"];
