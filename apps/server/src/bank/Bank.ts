import type { RefereeMode } from "@blankcheck/shared";
import type { SeatAuth } from "../engine/types";
import type { Receipt } from "../referee/Referee";

/*
 * The cashier. Chips live on the table (in the referee); dollars live in wallets (here).
 *   - A player's wallet is either their own Face ID wallet ("passkey": they sign buy-ins) or a
 *     house-held play wallet ("custodial": bots, and phones that can't do passkeys).
 *   - Buying in moves $12 from the wallet to the cashier; cashing out pays chips × $4 back.
 */

export type WalletRef = { kind: "passkey"; wallet: string; publicKey?: string } | { kind: "custodial"; id: string };

export type BankAccount = { address: string; ref: WalletRef };

export interface Bank {
  readonly mode: RefereeMode;
  readonly ticker: string;
  /** Find or open this player's wallet. New wallets are funded with the starting bankroll. */
  openWallet(ref: WalletRef): Promise<{ account: BankAccount; balanceCents: number; receipts: Receipt[] }>;
  balance(account: BankAccount): Promise<number>;
  /** Face ID challenge for a $12 transfer out of a passkey wallet (prefetched before the tap). */
  challengeForBuyIn(account: BankAccount): Promise<{ challenge: string; prepared: unknown }>;
  /** $12 from the player's wallet to the cashier. Passkey wallets need the Face ID assertion. */
  buyIn(account: BankAccount, auth: SeatAuth): Promise<Receipt>;
  /** Pay the player from the cashier (chips × $4 at cash-out, or a refund). */
  payOut(account: BankAccount, cents: number): Promise<Receipt>;
  explorerAccountUrl(address: string): string | undefined;
}
