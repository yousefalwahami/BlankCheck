import { MONEY, sha256, toHex } from "@blankcheck/shared";
import { decodeAddress } from "@thru/sdk/helpers";
import { BOOTSTRAP_PROGRAM_ADDRESSES } from "@thru/programs/bootstrap-addresses";
import type { AccountContext } from "@thru/programs/passkey-manager";
import {
  createInitializeAccountInstruction,
  createInitializeMintInstruction,
  createMintToInstruction,
  createTransferInstruction,
  deriveMintAddress,
  deriveTokenAccountAddress,
  parseMintAccountData,
  parseTokenAccountData,
} from "@thru/programs/token";
import { config } from "../config";
import type { SeatAuth } from "../engine/types";
import type { Receipt } from "../referee/Referee";
import {
  CREATING_PROOF,
  explorerAccount,
  hostAddressSync,
  hostKey,
  passkeyChallenge,
  sendHostTx,
  sendPasskeyTx,
  thru,
  walletContext,
  type IndexLookup,
} from "../thru/chain";
import type { Bank, BankAccount, WalletRef } from "./Bank";

/*
 * Play money on Thru: a Token Program mint (BCUSD, 2 decimals) whose mint authority is the house.
 *   - Wallet  = a token account owned by the player's Face ID wallet (or held by the house for bots).
 *   - Buy-in  = a $12 token transfer to the cashier, signed with Face ID through passkey-manager.
 *   - Cash-out = the cashier transfers chips × $4 back. Every move shows on scan.thru.org.
 */

const utf8 = (s: string) => new TextEncoder().encode(s);
const tokenProgram = () => config.tokenProgramAddress || BOOTSTRAP_PROGRAM_ADDRESSES.token;
const MINT_SEED_HEX = toHex(sha256(utf8("blank-check:bcusd")));
const ZERO_SEED = new Uint8Array(32);

type Derived = { address: string; bytes: Uint8Array; seed: Uint8Array; owner: string };

/** The mint's address follows from the house key and a fixed seed: no config needed. */
export function bankMintAddress(): string {
  return config.bankMintAddress || deriveMintAddress(thru(), hostAddressSync(), MINT_SEED_HEX, tokenProgram()).address;
}

async function exists(address: string): Promise<boolean> {
  try {
    const a = await thru().accounts.get(address);
    return !!a.meta;
  } catch {
    return false;
  }
}

/** Create the BCUSD mint and the cashier's token account if they're missing. Safe to run every boot. */
export async function setupBank(log: (s: string) => void = console.log): Promise<{ mint: string; cashier: string }> {
  const host = await hostKey();
  const mint = deriveMintAddress(thru(), host.address, MINT_SEED_HEX, tokenProgram());
  if (config.bankMintAddress && config.bankMintAddress !== mint.address) {
    log(`   bank: using BANK_MINT_ADDRESS ${config.bankMintAddress}`);
  } else if (!(await exists(mint.address))) {
    log(`   bank: creating the ${MONEY.ticker} mint ${mint.address}…`);
    const proof = await thru().proofs.generate({ address: mint.address, proofType: CREATING_PROOF });
    const rc = await sendHostTx({
      kind: "CREATE_MINT",
      program: tokenProgram(),
      readWrite: [mint.address],
      build: (ctx) =>
        createInitializeMintInstruction({
          mintAccountBytes: mint.bytes,
          decimals: MONEY.decimals,
          mintAuthorityBytes: host.publicKey,
          ticker: MONEY.ticker,
          seedHex: MINT_SEED_HEX,
          stateProof: proof.proof,
        })(ctx as never),
    });
    if (!rc.ok) throw new Error(`couldn't create the mint: ${rc.error}`);
  }
  const bank = new ThruBank(bankMintAddress());
  const cashier = await bank.ensureAccount({ kind: "custodial", id: "cashier" });
  return { mint: bankMintAddress(), cashier: cashier.address };
}

export class ThruBank implements Bank {
  readonly mode = "thru" as const;
  readonly ticker = MONEY.ticker;

  constructor(private readonly mint = bankMintAddress()) {}

  /** Boot check: the mint exists and the house can mint it. */
  static async check(): Promise<string> {
    const mint = bankMintAddress();
    const info = parseMintAccountData(await thru().accounts.get(mint));
    if (info.mintAuthority !== hostAddressSync()) throw new Error(`the house isn't the mint authority of ${mint}`);
    return `${info.ticker} mint ${mint}`;
  }

  async openWallet(ref: WalletRef) {
    const receipts: Receipt[] = [];
    const account = await this.ensureAccount(ref, receipts);
    // New wallet, or someone who lost it all last game: the house spots them back to the starting bankroll.
    const balance = await this.balance(account);
    if (balance < MONEY.buyInCents) {
      const d = this.derive(ref);
      const rc = await sendHostTx({
        kind: "BANKROLL",
        program: tokenProgram(),
        readWrite: [this.mint, d.address],
        build: (ctx) =>
          createMintToInstruction({
            mintAccountBytes: decodeAddress(this.mint),
            destinationAccountBytes: d.bytes,
            authorityAccountBytes: decodeAddress(hostAddressSync()),
            amount: BigInt(MONEY.bankrollCents - balance),
          })(ctx as never),
      });
      receipts.push(rc);
    }
    return { account, balanceCents: await this.balance(account), receipts };
  }

  async balance(account: BankAccount): Promise<number> {
    try {
      return Number(parseTokenAccountData(await thru().accounts.get(account.address)).amount);
    } catch {
      return 0;
    }
  }

  async challengeForBuyIn(account: BankAccount) {
    if (account.ref.kind !== "passkey") return { challenge: "", prepared: null };
    const { accountCtx, instructionData } = await this.passkeyTransfer(account);
    const challenge = await passkeyChallenge({ wallet: account.ref.wallet, accountCtx, targetProgram: tokenProgram(), instructionData });
    return { challenge, prepared: { accountCtx, instructionData } };
  }

  async buyIn(account: BankAccount, auth: SeatAuth): Promise<Receipt> {
    if (account.ref.kind === "custodial") return this.transfer("BUY_IN_$", account, this.cashier(), MONEY.buyInCents, "house");
    const prep = auth.type === "passkey" ? (auth.prepared as { accountCtx: AccountContext; instructionData: Uint8Array } | null) : null;
    if (auth.type !== "passkey" || !prep) return { kind: "BUY_IN_$", ms: 0, ok: false, mock: false, signer: "passkey", error: "passkey signature missing" };
    return sendPasskeyTx({
      kind: "BUY_IN_$",
      wallet: account.ref.wallet,
      accountCtx: prep.accountCtx,
      targetProgram: tokenProgram(),
      instructionData: prep.instructionData,
      assertion: auth.assertion,
    });
  }

  async payOut(account: BankAccount, cents: number): Promise<Receipt> {
    if (cents <= 0) return { kind: "CASH_OUT", ms: 0, ok: true, mock: false, signer: "host" };
    return this.transfer("CASH_OUT", this.cashier(), account, cents, "host");
  }

  explorerAccountUrl(address: string) {
    return explorerAccount(address);
  }

  /* ───────────── internals ───────────── */

  private derive(ref: WalletRef): Derived {
    const owner = ref.kind === "passkey" ? ref.wallet : hostAddressSync();
    const seed = ref.kind === "passkey" ? ZERO_SEED : sha256(utf8(`blank-check:custody:${ref.id}`));
    const d = deriveTokenAccountAddress(thru(), owner, this.mint, tokenProgram(), seed);
    return { address: d.address, bytes: d.bytes, seed, owner };
  }

  private cashier(): BankAccount {
    const ref: WalletRef = { kind: "custodial", id: "cashier" };
    return { address: this.derive(ref).address, ref };
  }

  /** Create the token account for this wallet if it doesn't exist yet (the house pays). */
  async ensureAccount(ref: WalletRef, receipts: Receipt[] = []): Promise<BankAccount> {
    const d = this.derive(ref);
    if (!(await exists(d.address))) {
      const proof = await thru().proofs.generate({ address: d.address, proofType: CREATING_PROOF });
      const ownerIsHost = d.owner === hostAddressSync();
      const rc = await sendHostTx({
        kind: "OPEN_WALLET",
        program: tokenProgram(),
        readWrite: [d.address],
        readOnly: ownerIsHost ? [this.mint] : [this.mint, d.owner],
        build: (ctx) =>
          createInitializeAccountInstruction({
            tokenAccountBytes: d.bytes,
            mintAccountBytes: decodeAddress(this.mint),
            ownerAccountBytes: decodeAddress(d.owner),
            seedBytes: d.seed,
            stateProof: proof.proof,
          })(ctx as never),
      });
      receipts.push(rc);
      if (!rc.ok) throw new Error(`couldn't open the wallet: ${rc.error}`);
    }
    return { address: d.address, ref };
  }

  private async passkeyTransfer(account: BankAccount) {
    const src = decodeAddress(account.address);
    const dst = decodeAddress(this.cashier().address);
    const accountCtx = walletContext((account.ref as { wallet: string }).wallet, [src, dst], [decodeAddress(tokenProgram())]);
    const instructionData = await createTransferInstruction({ sourceAccountBytes: src, destinationAccountBytes: dst, amount: BigInt(MONEY.buyInCents) })({
      getAccountIndex: (p: Uint8Array) => accountCtx.getAccountIndex(p),
    });
    return { accountCtx, instructionData };
  }

  private transfer(kind: string, from: BankAccount, to: BankAccount, cents: number, signer: Receipt["signer"]) {
    return sendHostTx({
      kind,
      program: tokenProgram(),
      readWrite: [from.address, to.address],
      signer,
      build: (ctx: IndexLookup) =>
        createTransferInstruction({ sourceAccountBytes: decodeAddress(from.address), destinationAccountBytes: decodeAddress(to.address), amount: BigInt(cents) })(
          ctx as never,
        ),
    });
  }
}
