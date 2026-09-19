import { randomBytes, sha256, toHex, fromHex } from "@blankcheck/shared";
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
} from "./encode";
import { execute, Revert, ERR_NAMES, type AccountStore } from "./program";
import type { Receipt, Referee, SeatCall, SeatInfo } from "./Referee";
import { verifyPasskeyAssertion } from "./webauthn";

const utf8 = (s: string) => new TextEncoder().encode(s);

export type TraceEntry = {
  label: string;
  ix: string;
  accounts: string[];
  authorized: number[];
  ok: boolean;
  err: number;
  events: string[];
};

/**
 * The offline referee. Encodes the real instruction bytes and runs them through a TypeScript
 * mirror of the C program, so a game with no blockchain still obeys the chain's rules.
 * Addresses are 64-char hex strings.
 */
export class MockReferee implements Referee {
  readonly mode = "mock" as const;
  private readonly store: AccountStore = new Map();
  private readonly host = sha256(utf8("blank-check:mock-host"));
  private readonly program = sha256(utf8("blank-check:mock-referee"));
  private table: { gameId: bigint; key: Uint8Array; wallets: Uint8Array[] } | null = null;
  private sigSeq = 0;
  /** When set, every instruction is recorded (used to replay a real game through the C program). */
  trace: TraceEntry[] | null = null;

  hostAddress(): string {
    return toHex(this.host);
  }

  async prepareTable(gameId: bigint) {
    const key = sha256(utf8(`blank-check:mock-table:${gameId}`));
    return { address: toHex(key), key };
  }

  async createTable(g: { gameId: bigint; wallets: string[]; hearts: number }): Promise<Receipt> {
    const { key } = await this.prepareTable(g.gameId);
    const wallets = g.wallets.map((w) => fromHex(w));
    this.table = { gameId: g.gameId, key, wallets };
    const ix = encCreateTable({ tableIdx: 2, gameId: g.gameId, hearts: g.hearts, wallets, proof: new Uint8Array(0) });
    return this.exec("CREATE_TABLE", ix, [this.host, this.program, key], new Set(), "host");
  }

  async challengeFor(_call: SeatCall, seat: SeatInfo) {
    const challenge = Buffer.from(randomBytes(32)).toString("base64url");
    return { challenge, prepared: { challenge, publicKey: seat.publicKey } };
  }

  async bindWallet(_credentialId: string, publicKeyHex: string) {
    return { wallet: toHex(sha256(utf8(`blank-check:mock-wallet:${publicKeyHex.toLowerCase()}`))) };
  }

  explorerTxUrl(): string | undefined {
    return undefined;
  }

  explorerAccountUrl(): string | undefined {
    return undefined;
  }

  async run(call: ChainCall): Promise<Receipt> {
    if (!this.table) return { kind: call.kind, ms: 0, ok: false, mock: true, signer: "host", error: "no table" };
    const t = this.table;
    const accounts = [this.host, this.program, t.key];
    const authorized = new Set<number>();
    const base = { tableIdx: 2 };

    switch (call.kind) {
      case "commitRound":
        return this.exec("COMMIT_ROUND", encCommitRound({ ...base, ...call }), accounts, authorized, "host");
      case "resolveShot":
        return this.exec("RESOLVE_SHOT", encResolveShot({ ...base, ...call }), accounts, authorized, "host");
      case "seal":
        return this.exec("SEAL", encSeal({ ...base, ...call }), accounts, authorized, "host");
      case "reveal":
        return this.exec(call.mode === 0 ? "REVEAL" : "REVEAL_TAPE", encReveal({ ...base, ...call }), accounts, authorized, "host");
      case "revealShells":
        return this.exec("REVEAL_SHELLS", encRevealShells({ ...base, ...call }), accounts, authorized, "host");
      case "pullTrigger":
      case "accuse": {
        const seat = call.kind === "pullTrigger" ? call.shooter : call.accuser;
        const wallet = t.wallets[seat];
        let walletIdx = 0;
        let signer: Receipt["signer"] = "house";
        if (wallet && toHex(wallet) !== toHex(this.host)) {
          accounts.push(wallet);
          walletIdx = 3;
          signer = "passkey";
          if (call.auth.type === "passkey") {
            const prep = call.auth.prepared as { challenge: string; publicKey?: string } | undefined;
            if (prep?.publicKey && (await verifyPasskeyAssertion(prep.publicKey, prep.challenge, call.auth.assertion))) authorized.add(3);
          }
        }
        const ix =
          call.kind === "pullTrigger"
            ? encPullTrigger({ ...base, walletIdx, round: call.round, shot: call.shot, shooter: call.shooter, target: call.target })
            : encAccuse({ ...base, walletIdx, round: call.round, accuser: call.accuser, accused: call.accused });
        return this.exec(call.kind === "pullTrigger" ? "PULL_TRIGGER" : "ACCUSE", ix, accounts, authorized, signer);
      }
    }
  }

  /** Raw table account bytes (what a chain read would return). */
  tableData(): Uint8Array | undefined {
    return this.table ? this.store.get(toHex(this.table.key)) : undefined;
  }

  private exec(kind: string, ix: Uint8Array, accounts: Uint8Array[], authorized: Set<number>, signer: Receipt["signer"]): Receipt {
    const t0 = performance.now();
    let ok = true;
    let err = 0;
    let events: Uint8Array[] = [];
    try {
      events = execute(ix, { accounts, authorized, store: this.store });
    } catch (e) {
      if (!(e instanceof Revert)) throw e;
      ok = false;
      err = e.code;
    }
    this.trace?.push({
      label: kind,
      ix: toHex(ix),
      accounts: accounts.map(toHex),
      authorized: [...authorized],
      ok,
      err,
      events: events.map(toHex),
    });
    const ms = Math.max(1, Math.round(performance.now() - t0));
    return {
      kind,
      ms,
      ok,
      mock: true,
      signer,
      signature: `mock-${++this.sigSeq}`,
      error: ok ? undefined : `reverted: ${ERR_NAMES[err] ?? err}`,
      retryable: false,
    };
  }
}
