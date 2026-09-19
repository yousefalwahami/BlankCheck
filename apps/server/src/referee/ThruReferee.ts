import { deriveProgramAddress } from "@thru/sdk";
import { decodeAddress, decodeSignature } from "@thru/sdk/helpers";
import { createPasskeyWallet } from "@thru/passkey/server";
import type { AccountContext } from "@thru/programs/passkey-manager";
import { fromHex } from "@blankcheck/shared";
import { config } from "../config";
import type { ChainCall } from "../engine/types";
import {
  CREATING_PROOF,
  explorerAccount,
  explorerTx,
  forgetNonce,
  hostAddressSync,
  hostKey,
  passkeyChallenge,
  sendHostTx,
  sendPasskeyTx,
  thru,
  walletContext,
  type IndexLookup,
} from "../thru/chain";
import {
  encAccuse,
  encBuyIn,
  encCommitRound,
  encCreateTable,
  encEndRound,
  encPullTrigger,
  encResolveShot,
  encReveal,
  encRevealShells,
  encSeal,
  tableSeed,
} from "./encode";
import { ERR_NAMES } from "./program";
import type { Receipt, Referee, SeatCall, SeatInfo } from "./Referee";

/*
 * The real referee: every call is a transaction to the C program on Thru alphanet.
 *   - Host instructions are signed by the house key (fee payer + table host).
 *   - Seat instructions for Face ID seats go through the passkey-manager program: the phone signs a
 *     challenge over (wallet nonce, ordered accounts, our instruction bytes), and `validate` CPIs into
 *     the referee with the wallet authorized. The house still pays the fee.
 */

const describe = (code: bigint) => ERR_NAMES[Number(code)] ?? `0x${code.toString(16)}`;

export class ThruReferee implements Referee {
  readonly mode = "thru" as const;
  private table: { gameId: bigint; address: string; bytes: Uint8Array; wallets: string[] } | null = null;
  private readonly program = config.refereeProgramAddress;

  constructor() {
    if (!this.program) throw new Error("REFEREE_PROGRAM_ADDRESS is not set");
  }

  /** Call once at boot: fails fast on a bad key / RPC so we can fall back to the mock. */
  static async check(): Promise<string> {
    const k = await hostKey();
    const acct = await thru().accounts.get(k.address);
    return `${k.address} (balance ${acct.meta?.balance ?? 0n})`;
  }

  hostAddress(): string {
    return hostAddressSync();
  }

  async prepareTable(gameId: bigint) {
    const { bytes, address } = deriveProgramAddress({ programAddress: this.program, seed: tableSeed(gameId) });
    return { address, key: bytes };
  }

  async createTable(g: { gameId: bigint; wallets: string[]; buyInChips: number; rounds: number }): Promise<Receipt> {
    const { address, key } = await this.prepareTable(g.gameId);
    this.table = { gameId: g.gameId, address, bytes: key, wallets: g.wallets };
    const proof = await thru()
      .proofs.generate({ address, proofType: CREATING_PROOF })
      .catch(() => null);
    if (!proof) return { kind: "CREATE_TABLE", ms: 0, ok: false, mock: false, signer: "host", error: "couldn't get a creating state proof", retryable: true };
    return this.host("CREATE_TABLE", (ctx) =>
      encCreateTable({
        tableIdx: ctx.getAccountIndex(address),
        gameId: g.gameId,
        buyInChips: g.buyInChips,
        rounds: g.rounds,
        wallets: g.wallets.map(decodeAddress),
        proof: proof.proof,
      }),
    );
  }

  async run(call: ChainCall): Promise<Receipt> {
    const t = this.table;
    if (!t) return { kind: call.kind, ms: 0, ok: false, mock: false, signer: "host", error: "no table" };
    const at = (ctx: IndexLookup) => ({ tableIdx: ctx.getAccountIndex(t.address) });
    switch (call.kind) {
      case "commitRound":
        return this.host("COMMIT_ROUND", (ctx) => encCommitRound({ ...at(ctx), ...call }));
      case "resolveShot":
        return this.host("RESOLVE_SHOT", (ctx) => encResolveShot({ ...at(ctx), ...call }));
      case "seal":
        return this.host("SEAL", (ctx) => encSeal({ ...at(ctx), ...call }));
      case "reveal":
        return this.host(call.mode === 0 ? "REVEAL" : "REVEAL_TAPE", (ctx) => encReveal({ ...at(ctx), ...call }));
      case "revealShells":
        return this.host("REVEAL_SHELLS", (ctx) => encRevealShells({ ...at(ctx), ...call }));
      case "buyIn": {
        const payment = new Uint8Array(64);
        if (call.paymentTx) {
          try {
            payment.set(decodeSignature(call.paymentTx).subarray(0, 64));
          } catch {
            /* not a Thru signature (offline bank): leave zeros */
          }
        }
        return this.host("BUY_IN", (ctx) => encBuyIn({ ...at(ctx), round: call.round, seat: call.seat, payment }));
      }
      case "endRound":
        return this.host("END_ROUND", (ctx) => encEndRound({ ...at(ctx), round: call.round }));
      case "pullTrigger":
      case "accuse":
        return this.seatTx(call);
    }
  }

  async challengeFor(call: SeatCall, seat: SeatInfo) {
    if (!this.table) throw new Error("no table yet");
    const accountCtx = this.seatContext(seat.wallet);
    const instructionData = this.seatInstruction(call, accountCtx, seat.wallet);
    const challenge = await passkeyChallenge({ wallet: seat.wallet, accountCtx, targetProgram: this.program, instructionData });
    return { challenge, prepared: { accountCtx, instructionData, wallet: seat.wallet } };
  }

  async bindWallet(credentialId: string, publicKeyHex: string) {
    const host = await hostKey();
    const pk = fromHex(publicKeyHex);
    const t0 = performance.now();
    // createPasskeyWallet serializes on the shared fee-payer queue itself.
    const { walletAddress } = await createPasskeyWallet({
      client: thru() as never,
      adminPublicKey: host.publicKey,
      adminPrivateKey: host.privateKey,
      adminAddress: host.address,
      pubkeyX: pk.slice(0, 32),
      pubkeyY: pk.slice(32, 64),
      walletName: "blank-check",
    });
    forgetNonce();
    void credentialId;
    return { wallet: walletAddress, receipt: { kind: "WALLET", ms: Math.round(performance.now() - t0), ok: true, mock: false, signer: "host" as const } };
  }

  explorerTxUrl(signature: string) {
    return explorerTx(signature);
  }

  explorerAccountUrl(address: string) {
    return explorerAccount(address);
  }

  /* ───────────── internals ───────────── */

  private host(kind: string, build: (ctx: IndexLookup) => Uint8Array, signer: Receipt["signer"] = "host") {
    return sendHostTx({ kind, program: this.program, readWrite: [this.table!.address], build, signer, describe });
  }

  private seatContext(wallet: string): AccountContext {
    return walletContext(wallet, [this.table!.bytes], [decodeAddress(this.program)]);
  }

  private seatInstruction(call: SeatCall, ctx: AccountContext, wallet: string): Uint8Array {
    const tableIdx = ctx.getAccountIndex(this.table!.bytes);
    const walletIdx = ctx.getAccountIndex(decodeAddress(wallet));
    return call.kind === "pullTrigger"
      ? encPullTrigger({ tableIdx, walletIdx, round: call.round, shot: call.shot, shooter: call.shooter, target: call.target })
      : encAccuse({ tableIdx, walletIdx, round: call.round, accuser: call.accuser, accused: call.accused });
  }

  private async seatTx(call: SeatCall): Promise<Receipt> {
    const t = this.table!;
    const seat = call.kind === "pullTrigger" ? call.shooter : call.accuser;
    const wallet = t.wallets[seat];
    const kind = call.kind === "pullTrigger" ? "PULL_TRIGGER" : "ACCUSE";

    // Bots and house-signed seats: the house key is the seat wallet (fee payer = index 0).
    if (!wallet || wallet === hostAddressSync()) {
      return this.host(
        kind,
        (ctx) =>
          call.kind === "pullTrigger"
            ? encPullTrigger({ tableIdx: ctx.getAccountIndex(t.address), walletIdx: 0, round: call.round, shot: call.shot, shooter: call.shooter, target: call.target })
            : encAccuse({ tableIdx: ctx.getAccountIndex(t.address), walletIdx: 0, round: call.round, accuser: call.accuser, accused: call.accused }),
        "house",
      );
    }

    if (call.auth.type !== "passkey") return { kind, ms: 0, ok: false, mock: false, signer: "passkey", error: "Face ID signature missing", retryable: false };
    const prep = call.auth.prepared as { accountCtx: AccountContext; instructionData: Uint8Array } | undefined;
    if (!prep) return { kind, ms: 0, ok: false, mock: false, signer: "passkey", error: "no prepared challenge", retryable: false };
    return sendPasskeyTx({
      kind,
      wallet,
      accountCtx: prep.accountCtx,
      targetProgram: this.program,
      instructionData: prep.instructionData,
      assertion: call.auth.assertion,
      describe,
    });
  }
}
