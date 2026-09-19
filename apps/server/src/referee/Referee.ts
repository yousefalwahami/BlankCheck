import type { RefereeMode } from "@blankcheck/shared";
import type { ChainCall } from "../engine/types";

export type Receipt = {
  kind: string;
  ms: number;
  ok: boolean;
  mock: boolean;
  signature?: string;
  explorerUrl?: string;
  error?: string;
  /** Network trouble (retry) vs. a program revert (don't). */
  retryable?: boolean;
  signer: "host" | "passkey" | "house";
};

export type SeatCall = Extract<ChainCall, { kind: "pullTrigger" | "accuse" }>;

export type SeatInfo = { seat: number; wallet: string; credentialId?: string; publicKey?: string; kind: "human" | "bot" };

/**
 * One referee per room. The game never waits on this interface to decide anything:
 * the engine decides, the referee notarizes (spec §7.1).
 */
export interface Referee {
  readonly mode: RefereeMode;
  /** The house key: fee payer, table host, and the wallet bots (and host-signed seats) act with. */
  hostAddress(): string;
  /** Derive the table's address before creating it (every envelope preimage includes it). */
  prepareTable(gameId: bigint): Promise<{ address: string; key: Uint8Array }>;
  createTable(g: { gameId: bigint; wallets: string[]; hearts: number }): Promise<Receipt>;
  run(call: ChainCall): Promise<Receipt>;
  /** Build the Face ID challenge for a seat action. Called as soon as a target is picked (iOS gesture rules). */
  challengeFor(call: SeatCall, seat: SeatInfo): Promise<{ challenge: string; prepared: unknown }>;
  /** Create (or look up) the passkey wallet for a phone's credential. */
  bindWallet(credentialId: string, publicKeyHex: string): Promise<{ wallet: string; receipt?: Receipt }>;
  explorerTxUrl(signature: string): string | undefined;
  explorerAccountUrl(address: string): string | undefined;
}
