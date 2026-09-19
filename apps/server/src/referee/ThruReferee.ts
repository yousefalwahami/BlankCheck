import { createThruClient, deriveProgramAddress, keys, type Thru } from "@thru/sdk";
import { decodeAddress, encodeAddress, encodeSignature } from "@thru/sdk/helpers";
import { createPasskeyChallenge, createPasskeyWallet, submitPasskeyTransaction } from "@thru/passkey/server";
import { PASSKEY_MANAGER_PROGRAM_ADDRESS, buildAccountContext, type AccountContext } from "@thru/programs/passkey-manager";
import { fromHex } from "@blankcheck/shared";
import { config } from "../config";
import type { ChainCall } from "../engine/types";
import {
  encAccuse,
  encCommitRound,
  encCreateTable,
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
 *   - Seat instructions for passkey seats go through the passkey-manager program: the phone's
 *     Face ID signs a challenge over (wallet nonce, ordered accounts, our instruction bytes), and
 *     `validate` CPIs into the referee with the wallet authorized. The house still pays the fee.
 */

const CREATING_PROOF = 1; // StateProofType.CREATING
const SUBMISSION_ACCEPTED = 2;

/** Same global queue @thru/passkey/server uses, so our txs and its txs never race on the fee payer nonce. */
const feePayerQueues = (): Map<string, Promise<void>> => {
  const g = globalThis as typeof globalThis & { [k: symbol]: Map<string, Promise<void>> | undefined };
  const key = Symbol.for("thru.sharedFeePayerQueues");
  return (g[key] ??= new Map());
};

async function withFeePayer<T>(feePayer: string, work: () => Promise<T>): Promise<T> {
  const queues = feePayerQueues();
  const previous = queues.get(feePayer) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => (release = r));
  const tail = previous.then(() => current);
  queues.set(feePayer, tail);
  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queues.get(feePayer) === tail) queues.delete(feePayer);
  }
}

type HostKey = { publicKey: Uint8Array; privateKey: Uint8Array; address: string };

let hostKeyPromise: Promise<HostKey> | null = null;
let loadedHost: HostKey | null = null;
function hostKey(): Promise<HostKey> {
  hostKeyPromise ??= (async () => {
    const s = config.thruHostSecret.trim();
    if (!s) throw new Error("THRU_HOST_SECRET is not set");
    const privateKey = /^[0-9a-fA-F]{64}$/.test(s) ? fromHex(s) : new Uint8Array(Buffer.from(s, "base64"));
    if (privateKey.length !== 32) throw new Error("THRU_HOST_SECRET must be a 32-byte Ed25519 seed (hex or base64)");
    const publicKey = await keys.fromPrivateKey(privateKey);
    loadedHost = { publicKey, privateKey, address: encodeAddress(publicKey) };
    return loadedHost;
  })();
  return hostKeyPromise;
}

let client: Thru | null = null;
const thru = () => (client ??= createThruClient({ baseUrl: config.thruRpcUrl }));

/** Header values that don't change per tx, cached to keep a shot's latency to one round trip. */
const headerCache = { chainId: 0, slot: 0n, slotAt: 0, nonce: null as bigint | null };

async function header(feePayer: string) {
  const t = thru();
  if (!headerCache.chainId) headerCache.chainId = await t.chain.getChainId();
  if (Date.now() - headerCache.slotAt > 4000) {
    headerCache.slot = (await t.blocks.getBlockHeight()).finalized;
    headerCache.slotAt = Date.now();
  }
  if (headerCache.nonce === null) {
    const acct = await t.accounts.get(feePayer);
    headerCache.nonce = acct.meta?.nonce ?? 0n;
  }
  return { fee: 0n, nonce: headerCache.nonce, startSlot: headerCache.slot, chainId: headerCache.chainId, expiryAfter: 100 };
}

export class ThruReferee implements Referee {
  readonly mode = "thru" as const;
  private table: { gameId: bigint; address: string; bytes: Uint8Array; wallets: string[] } | null = null;
  private readonly program = config.refereeProgramAddress;
  private readonly passkeyProgram = config.passkeyManagerProgramAddress || PASSKEY_MANAGER_PROGRAM_ADDRESS;

  constructor() {
    if (!this.program) throw new Error("REFEREE_PROGRAM_ADDRESS is not set");
    void hostKey();
  }

  /** Call once at boot: fails fast on a bad key / RPC so we can fall back to the mock. */
  static async check(): Promise<string> {
    const k = await hostKey();
    const acct = await thru().accounts.get(k.address);
    return `${k.address} (balance ${acct.meta?.balance ?? 0n})`;
  }

  hostAddress(): string {
    if (!loadedHost) throw new Error("host key not loaded yet (call ThruReferee.check() at boot)");
    return loadedHost.address;
  }

  async prepareTable(gameId: bigint) {
    const { bytes, address } = deriveProgramAddress({ programAddress: this.program, seed: tableSeed(gameId) });
    return { address, key: bytes };
  }

  async createTable(g: { gameId: bigint; wallets: string[]; hearts: number }): Promise<Receipt> {
    const { address, key } = await this.prepareTable(g.gameId);
    this.table = { gameId: g.gameId, address, bytes: key, wallets: g.wallets };
    return this.hostTx("CREATE_TABLE", async () => {
      const proof = await thru().proofs.generate({ address, proofType: CREATING_PROOF });
      return (ctx) =>
        encCreateTable({ tableIdx: ctx.getAccountIndex(address), gameId: g.gameId, hearts: g.hearts, wallets: g.wallets.map(decodeAddress), proof: proof.proof });
    }, [address]);
  }

  async run(call: ChainCall): Promise<Receipt> {
    const t = this.table;
    if (!t) return { kind: call.kind, ms: 0, ok: false, mock: false, signer: "host", error: "no table" };
    const at = (ctx: { getAccountIndex: (p: string) => number }) => ({ tableIdx: ctx.getAccountIndex(t.address) });
    switch (call.kind) {
      case "commitRound":
        return this.hostTx("COMMIT_ROUND", async () => (ctx) => encCommitRound({ ...at(ctx), ...call }), [t.address]);
      case "resolveShot":
        return this.hostTx("RESOLVE_SHOT", async () => (ctx) => encResolveShot({ ...at(ctx), ...call }), [t.address]);
      case "seal":
        return this.hostTx("SEAL", async () => (ctx) => encSeal({ ...at(ctx), ...call }), [t.address]);
      case "reveal":
        return this.hostTx(call.mode === 0 ? "REVEAL" : "REVEAL_TAPE", async () => (ctx) => encReveal({ ...at(ctx), ...call }), [t.address]);
      case "revealShells":
        return this.hostTx("REVEAL_SHELLS", async () => (ctx) => encRevealShells({ ...at(ctx), ...call }), [t.address]);
      case "pullTrigger":
      case "accuse":
        return this.seatTx(call);
    }
  }

  async challengeFor(call: SeatCall, seat: SeatInfo) {
    const t = this.table;
    if (!t) throw new Error("no table yet");
    const host = await hostKey();
    const accountCtx = this.walletContext(seat.wallet, host.address);
    const instructionData = this.seatInstruction(call, accountCtx, seat.wallet);
    const { challenge } = await createPasskeyChallenge({
      client: thru() as never,
      walletAddress: seat.wallet,
      accountCtx,
      targetProgramAddress: this.program,
      instructionData,
    });
    return { challenge, prepared: { accountCtx, instructionData, wallet: seat.wallet } };
  }

  async bindWallet(credentialId: string, publicKeyHex: string) {
    const host = await hostKey();
    const pk = fromHex(publicKeyHex);
    const t0 = performance.now();
    const { walletAddress } = await createPasskeyWallet({
      client: thru() as never,
      adminPublicKey: host.publicKey,
      adminPrivateKey: host.privateKey,
      adminAddress: host.address,
      pubkeyX: pk.slice(0, 32),
      pubkeyY: pk.slice(32, 64),
      walletName: "blank-check",
    });
    headerCache.nonce = null; // the helper used the fee payer nonce
    void credentialId;
    return { wallet: walletAddress, receipt: { kind: "WALLET", ms: Math.round(performance.now() - t0), ok: true, mock: false, signer: "host" as const } };
  }

  explorerTxUrl(signature: string) {
    return `${config.explorerUrl}/tx/${signature}`;
  }

  explorerAccountUrl(address: string) {
    return `${config.explorerUrl}/address/${address}`;
  }

  /* ───────────── internals ───────────── */

  private walletContext(wallet: string, feePayer: string): AccountContext {
    const t = this.table!;
    return buildAccountContext({
      walletAddress: wallet,
      readWriteAccounts: [t.bytes],
      readOnlyAccounts: [decodeAddress(this.program)],
      feePayerAddress: feePayer,
      programAddress: this.passkeyProgram,
    });
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
    const host = await hostKey();
    const seat = call.kind === "pullTrigger" ? call.shooter : call.accuser;
    const wallet = t.wallets[seat];
    const kind = call.kind === "pullTrigger" ? "PULL_TRIGGER" : "ACCUSE";

    // Bots and host-signed seats: the house key is the seat wallet (fee payer = index 0).
    if (!wallet || wallet === host.address) {
      return this.hostTx(
        kind,
        async () => (ctx) =>
          call.kind === "pullTrigger"
            ? encPullTrigger({ tableIdx: ctx.getAccountIndex(t.address), walletIdx: 0, round: call.round, shot: call.shot, shooter: call.shooter, target: call.target })
            : encAccuse({ tableIdx: ctx.getAccountIndex(t.address), walletIdx: 0, round: call.round, accuser: call.accuser, accused: call.accused }),
        [t.address],
        "house",
      );
    }

    if (call.auth.type !== "passkey") return { kind, ms: 0, ok: false, mock: false, signer: "passkey", error: "Face ID signature missing", retryable: false };
    const prep = call.auth.prepared as { accountCtx: AccountContext; instructionData: Uint8Array } | undefined;
    if (!prep) return { kind, ms: 0, ok: false, mock: false, signer: "passkey", error: "no prepared challenge", retryable: false };
    const a = call.auth.assertion;

    return withFeePayer(host.address, async () => {
      const t0 = performance.now();
      try {
        const res = await submitPasskeyTransaction({
          client: thru() as never,
          adminPublicKey: host.publicKey,
          adminPrivateKey: host.privateKey,
          walletAddress: wallet,
          accountCtx: prep.accountCtx,
          targetProgramAddress: this.program,
          instructionData: prep.instructionData,
          signatureR: a.signatureR,
          signatureS: a.signatureS,
          authenticatorData: a.authenticatorData,
          clientDataJSON: a.clientDataJSON,
        });
        headerCache.nonce = null;
        const ok = res.status === "finalized";
        return {
          kind,
          ms: Math.round(performance.now() - t0),
          ok,
          mock: false,
          signer: "passkey",
          signature: res.signature,
          explorerUrl: this.explorerTxUrl(res.signature),
          error: ok ? undefined : `${res.status}${res.errorCode !== undefined ? ` (${describeCode(res.errorCode)})` : ""}`,
          retryable: false,
        };
      } catch (e) {
        headerCache.nonce = null;
        return { kind, ms: Math.round(performance.now() - t0), ok: false, mock: false, signer: "passkey", error: (e as Error).message, retryable: false };
      }
    });
  }

  /** Build, sign (house key), send, and wait for execution. Measured submit → executed. */
  private async hostTx(
    kind: string,
    prepare: () => Promise<(ctx: { getAccountIndex: (p: string) => number }) => Uint8Array>,
    readWrite: string[],
    signer: Receipt["signer"] = "host",
  ): Promise<Receipt> {
    const host = await hostKey();
    return withFeePayer(host.address, async () => {
      let t0 = performance.now();
      try {
        const buildIx = await prepare();
        const h = await header(host.address);
        const signed = await thru().transactions.buildAndSign({
          feePayer: { publicKey: host.publicKey, privateKey: host.privateKey },
          program: this.program,
          header: h,
          accounts: { readWrite },
          instructionData: async (ctx) => buildIx({ getAccountIndex: (p) => ctx.getAccountIndex(p) }),
        });
        t0 = performance.now();
        let signature = encodeSignature(signed.rawTransaction.slice(signed.rawTransaction.length - 64));
        let accepted = false;
        for await (const u of thru().transactions.sendAndTrack(signed.rawTransaction, { timeoutMs: 15_000 })) {
          if (u.signature?.value) signature = encodeSignature(u.signature.value);
          if (u.status === SUBMISSION_ACCEPTED) accepted = true;
          if (u.executionResult) {
            const r = u.executionResult;
            if (r.feePayerExpectedNonce !== undefined) headerCache.nonce = r.feePayerExpectedNonce;
            else headerCache.nonce = h.nonce + 1n;
            const ok = r.vmError === 0 && r.userErrorCode === 0n;
            return {
              kind,
              ms: Math.round(performance.now() - t0),
              ok,
              mock: false,
              signer,
              signature,
              explorerUrl: this.explorerTxUrl(signature),
              error: ok ? undefined : r.vmError ? `vm error ${r.vmError}` : `reverted: ${describeCode(r.userErrorCode)}`,
              retryable: r.feePayerExpectedNonce !== undefined,
            };
          }
        }
        headerCache.nonce = null;
        return { kind, ms: Math.round(performance.now() - t0), ok: false, mock: false, signer, signature, error: accepted ? "timed out waiting for execution" : "not accepted", retryable: !accepted };
      } catch (e) {
        headerCache.nonce = null;
        return { kind, ms: Math.round(performance.now() - t0), ok: false, mock: false, signer, error: (e as Error).message, retryable: true };
      }
    });
  }
}

function describeCode(code: bigint | number): string {
  const n = Number(code);
  return ERR_NAMES[n] ?? `0x${n.toString(16)}`;
}
