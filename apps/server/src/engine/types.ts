import type {
  CheatCode,
  Fx,
  GameConfig,
  PasskeyAssertion,
  Phase,
  PublicEvent,
  RiggedState,
  Seat,
  TapeRound,
  Verdict,
} from "@blankcheck/shared";
import type { Rng } from "./rng";

/** Server-side seat: the public Seat plus fields that never leave the server. */
export type SeatState = Seat & {
  playerId?: string;
  credentialId?: string;
  publicKey?: string; // hex x||y
};

export type Envelope = {
  round: number;
  window: number;
  seat: number;
  cheat: CheatCode;
  shell: number;
  salt: Uint8Array;
  hash: Uint8Array;
  caught: boolean;
};

export type SecretState = {
  /** Committed order for this round (what the hash on-chain commits to). */
  shells: (0 | 1)[];
  /** Actual shells after cheats. */
  current: (0 | 1)[];
  shellSalt: Uint8Array;
  commit: Uint8Array;
  cards: Record<number, CheatCode>;
  used: Record<number, { cheat: CheatCode; shell: number }>;
  /** Played but not yet sealed. Cleared at every seal. */
  pendingCheats: Record<number, { cheat: CheatCode; shell: number }>;
  /** Cheats applied to the chambered shell, in order. Reset after each shot. */
  chamberCheats: { seat: number; cheat: CheatCode }[];
  peeks: Record<number, { shell: number; live: boolean; until: number }>;
  /** key `${round}:${window}:${seat}` */
  envelopes: Record<string, Envelope>;
};

/** A shot as the public saw it. Safe for bots and the Pit Boss. */
export type PublicShot = {
  round: number;
  shooter: number;
  target: number;
  live: boolean;
  pLive: number;
  hesitationMs: number;
};

export type GameState = {
  room: string;
  phase: Phase;
  config: GameConfig;
  seats: SeatState[];
  round: number; // -1 before the first round
  currentSeat: number;
  aimingAt: number | null;
  announced: { live: number; blank: number };
  fired: { live: number; blank: number };
  countIsOff: boolean;
  /** Next shot index this round == index of the chambered shell. */
  shot: number;
  /** Next seal window this round. */
  window: number;
  busted: number[];
  accuseUsed: number[];
  rigged: (RiggedState & { resumePhase: Phase }) | null;
  lastCallEndsAt: number | null;
  turnStartedAt: number | null;
  lastShooter: number;
  /** Set by PULL, consumed by FIRE. */
  pendingShot: { shooter: number; target: number; hesitationMs: number; pLive: number } | null;
  /** Set by FIRE, consumed by ADVANCE. */
  lastShot: { shooter: number; target: number; live: boolean; again: boolean } | null;
  winner: number | null;
  log: PublicEvent[];
  logSeq: number;
  publicShots: PublicShot[];
  /** Table key used in every preimage (32 bytes). */
  tableKey: Uint8Array;
  /** Secret-bearing history used to build Review the Tape at the end. */
  tape: TapeRound[];
  secret: SecretState;
};

export type SeatAuth = { type: "host" } | { type: "passkey"; assertion: PasskeyAssertion; prepared?: unknown };

export type ChainCall =
  | { kind: "commitRound"; round: number; shellCount: number; liveCount: number; firstSeat: number; commit: Uint8Array }
  | { kind: "pullTrigger"; round: number; shot: number; shooter: number; target: number; auth: SeatAuth }
  | { kind: "resolveShot"; round: number; shot: number; isLive: boolean; window: number; envelopes: Uint8Array[] }
  | { kind: "seal"; round: number; window: number; envelopes: Uint8Array[] }
  | { kind: "accuse"; round: number; accuser: number; accused: number; auth: SeatAuth }
  | { kind: "reveal"; round: number; seat: number; mode: 0 | 1; entries: { cheat: number; shell: number; salt: Uint8Array }[] }
  | { kind: "revealShells"; round: number; shells: number[]; salt: Uint8Array };

export type Action =
  | { type: "START" }
  | { type: "BEGIN_TURNS" }
  | { type: "AIM"; seat: number; target: number }
  | { type: "PULL"; seat: number; auth: SeatAuth }
  | { type: "FIRE" }
  | { type: "ADVANCE" }
  | { type: "CHEAT"; seat: number }
  | { type: "ACCUSE"; accuser: number; accused: number; auth: SeatAuth }
  | { type: "VERDICT" }
  | { type: "RESUME" }
  | { type: "LAST_CALL_END" }
  | { type: "TAPE" };

export type Effect =
  /** `then` is dispatched once the call is confirmed (WAIT_FOR_CHAIN) and at least `minMs` has passed. */
  | { type: "chain"; call: ChainCall; tag: string; then?: Action; minMs?: number }
  | { type: "timer"; key: string; ms: number; action: Action }
  | { type: "cancelTimer"; key: string }
  | { type: "fx"; fx: Fx }
  | { type: "toast"; seat: number; text: string }
  /** Game over: send every tape reveal to the chain, then show the tape. */
  | { type: "tape" };

export type StepCtx = {
  rng: Rng;
  now: number;
  salt: () => Uint8Array;
};

export type StepResult = { state: GameState; effects: Effect[]; error?: string };

export type { Verdict };
