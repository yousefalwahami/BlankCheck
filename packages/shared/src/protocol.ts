import { z } from "zod";
import { BOT_IDS, MAX_SEATS } from "./constants";

/* Socket.IO event names. Payloads from clients are validated with the schemas below. */
export const C2S = {
  roomCreate: "room:create",
  hostAttach: "host:attach",
  hostConfig: "host:config",
  botAdd: "bot:add",
  seatKick: "seat:kick",
  gameStart: "game:start",
  gameRestart: "game:restart",
  roomJoin: "room:join",
  walletBind: "wallet:bind",
  turnAim: "turn:aim",
  turnSigned: "turn:signed",
  cheatPlay: "cheat:play",
  riggedStart: "rigged:start",
  riggedSigned: "rigged:signed",
  riggedCancel: "rigged:cancel",
  boo: "ghost:boo",
} as const;

export const S2C = {
  state: "state",
  private: "private",
  fx: "fx",
  chainTx: "chain:tx",
  pitboss: "pitboss",
  toast: "toast",
} as const;

const seatIdx = z.number().int().min(0).max(MAX_SEATS - 1);
const roomCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{4}$/, "Room codes are 4 letters");

export const RoomCreateSchema = z.object({
  hearts: z.number().int().min(1).max(5).default(3),
  faceIdOnTrigger: z.boolean().default(true),
});

export const HostAttachSchema = z.object({ room: roomCode, hostToken: z.string().min(8).max(128) });

export const HostConfigSchema = z.object({
  hearts: z.number().int().min(1).max(5).optional(),
  faceIdOnTrigger: z.boolean().optional(),
});

export const BotAddSchema = z.object({ personality: z.enum(BOT_IDS) });
export const SeatKickSchema = z.object({ seat: seatIdx });

export const RoomJoinSchema = z.object({
  room: roomCode,
  name: z.string().trim().min(1).max(16),
  /** Random id kept by the phone so a refresh gets the same seat back. */
  playerId: z.string().min(8).max(64),
});

export const WalletBindSchema = z.object({
  credentialId: z.string().min(1).max(512),
  /** P-256 public key: hex of x(32) || y(32). */
  publicKey: z.string().regex(/^[0-9a-fA-F]{128}$/),
});

export const TurnAimSchema = z.object({ target: seatIdx });

export const PasskeyAssertionSchema = z.object({
  signatureR: z.string().regex(/^[0-9a-fA-F]{1,64}$/),
  signatureS: z.string().regex(/^[0-9a-fA-F]{1,64}$/),
  authenticatorData: z.string().min(1).max(4096),
  clientDataJSON: z.string().min(1).max(8192),
});

export const SignedSchema = z.object({
  challengeId: z.string().min(1).max(64),
  assertion: PasskeyAssertionSchema.optional(),
});

export const RiggedStartSchema = z.object({ accused: seatIdx });

export type Ack<T = {}> = ({ ok: true } & T) | { ok: false; error: string };
