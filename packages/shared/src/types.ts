import type { BotId, CheatCode, TauntId } from "./constants";

export type Phase =
  | "LOBBY"
  | "ROUND_START"
  | "AWAIT_AIM"
  | "AWAIT_TRIGGER"
  | "RESOLVING"
  | "RIGGED"
  | "LAST_CALL"
  | "TAPE"
  | "OVER";

export type RefereeMode = "mock" | "thru";

export type Seat = {
  seat: number;
  name: string;
  kind: "human" | "bot";
  personality?: BotId;
  /** Passkey wallet address (humans) or host address (bots). Empty until bound. */
  wallet: string;
  walletReady: boolean;
  hearts: number;
  connected: boolean;
};

export type PublicEventKind = "round" | "shot" | "rigged" | "verdict" | "elim" | "mismatch" | "join" | "info" | "win" | "taunt";

export type PublicEvent = {
  id: number;
  t: number;
  kind: PublicEventKind;
  text: string;
  seat?: number;
};

export type Verdict = "GUILTY" | "INNOCENT";

export type EvidenceItem = { window: number; cheat: CheatCode; shell: number };

export type RiggedState = {
  accuser: number;
  accused: number;
  verdict: Verdict | null;
  /** Filled in once the envelopes are opened. Only the accused's envelopes, only this round. */
  evidence: EvidenceItem[] | null;
  txUrl?: string;
};

export type GameConfig = {
  hearts: number;
  faceIdOnTrigger: boolean;
};

/** Everything the TV and every phone may see. Never contains secrets. */
export type PublicState = {
  room: string;
  phase: Phase;
  round: number; // 0-based; UI shows round + 1
  seats: Seat[];
  currentSeat: number;
  aimingAt: number | null;
  announced: { live: number; blank: number };
  fired: { live: number; blank: number };
  shellsLeft: number;
  countIsOff: boolean;
  busted: number[];
  accuseUsed: number[];
  rigged: RiggedState | null;
  lastCallEndsAt: number | null;
  turnStartedAt: number | null;
  winner: number | null;
  config: GameConfig;
  refereeMode: RefereeMode;
  tableAddress: string | null;
  explorerUrl: string;
  log: PublicEvent[];
  onChainActions: number;
};

export type Challenge = {
  id: string;
  kind: "trigger" | "accuse";
  /** base64url challenge for WebAuthn. */
  challenge: string;
  target?: number;
  accused?: number;
  /** When false the server accepts a tap without a passkey assertion. */
  requirePasskey: boolean;
};

/** Only ever sent to the phone of `seat`. */
export type PrivateView = {
  seat: number;
  card: CheatCode | null;
  cardUsed: boolean;
  cardPlayedOnShell: number | null;
  peek: { shell: number; live: boolean; until: number } | null;
  challenge: Challenge | null;
  canCheat: boolean;
  canAccuse: boolean;
  credentialId: string | null;
};

export type PasskeyAssertion = {
  signatureR: string; // hex
  signatureS: string; // hex
  authenticatorData: string; // base64
  clientDataJSON: string; // base64
};

export type Fx =
  | { type: "round"; round: number; live: number; blank: number }
  | {
      type: "shot";
      shooter: number;
      target: number;
      live: boolean;
      heartsLeft: number;
      eliminated: boolean;
      again: boolean;
    }
  | { type: "mismatch"; which: "live" | "blank" }
  | { type: "rigged"; accuser: number; accused: number }
  | { type: "verdict"; accuser: number; accused: number; verdict: Verdict; evidence: EvidenceItem[]; loser: number; eliminated: boolean }
  | { type: "lastCall"; endsAt: number }
  | { type: "taunt"; seat: number; taunt: TauntId; text: string }
  | { type: "gameOver"; winner: number }
  | { type: "tape"; tape: TapeData }
  | { type: "boo"; seat: number };

export type ChainTx = {
  id: number;
  kind: string;
  seat?: number;
  ms: number;
  ok: boolean;
  mock: boolean;
  signature?: string;
  explorerUrl?: string;
  /** e.g. "🤖 signed by house key" or "🔐 signed by Face ID". */
  signer?: "host" | "passkey" | "house";
  error?: string;
  at: number;
};

export type PitBossReading = Record<number, number>;

/* ───────────── Review the Tape ───────────── */

export type TapeShot = {
  shot: number;
  window: number;
  shooter: number;
  target: number;
  shellIndex: number;
  committed: 0 | 1;
  fired: 0 | 1;
  /** Cheats that touched this shell, in the order the server applied them. */
  cheats: { seat: number; cheat: CheatCode }[];
  /** Public odds of LIVE (from announced counts) when the trigger was pulled. */
  pLiveAnnounced: number;
  hesitationMs: number;
  triggerTx?: string;
  resolveTx?: string;
};

export type TapeEnvelope = {
  window: number;
  seat: number;
  cheat: CheatCode;
  shell: number;
  salt: string; // hex
  hash: string; // hex, as sealed on-chain
  sealTx?: string;
  revealTx?: string;
  /** The referee program accepted the reveal (it reverts on any mismatch). */
  revealOk?: boolean;
  /** Opened by a RIGGED! verdict during the game. */
  caught: boolean;
};

export type TapeAccusation = {
  accuser: number;
  accused: number;
  verdict: Verdict;
  window: number;
  tx?: string;
};

export type TapeRound = {
  round: number;
  shells: (0 | 1)[];
  shellSalt: string; // hex
  commit: string; // hex
  announced: { live: number; blank: number };
  firstSeat: number;
  commitTx?: string;
  revealShellsTx?: string;
  shellsOk?: boolean;
  shots: TapeShot[];
  envelopes: TapeEnvelope[];
  accusations: TapeAccusation[];
};

export type TapeData = {
  room: string;
  refereeMode: RefereeMode;
  /** 32-byte table key used in every preimage (hex). */
  tableKey: string;
  tableAddress: string | null;
  explorerUrl: string;
  seats: { seat: number; name: string; kind: "human" | "bot"; personality?: BotId }[];
  winner: number;
  rounds: TapeRound[];
  onChainActions: number;
  failedTxs: number;
};

export type Award = {
  id: "liar" | "accuser" | "honest" | "sharpshooter" | "luckiest" | "slowest";
  emoji: string;
  title: string;
  /** Winners (ties share an award). Empty when nobody qualifies. */
  seats: number[];
  detail: string;
};
