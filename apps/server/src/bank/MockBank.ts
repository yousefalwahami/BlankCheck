import { MONEY, dollars, randomBytes } from "@blankcheck/shared";
import type { SeatAuth } from "../engine/types";
import type { Receipt } from "../referee/Referee";
import { verifyPasskeyAssertion } from "../referee/webauthn";
import type { Bank, BankAccount, WalletRef } from "./Bank";

/**
 * An in-memory bank with the same rules as the on-chain one: wallets start with $60, buy-ins need
 * the balance (and a valid Face ID signature for passkey wallets), and the cashier pays out.
 * One per server, so a phone keeps its wallet across games.
 */
export class MockBank implements Bank {
  readonly mode = "mock" as const;
  readonly ticker = MONEY.ticker;
  private balances = new Map<string, number>();
  private cashier = 0;
  private seq = 0;

  private addressOf(ref: WalletRef) {
    return ref.kind === "passkey" ? `wallet:${ref.wallet}` : `custody:${ref.id}`;
  }

  async openWallet(ref: WalletRef) {
    const address = this.addressOf(ref);
    const receipts: Receipt[] = [];
    // New wallet, or someone who lost it all last game: the house spots them back to the starting bankroll.
    if ((this.balances.get(address) ?? 0) < MONEY.buyInCents) {
      this.balances.set(address, MONEY.bankrollCents);
      receipts.push(this.receipt("BANKROLL", true, "host"));
    }
    return { account: { address, ref }, balanceCents: this.balances.get(address)!, receipts };
  }

  async balance(account: BankAccount) {
    return this.balances.get(account.address) ?? 0;
  }

  async challengeForBuyIn(account: BankAccount) {
    const challenge = Buffer.from(randomBytes(32)).toString("base64url");
    const publicKey = account.ref.kind === "passkey" ? account.ref.publicKey : undefined;
    return { challenge, prepared: { challenge, publicKey } };
  }

  async buyIn(account: BankAccount, auth: SeatAuth): Promise<Receipt> {
    const passkey = account.ref.kind === "passkey";
    if (passkey) {
      const prep = auth.type === "passkey" ? (auth.prepared as { challenge: string; publicKey?: string } | undefined) : undefined;
      const ok = auth.type === "passkey" && !!prep?.publicKey && (await verifyPasskeyAssertion(prep.publicKey, prep.challenge, auth.assertion));
      if (!ok) return this.receipt("BUY_IN_$", false, "passkey", "Face ID signature didn't check out");
    }
    const bal = this.balances.get(account.address) ?? 0;
    if (bal < MONEY.buyInCents) return this.receipt("BUY_IN_$", false, passkey ? "passkey" : "house", `only ${dollars(bal)} in the wallet`);
    this.balances.set(account.address, bal - MONEY.buyInCents);
    this.cashier += MONEY.buyInCents;
    return this.receipt("BUY_IN_$", true, passkey ? "passkey" : "house");
  }

  async payOut(account: BankAccount, cents: number): Promise<Receipt> {
    if (cents <= 0) return this.receipt("CASH_OUT", true, "host");
    this.balances.set(account.address, (this.balances.get(account.address) ?? 0) + cents);
    this.cashier -= cents;
    return this.receipt("CASH_OUT", true, "host");
  }

  explorerAccountUrl(): string | undefined {
    return undefined;
  }

  private receipt(kind: string, ok: boolean, signer: Receipt["signer"], error?: string): Receipt {
    return { kind, ms: 1, ok, mock: true, signer, signature: `mock-bank-${++this.seq}`, error, retryable: false };
  }
}
