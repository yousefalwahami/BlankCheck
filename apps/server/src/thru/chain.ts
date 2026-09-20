import { createThruClient, keys, type Thru } from "@thru/sdk";
import { decodeAddress, encodeAddress, encodeSignature } from "@thru/sdk/helpers";
import { createPasskeyChallenge, submitPasskeyTransaction } from "@thru/passkey/server";
import { PASSKEY_MANAGER_PROGRAM_ADDRESS, buildAccountContext, type AccountContext } from "@thru/programs/passkey-manager";
import { fromHex, type PasskeyAssertion } from "@blankcheck/shared";
import { config } from "../config";
import type { Receipt } from "../referee/Referee";

/*
 * Everything that talks to Thru as the house: one client, one house key, one fee-payer queue.
 * The referee (our C program) and the bank (the Token Program) both send through here.
 *   - House transactions are signed by the house key (fee payer).
 *   - Face ID transactions go through passkey-manager `validate`, which CPIs into the target program
 *     with the player's wallet authorized. The house still pays the fee.
 */

const SUBMISSION_ACCEPTED = 2;
export const CREATING_PROOF = 1; // StateProofType.CREATING

/*
 * Thru runtime error codes (signed i32). 0xFFFFFD03 = VM_REVERT: the program exited with a revert,
 * and userErrorCode (when set) is the referee / passkey-manager code. We used to print "vm error -765"
 * for every revert, which hid the real reason and made the ticker look like the chain was on fire.
 */
const THRU_VM = {
  SUCCESS: 0,
  VM_FAILED: -767,
  INVALID_PROGRAM: -766,
  VM_REVERT: -765,
  CU_EXHAUSTED: -764,
  SU_EXHAUSTED: -763,
  NONCE_TOO_LOW: -511,
  NONCE_TOO_HIGH: -510,
} as const;

function describeExecution(vmError: number, userErrorCode: bigint, describe: (c: bigint) => string): string | undefined {
  if (vmError === THRU_VM.SUCCESS && userErrorCode === 0n) return undefined;
  if (userErrorCode !== 0n) return `reverted: ${describe(userErrorCode)}`;
  switch (vmError) {
    case THRU_VM.VM_REVERT:
      return "reverted";
    case THRU_VM.CU_EXHAUSTED:
      return "compute units exhausted";
    case THRU_VM.SU_EXHAUSTED:
      return "state units exhausted";
    case THRU_VM.VM_FAILED:
      return "vm crashed";
    case THRU_VM.INVALID_PROGRAM:
      return "invalid program account";
    case THRU_VM.NONCE_TOO_LOW:
      return "nonce too low";
    case THRU_VM.NONCE_TOO_HIGH:
      return "nonce too high";
    default:
      return vmError ? `vm error ${vmError}` : `reverted: ${describe(userErrorCode)}`;
  }
}

/** Retry nonce mismatches. A program revert already happened; sending it again just spam-fails. */
function retryableExecution(vmError: number, userErrorCode: bigint): boolean {
  if (userErrorCode !== 0n) return false;
  return vmError === THRU_VM.NONCE_TOO_LOW || vmError === THRU_VM.NONCE_TOO_HIGH;
}

export type HostKey = { publicKey: Uint8Array; privateKey: Uint8Array; address: string };

let hostKeyPromise: Promise<HostKey> | null = null;
let loadedHost: HostKey | null = null;

export function hostKey(): Promise<HostKey> {
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

/** The house address, once hostKey() has resolved (it's awaited at boot). */
export function hostAddressSync(): string {
  if (!loadedHost) throw new Error("host key not loaded yet (await hostKey() at boot)");
  return loadedHost.address;
}

let client: Thru | null = null;
export const thru = () => (client ??= createThruClient({ baseUrl: config.thruRpcUrl }));

export const passkeyProgram = () => config.passkeyManagerProgramAddress || PASSKEY_MANAGER_PROGRAM_ADDRESS;

export const explorerTx = (sig: string) => `${config.explorerUrl}/tx/${sig}`;
export const explorerAccount = (addr: string) => `${config.explorerUrl}/address/${addr}`;

/** Same global queue @thru/passkey/server uses, so our txs and its txs never race on the fee payer nonce. */
function feePayerQueues(): Map<string, Promise<void>> {
  const g = globalThis as typeof globalThis & { [k: symbol]: Map<string, Promise<void>> | undefined };
  const key = Symbol.for("thru.sharedFeePayerQueues");
  return (g[key] ??= new Map());
}

export async function withFeePayer<T>(feePayer: string, work: () => Promise<T>): Promise<T> {
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

/** Header values that don't change per tx, cached to keep a shot's latency to one round trip. */
const headerCache = { chainId: 0, slot: 0n, slotAt: 0, nonce: null as bigint | null };

/** Something else (a passkey helper) used the fee payer: re-read the nonce next time. */
export const forgetNonce = () => {
  headerCache.nonce = null;
};

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
  return {
    fee: 0n,
    nonce: headerCache.nonce,
    startSlot: headerCache.slot,
    chainId: headerCache.chainId,
    expiryAfter: 100,
    computeUnits: config.txComputeUnits,
    stateUnits: config.txStateUnits,
    memoryUnits: config.txMemoryUnits,
  };
}

export type IndexLookup = { getAccountIndex: (pubkey: Uint8Array | string) => number };

/** Build, sign (house key), send, and wait for execution. Measured submit → executed. */
export async function sendHostTx(opts: {
  kind: string;
  program: string;
  readWrite: string[];
  readOnly?: string[];
  build: (ctx: IndexLookup) => Promise<Uint8Array> | Uint8Array;
  signer?: Receipt["signer"];
  describe?: (code: bigint) => string;
}): Promise<Receipt> {
  const host = await hostKey();
  const signer = opts.signer ?? "host";
  const describe = opts.describe ?? ((c: bigint) => `0x${c.toString(16)}`);
  return withFeePayer(host.address, async () => {
    let t0 = performance.now();
    try {
      const h = await header(host.address);
      const signed = await thru().transactions.buildAndSign({
        feePayer: { publicKey: host.publicKey, privateKey: host.privateKey },
        program: opts.program,
        header: h,
        accounts: { readWrite: opts.readWrite, readOnly: opts.readOnly ?? [] },
        instructionData: async (ctx) => opts.build({ getAccountIndex: (p) => ctx.getAccountIndex(p) }),
      });
      t0 = performance.now();
      let signature = encodeSignature(signed.rawTransaction.slice(signed.rawTransaction.length - 64));
      let accepted = false;
      for await (const u of thru().transactions.sendAndTrack(signed.rawTransaction, { timeoutMs: 15_000 })) {
        if (u.signature?.value) signature = encodeSignature(u.signature.value);
        if (u.status === SUBMISSION_ACCEPTED) accepted = true;
        if (u.executionResult) {
          const r = u.executionResult;
          headerCache.nonce = r.feePayerExpectedNonce ?? h.nonce + 1n;
          const ok = r.vmError === THRU_VM.SUCCESS && r.userErrorCode === 0n;
          return {
            kind: opts.kind,
            ms: Math.round(performance.now() - t0),
            ok,
            mock: false,
            signer,
            signature,
            explorerUrl: ok ? explorerTx(signature) : undefined,
            error: describeExecution(r.vmError, r.userErrorCode, describe),
            retryable: retryableExecution(r.vmError, r.userErrorCode),
          };
        }
      }
      headerCache.nonce = null;
      return {
        kind: opts.kind,
        ms: Math.round(performance.now() - t0),
        ok: false,
        mock: false,
        signer,
        signature,
        error: accepted ? "timed out waiting for execution" : "not accepted",
        retryable: !accepted,
      };
    } catch (e) {
      headerCache.nonce = null;
      return { kind: opts.kind, ms: Math.round(performance.now() - t0), ok: false, mock: false, signer, error: (e as Error).message, retryable: true };
    }
  });
}

/** Account context for a Face ID wallet calling `targetProgram` with these accounts. */
export function walletContext(wallet: string, readWrite: Uint8Array[], readOnly: Uint8Array[]): AccountContext {
  return buildAccountContext({
    walletAddress: wallet,
    readWriteAccounts: readWrite,
    readOnlyAccounts: readOnly,
    feePayerAddress: hostAddressSync(),
    programAddress: passkeyProgram(),
  });
}

/** The WebAuthn challenge over (wallet nonce, ordered accounts, the exact target instruction bytes). */
export async function passkeyChallenge(opts: { wallet: string; accountCtx: AccountContext; targetProgram: string; instructionData: Uint8Array }) {
  const { challenge } = await createPasskeyChallenge({
    client: thru() as never,
    walletAddress: opts.wallet,
    accountCtx: opts.accountCtx,
    targetProgramAddress: opts.targetProgram,
    instructionData: opts.instructionData,
  });
  return challenge;
}

/** validate(Face ID) → CPI into the target program, fee paid by the house. */
export async function sendPasskeyTx(opts: {
  kind: string;
  wallet: string;
  accountCtx: AccountContext;
  targetProgram: string;
  instructionData: Uint8Array;
  assertion: PasskeyAssertion;
  describe?: (code: bigint) => string;
}): Promise<Receipt> {
  const host = await hostKey();
  const describe = opts.describe ?? ((c: bigint) => `0x${c.toString(16)}`);
  // submitPasskeyTransaction takes the shared fee-payer queue itself: wrapping it in withFeePayer
  // would make it wait on its own slot forever.
  {
    const t0 = performance.now();
    try {
      const res = await submitPasskeyTransaction({
        client: thru() as never,
        adminPublicKey: host.publicKey,
        adminPrivateKey: host.privateKey,
        walletAddress: opts.wallet,
        accountCtx: opts.accountCtx,
        targetProgramAddress: opts.targetProgram,
        instructionData: opts.instructionData,
        signatureR: opts.assertion.signatureR,
        signatureS: opts.assertion.signatureS,
        authenticatorData: opts.assertion.authenticatorData,
        clientDataJSON: opts.assertion.clientDataJSON,
      });
      headerCache.nonce = null;
      const ok = res.status === "finalized";
      return {
        kind: opts.kind,
        ms: Math.round(performance.now() - t0),
        ok,
        mock: false,
        signer: "passkey",
        signature: res.signature,
        explorerUrl: ok ? explorerTx(res.signature) : undefined,
        error: ok ? undefined : `${res.status}${res.errorCode !== undefined ? ` (${describe(BigInt(res.errorCode))})` : ""}`,
        retryable: false,
      };
    } catch (e) {
      headerCache.nonce = null;
      return { kind: opts.kind, ms: Math.round(performance.now() - t0), ok: false, mock: false, signer: "passkey", error: (e as Error).message, retryable: false };
    }
  }
}

export { decodeAddress };
