import {
  BOTS,
  Cheat,
  MAX_SEATS,
  MONEY,
  S2C,
  TAUNTS,
  TIMING,
  randomBytes,
  type BotId,
  type CashOutResult,
  type Challenge,
  type ChainTx,
  type Fx,
  type PasskeyAssertion,
  type TapeData,
  type TapeMoney,
  type TauntId,
} from "@blankcheck/shared";
import type { Server } from "socket.io";
import { goodMomentForCard, heuristicAim, pickAccusation, think } from "./ai/bots";
import { readPitBoss } from "./ai/pitBoss";
import { pickTaunt, type TauntMoment } from "./ai/taunts";
import type { Bank, BankAccount, WalletRef } from "./bank/Bank";
import { config } from "./config";
import { cryptoRng, seededRng, type Rng } from "./engine/rng";
import { fundedSeats, inPlay, makeSeat, newGameState } from "./engine/rules";
import { step } from "./engine/step";
import type { Action, ChainCall, Effect, GameState, SeatAuth, SeatState } from "./engine/types";
import { botView, canAccuse, canBuyIn, canCheat, pitBossView, privateView, publicView } from "./engine/views";
import type { Receipt, Referee, SeatCall } from "./referee/Referee";
import { TxQueue } from "./referee/txQueue";
import { buildTape } from "./tape";

type PendingChallenge = Challenge & { prepared: unknown; round: number; shot: number };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms * config.timeScale));
const LETTERS = "ABCDEFGHJKLMNPQRSTUVWXYZ";

export function newRoomCode(taken: (c: string) => boolean): string {
  for (;;) {
    const b = randomBytes(4);
    const code = Array.from(b, (x) => LETTERS[x % LETTERS.length]).join("");
    if (!taken(code)) return code;
  }
}

export class Room {
  readonly hostToken = Buffer.from(randomBytes(18)).toString("base64url");
  state: GameState;
  lastActivity = Date.now();

  private referee: Referee;
  private queue = new TxQueue();
  private timers = new Map<string, NodeJS.Timeout>();
  private challenges = new Map<number, PendingChallenge>();
  private receipts = new Map<string, Receipt>();
  private chainLog: ChainTx[] = [];
  private txSeq = 0;
  private onChainActions = 0;
  private failedTxs = 0;
  private tableAddress: string | null = null;
  private tableWallets: string[] = [];
  private rng: Rng;
  private botRng: Rng = cryptoRng();
  private tape: TapeData | null = null;
  private tapeStarted = false;
  private pitBoss: Record<number, number> = {};
  private pitBossBusy = false;
  private botTurnBusy = false;
  private botMoments = new Set<string>();
  private generation = 0;
  private disposed = false;
  /** Bank wallets by stable seat key (seats renumber when someone is kicked). */
  private accounts = new Map<string, BankAccount>();
  private transfers: TapeMoney["transfers"] = [];
  private payouts: Promise<unknown> = Promise.resolve();
  private buying = new Set<string>();
  private rebuyScheduled = new Set<string>();

  constructor(
    readonly code: string,
    private readonly io: Server,
    private readonly makeReferee: () => Referee,
    private readonly bank: Bank,
    rounds: number,
    faceIdOnTrigger: boolean,
  ) {
    this.referee = makeReferee();
    this.rng = config.demoSeed ? seededRng(config.demoSeed) : cryptoRng();
    this.state = newGameState(code, { rounds, faceIdOnTrigger });
  }

  get refereeMode() {
    return this.referee.mode;
  }

  /* ───────────── socket rooms ───────────── */

  get all() {
    return `room:${this.code}`;
  }
  playerRoom(playerId: string) {
    return `player:${this.code}:${playerId}`;
  }

  /* ───────────── lobby ───────────── */

  /** `passkey`: the phone has a Face ID passkey and will bind it next, so wait for that wallet. */
  join(playerId: string, rawName: string, passkey = false): { seat: number } | { error: string } {
    const existing = this.state.seats.find((x) => x.playerId === playerId);
    if (existing) {
      existing.connected = true;
      this.touch();
      return { seat: existing.seat };
    }
    if (this.state.phase !== "LOBBY") return { error: "This game already started. Wait for the next one!" };
    if (this.state.seats.length >= MAX_SEATS) return { error: "The table is full." };
    const name = this.uniqueName(rawName.trim().slice(0, 16) || "Player");
    const seat = this.state.seats.length;
    const s = makeSeat(seat, name, "human", { playerId, connected: true });
    this.state.seats.push(s);
    this.log(`${name} sat down`);
    if (!passkey) void this.openWallet(this.key(s), { kind: "custodial", id: `player:${playerId}` });
    this.touch();
    return { seat };
  }

  addBot(personality: BotId): string | undefined {
    if (this.state.phase !== "LOBBY") return "The game already started";
    if (this.state.seats.length >= MAX_SEATS) return "The table is full";
    const seat = this.state.seats.length;
    const name = this.uniqueName(BOTS[personality].name);
    const s = makeSeat(seat, name, "bot", { personality, wallet: this.referee.hostAddress(), walletReady: true });
    this.state.seats.push(s);
    this.log(`${BOTS[personality].emoji} ${name} pulls up a chair`);
    void this.botSitsDown(this.key(s));
    this.touch();
  }

  kick(seat: number): string | undefined {
    if (this.state.phase !== "LOBBY") return "Can't kick mid-game";
    const removed = this.state.seats.splice(seat, 1)[0];
    if (!removed) return "No such seat";
    this.state.seats.forEach((x, i) => (x.seat = i));
    // They bought in at the lobby: give the money back.
    if (removed.chips > 0) void this.refund(this.key(removed), removed.chips * MONEY.chipCents, true);
    if (removed.playerId) this.io.to(this.playerRoom(removed.playerId)).emit(S2C.toast, { text: "The host removed you from the table." });
    this.touch();
  }

  setConfig(c: { rounds?: number; faceIdOnTrigger?: boolean }): string | undefined {
    if (this.state.phase !== "LOBBY") return "Settings are locked once the game starts";
    Object.assign(this.state.config, Object.fromEntries(Object.entries(c).filter(([, v]) => v !== undefined)));
    this.touch();
  }

  async bindWallet(seat: number, credentialId: string, publicKey: string): Promise<{ wallet: string } | { error: string }> {
    const s = this.state.seats[seat];
    if (!s || s.kind !== "human") return { error: "No seat" };
    if (this.state.phase !== "LOBBY" && s.walletReady) return { wallet: s.wallet };
    try {
      const { wallet, receipt } = await this.referee.bindWallet(credentialId, publicKey);
      if (receipt) this.record("wallet", receipt, seat);
      Object.assign(s, { wallet, walletReady: true, credentialId, publicKey: publicKey.toLowerCase() });
      // The money lives in a token account your Face ID wallet owns: nobody else can spend it.
      await this.openWallet(this.key(s), { kind: "passkey", wallet, publicKey: publicKey.toLowerCase() });
      this.touch();
      return { wallet };
    } catch (e) {
      console.warn(`[room ${this.code}] wallet bind failed:`, e);
      if (!this.accounts.has(this.key(s))) void this.openWallet(this.key(s), { kind: "custodial", id: `player:${s.playerId}` });
      return { error: "Couldn't create your Face ID wallet. You can still play; the house holds your chips." };
    }
  }

  setConnected(playerId: string, connected: boolean) {
    const s = this.state.seats.find((x) => x.playerId === playerId);
    if (s) {
      s.connected = connected;
      this.touch();
      this.scheduleAfk();
    }
  }

  /* ───────────── game lifecycle ───────────── */

  async start(): Promise<string | undefined> {
    if (this.state.phase !== "LOBBY") return "Already started";
    if (this.state.seats.length < 2) return "Need at least 2 players (add a bot!)";
    const gen = this.generation;
    const gameId = BigInt(Math.floor(Math.random() * 2 ** 48)) + 1n;
    const { address, key } = await this.referee.prepareTable(gameId);
    if (gen !== this.generation || this.state.phase !== "LOBBY") return "Game changed while starting";
    this.state.tableKey = key;
    this.tableAddress = address;
    const host = this.referee.hostAddress();
    this.tableWallets = this.state.seats.map((x) =>
      x.kind === "human" && x.walletReady && this.state.config.faceIdOnTrigger ? x.wallet : host,
    );
    // Same check as START, made before CREATE_TABLE is queued so a refused start never creates a table.
    const waiting = this.state.seats.filter((x) => x.chips === 0);
    if (waiting.length) return `Waiting for ${waiting.map((x) => x.name).join(", ")} to buy in`;
    this.enqueueChain("create", undefined, () =>
      this.referee.createTable({ gameId, wallets: this.tableWallets, buyInChips: MONEY.buyInChips, rounds: this.state.config.rounds }),
    );
    return this.dispatch({ type: "START" });
  }

  restart() {
    this.generation++;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
    this.challenges.clear();
    this.receipts.clear();
    this.chainLog = [];
    this.onChainActions = 0;
    this.failedTxs = 0;
    this.tape = null;
    this.tapeStarted = false;
    this.pitBoss = {};
    this.botMoments.clear();
    this.botTurnBusy = false;
    this.tableAddress = null;
    this.queue = new TxQueue();
    this.referee = this.makeReferee();
    this.transfers = [];
    this.payouts = Promise.resolve();
    this.rebuyScheduled.clear();
    if (config.demoSeed) this.rng = seededRng(config.demoSeed);
    const seats = this.state.seats.map((x) => ({
      ...x,
      chips: 0,
      buyIns: 0,
      cleanedOut: false,
      wallet: x.kind === "bot" ? this.referee.hostAddress() : x.wallet,
    }));
    this.state = newGameState(this.code, this.state.config);
    this.state.seats = seats;
    this.log("New game. Same table. Same liars. Same wallets.");
    // Refresh balances (the house tops up anyone under $12) and let the bots buy back in.
    for (const s of seats) {
      const key = this.key(s);
      const acct = this.accounts.get(key);
      if (!acct) continue;
      void this.openWallet(key, acct.ref).then(() => (s.kind === "bot" ? this.botBuyIn(key) : undefined));
    }
    this.broadcast();
  }

  dispose() {
    this.disposed = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }

  /* ───────────── player actions ───────────── */

  async aim(seat: number, target: number): Promise<string | undefined> {
    const err = this.dispatch({ type: "AIM", seat, target });
    if (err) return err;
    await this.issueChallenge(seat, { kind: "pullTrigger", round: this.state.round, shot: this.state.shot, shooter: seat, target, auth: { type: "host" } });
  }

  signedTrigger(seat: number, challengeId: string, assertion?: PasskeyAssertion): string | undefined {
    const ch = this.validChallenge(seat, challengeId, "trigger");
    if (typeof ch === "string") return ch;
    const auth = this.authFrom(ch, assertion);
    if (typeof auth === "string") return auth;
    this.challenges.delete(seat);
    return this.dispatch({ type: "PULL", seat, auth });
  }

  cheat(seat: number): string | undefined {
    return this.dispatch({ type: "CHEAT", seat });
  }

  async riggedStart(seat: number, accused: number): Promise<string | undefined> {
    const s = this.state;
    if (!canAccuse(s, seat)) return "You can't call RIGGED! right now";
    if (accused === seat || !inPlay(s, accused)) return "Pick someone with chips";
    if (s.busted.includes(accused)) return "They're already BUSTED this round";
    await this.issueChallenge(seat, { kind: "accuse", round: s.round, accuser: seat, accused, auth: { type: "host" } });
    this.broadcast();
  }

  signedRigged(seat: number, challengeId: string, assertion?: PasskeyAssertion): string | undefined {
    const ch = this.validChallenge(seat, challengeId, "accuse");
    if (typeof ch === "string") return ch;
    const auth = this.authFrom(ch, assertion);
    if (typeof auth === "string") return auth;
    this.challenges.delete(seat);
    return this.dispatch({ type: "ACCUSE", accuser: seat, accused: ch.accused!, auth });
  }

  cancelRigged(seat: number) {
    if (this.challenges.get(seat)?.kind === "accuse") this.challenges.delete(seat);
    this.broadcast();
  }

  boo(seat: number) {
    const s = this.state.seats[seat];
    if (!s || s.chips > 0 || this.state.phase === "LOBBY") return;
    this.emitFx({ type: "boo", seat });
  }

  /* ───────────── money ───────────── */

  private key(s: Pick<SeatState, "kind" | "name" | "playerId">): string {
    return s.kind === "bot" ? `bot:${s.name}` : `player:${s.playerId}`;
  }

  private seatByKey(key: string): SeatState | undefined {
    return this.state.seats.find((x) => this.key(x) === key);
  }

  /** Find or open the wallet and show its real balance (the house tops up anyone under $12). */
  private async openWallet(key: string, ref: WalletRef): Promise<boolean> {
    const gen = this.generation;
    try {
      const { account, balanceCents, receipts } = await this.bank.openWallet(ref);
      this.accounts.set(key, account);
      for (const rc of receipts) this.record(`bank:${key}:${rc.kind}`, rc, this.seatByKey(key)?.seat);
      const s = this.seatByKey(key);
      if (s && gen === this.generation && (this.state.phase === "LOBBY" || s.bankrollCents === null)) s.bankrollCents = balanceCents;
      this.touch();
      return true;
    } catch (e) {
      console.warn(`[room ${this.code}] couldn't open a wallet for ${key}:`, e);
      const s = this.seatByKey(key);
      if (s) this.toast(s.seat, "Couldn't open your wallet. Try rejoining.");
      return false;
    }
  }

  private async botSitsDown(key: string) {
    const s = this.seatByKey(key);
    if (!s) return;
    if (await this.openWallet(key, { kind: "custodial", id: `${this.code}:${s.name}` })) await this.botBuyIn(key);
  }

  private async botBuyIn(key: string) {
    const s = this.seatByKey(key);
    if (s && canBuyIn(this.state, s.seat)) {
      const err = await this.doBuyIn(s.seat, { type: "host" });
      if (err) console.warn(`[room ${this.code}] ${s.name} couldn't buy in: ${err}`);
    }
  }

  /** Step 1 of a buy-in: the phone asks, we prefetch the Face ID challenge for the $12 transfer. */
  async buyInStart(seat: number): Promise<string | undefined> {
    const s = this.state.seats[seat];
    if (!s) return "No seat";
    if (!canBuyIn(this.state, seat)) return s.chips > 0 ? "You still have chips" : "You can't buy in right now";
    const key = this.key(s);
    if (!this.accounts.has(key) && !s.walletReady) await this.openWallet(key, { kind: "custodial", id: `player:${s.playerId}` });
    const account = this.accounts.get(key);
    if (!account) return "Your wallet is still being set up. Try again in a second.";
    const requirePasskey = account.ref.kind === "passkey";
    let challenge = Buffer.from(randomBytes(32)).toString("base64url");
    let prepared: unknown = undefined;
    if (requirePasskey) {
      try {
        ({ challenge, prepared } = await this.bank.challengeForBuyIn(account));
      } catch (e) {
        console.warn(`[room ${this.code}] buy-in challenge failed:`, e);
        return "Couldn't reach the bank for a Face ID challenge. Try again.";
      }
    }
    this.challenges.set(seat, {
      id: Buffer.from(randomBytes(9)).toString("base64url"),
      kind: "buyin",
      challenge,
      requirePasskey,
      prepared,
      round: this.state.round,
      shot: this.state.shot,
    });
    this.broadcast();
  }

  /** Step 2: the phone signed (or just tapped, for house-held wallets). */
  async buyInSigned(seat: number, challengeId: string, assertion?: PasskeyAssertion): Promise<string | undefined> {
    const ch = this.validChallenge(seat, challengeId, "buyin");
    if (typeof ch === "string") return ch;
    const auth = this.authFrom(ch, assertion);
    if (typeof auth === "string") return auth;
    this.challenges.delete(seat);
    return this.doBuyIn(seat, auth);
  }

  /** Move $12 to the cashier, then put 3 chips on the table (retrying if a shot is mid-flight). */
  private async doBuyIn(seat: number, auth: SeatAuth): Promise<string | undefined> {
    const s = this.state.seats[seat];
    if (!s) return "No seat";
    const key = this.key(s);
    const account = this.accounts.get(key);
    if (!account) return "Your wallet isn't ready yet";
    if (this.buying.has(key)) return "Already buying in…";
    if (!canBuyIn(this.state, seat)) return "You can't buy in right now";
    this.buying.add(key);
    const gen = this.generation;
    try {
      const rc = await this.bank.buyIn(account, auth);
      if (gen !== this.generation) {
        if (rc.ok) void this.refund(key, MONEY.buyInCents);
        return "The game changed";
      }
      this.record(`pay:${key}:${s.buyIns + 1}`, rc, s.seat);
      this.transfers.push({ seat: s.seat, kind: "buyIn", cents: MONEY.buyInCents, tx: rc.signature, ok: rc.ok });
      if (!rc.ok) return rc.error ?? "The buy-in didn't go through";
      for (let attempt = 0; attempt < 60; attempt++) {
        const cur = this.seatByKey(key);
        if (gen !== this.generation || !cur) break;
        const err = this.dispatch({ type: "BUY_IN", seat: cur.seat, paymentTx: rc.mock ? undefined : rc.signature });
        if (!err) return undefined;
        if (cur.chips > 0 || this.phase() === "OVER" || this.phase() === "TAPE") break;
        await sleep(400); // mid-shot or mid-verdict: try again in a moment
      }
      void this.refund(key, MONEY.buyInCents);
      return "Couldn't put your chips on the table, so your $12 was refunded";
    } finally {
      this.buying.delete(key);
    }
  }

  /** `credit`: the engine had already deducted this money (a lobby buy-in), so show it back in the wallet. */
  private async refund(key: string, cents: number, credit = false) {
    const account = this.accounts.get(key);
    if (!account || cents <= 0) return;
    const rc = await this.bank.payOut(account, cents);
    const s = this.seatByKey(key);
    this.record(`refund:${key}:${Date.now()}`, { ...rc, kind: "REFUND" }, s?.seat);
    if (credit && s && rc.ok && s.bankrollCents !== null) s.bankrollCents += cents;
    this.touch();
  }

  /** Game over: the cashier pays chips × $4 to everyone still holding chips. */
  private cashOut(results: CashOutResult[]) {
    const gen = this.generation;
    this.payouts = Promise.all(
      results
        .filter((r) => r.cashOutCents > 0)
        .map(async (r) => {
          const s = this.state.seats[r.seat];
          const account = s && this.accounts.get(this.key(s));
          if (!account) return;
          const rc = await this.bank.payOut(account, r.cashOutCents);
          if (gen !== this.generation) return;
          this.record(`cashout:${r.seat}`, rc, r.seat);
          this.transfers.push({ seat: r.seat, kind: "cashOut", cents: r.cashOutCents, tx: rc.signature, ok: rc.ok });
        }),
    );
  }

  private scheduleBotRebuys() {
    for (const s of this.state.seats) {
      if (s.kind !== "bot" || !canBuyIn(this.state, s.seat)) continue;
      const key = this.key(s);
      if (this.buying.has(key) || this.rebuyScheduled.has(key)) continue;
      this.rebuyScheduled.add(key);
      const gen = this.generation;
      setTimeout(() => {
        this.rebuyScheduled.delete(key);
        if (gen === this.generation) void this.botBuyIn(key);
      }, TIMING.botRebuyDelay * config.timeScale);
    }
  }

  /* ───────────── challenges (Face ID) ───────────── */

  private seatUsesPasskey(seat: number): boolean {
    const w = this.tableWallets[seat];
    return !!w && w !== this.referee.hostAddress();
  }

  private async issueChallenge(seat: number, call: SeatCall) {
    const requirePasskey = this.seatUsesPasskey(seat);
    const s = this.state.seats[seat];
    let challenge: string;
    let prepared: unknown = undefined;
    try {
      if (requirePasskey) {
        ({ challenge, prepared } = await this.referee.challengeFor(call, {
          seat,
          wallet: this.tableWallets[seat],
          credentialId: s.credentialId,
          publicKey: s.publicKey,
          kind: s.kind,
        }));
      } else {
        challenge = Buffer.from(randomBytes(32)).toString("base64url");
      }
    } catch (e) {
      console.warn(`[room ${this.code}] challenge failed:`, e);
      this.toast(seat, "Couldn't reach the chain for a Face ID challenge. Try again.");
      return;
    }
    const round = this.state.round;
    const shot = this.state.shot;
    this.challenges.set(seat, {
      id: Buffer.from(randomBytes(9)).toString("base64url"),
      kind: call.kind === "pullTrigger" ? "trigger" : "accuse",
      challenge,
      requirePasskey,
      target: call.kind === "pullTrigger" ? call.target : undefined,
      accused: call.kind === "accuse" ? call.accused : undefined,
      prepared,
      round,
      shot,
    });
    this.broadcast();
  }

  private isChallengeLive(seat: number, ch: PendingChallenge): boolean {
    const s = this.state;
    if (ch.kind === "buyin") return canBuyIn(s, seat);
    if (ch.round !== s.round) return false;
    if (ch.kind === "trigger") return s.phase === "AWAIT_TRIGGER" && s.currentSeat === seat && s.aimingAt === ch.target && ch.shot === s.shot;
    return canAccuse(s, seat) && ch.accused !== undefined && inPlay(s, ch.accused) && !s.busted.includes(ch.accused);
  }

  private validChallenge(seat: number, id: string, kind: Challenge["kind"]): PendingChallenge | string {
    const ch = this.challenges.get(seat);
    if (!ch || ch.id !== id || ch.kind !== kind) return "That moment passed. Try again.";
    if (!this.isChallengeLive(seat, ch)) {
      this.challenges.delete(seat);
      return "Too late: the table moved on.";
    }
    return ch;
  }

  private authFrom(ch: PendingChallenge, assertion?: PasskeyAssertion): SeatAuth | string {
    if (ch.requirePasskey && !assertion) return "Face ID is required for this seat";
    return assertion && ch.requirePasskey ? { type: "passkey", assertion, prepared: ch.prepared } : { type: "host" };
  }

  private challengeView(seat: number): Challenge | null {
    const ch = this.challenges.get(seat);
    if (!ch || !this.isChallengeLive(seat, ch)) return null;
    return { id: ch.id, kind: ch.kind, challenge: ch.challenge, target: ch.target, accused: ch.accused, requirePasskey: ch.requirePasskey };
  }

  /* ───────────── the loop ───────────── */

  dispatch(action: Action): string | undefined {
    if (this.disposed) return "Room closed";
    const r = step(this.state, action, {
      rng: this.rng,
      now: Date.now(),
      salt: () => randomBytes(32),
      forceCard: config.demoSeed ? (round, seat) => (round === 0 && this.state.seats[seat]?.personality === "gary" ? Cheat.HOT_LOAD : undefined) : undefined,
    });
    if (r.error) return r.error;
    const prev = this.state;
    this.state = r.state;
    for (const e of r.effects) this.handle(e);
    this.touch(false);
    this.broadcast();
    this.afterChange(prev);
    return undefined;
  }

  private handle(e: Effect) {
    const gen = this.generation;
    switch (e.type) {
      case "chain": {
        const p = this.enqueueChain(e.tag, e.call);
        if (e.then) {
          const then = e.then;
          const chainDone = config.waitForChain ? Promise.race([p, new Promise((r) => setTimeout(r, config.chainWaitCapMs))]) : Promise.resolve();
          Promise.all([chainDone, sleep(e.minMs ?? 0)]).then(() => {
            if (gen === this.generation) this.dispatch(then);
          });
        }
        return;
      }
      case "timer": {
        const old = this.timers.get(e.key);
        if (old) clearTimeout(old);
        this.timers.set(
          e.key,
          setTimeout(() => {
            this.timers.delete(e.key);
            if (gen === this.generation) this.dispatch(e.action);
          }, e.ms * config.timeScale),
        );
        return;
      }
      case "cancelTimer": {
        const old = this.timers.get(e.key);
        if (old) clearTimeout(old);
        this.timers.delete(e.key);
        return;
      }
      case "fx":
        if (e.fx.type === "round") this.pitBoss = {};
        this.emitFx(e.fx);
        return;
      case "toast":
        this.toast(e.seat, e.text);
        return;
      case "cashOut":
        this.cashOut(e.results);
        return;
      case "tape":
        void this.finishTape(gen);
        return;
    }
  }

  private enqueueChain(tag: string, call?: ChainCall, send?: () => Promise<Receipt>): Promise<Receipt> {
    const gen = this.generation;
    const referee = this.referee;
    const seat = call && (call.kind === "pullTrigger" ? call.shooter : call.kind === "accuse" ? call.accuser : call.kind === "reveal" ? call.seat : undefined);
    return this.queue.enqueue(send ?? (() => referee.run(call!))).then((rc) => {
      if (gen === this.generation) this.record(tag, rc, seat);
      return rc;
    });
  }

  private record(tag: string, rc: Receipt, seat?: number) {
    this.receipts.set(tag, rc);
    if (rc.ok) this.onChainActions++;
    else {
      this.failedTxs++;
      console.warn(`[room ${this.code}] ${rc.kind} failed: ${rc.error}`);
    }
    const tx: ChainTx = {
      id: ++this.txSeq,
      kind: rc.kind,
      seat,
      ms: rc.ms,
      ok: rc.ok,
      mock: rc.mock,
      signature: rc.signature,
      explorerUrl: rc.explorerUrl ?? (rc.signature ? this.referee.explorerTxUrl(rc.signature) : undefined),
      signer: rc.signer,
      error: rc.error,
      at: Date.now(),
    };
    this.chainLog.push(tx);
    if (this.chainLog.length > 60) this.chainLog.shift();
    this.io.to(this.all).emit(S2C.chainTx, tx);
    this.scheduleBroadcast();
  }

  private broadcastPending = false;
  /** Coalesce state pushes caused by chain receipts (the action counter). */
  private scheduleBroadcast() {
    if (this.broadcastPending) return;
    this.broadcastPending = true;
    setTimeout(() => {
      this.broadcastPending = false;
      if (!this.disposed) this.broadcast();
    }, 50);
  }

  private async finishTape(gen: number) {
    if (this.tapeStarted) return;
    this.tapeStarted = true;
    await this.queue.drain();
    await this.payouts;
    if (gen !== this.generation) return;
    this.tape = buildTape(this.state, this.receipts, {
      money: { ticker: this.bank.ticker, bankMode: this.bank.mode, results: this.state.results ?? [], transfers: this.transfers },
      refereeMode: this.referee.mode,
      tableAddress: this.tableAddress,
      explorerUrl: config.explorerUrl,
      onChainActions: this.onChainActions,
      failedTxs: this.failedTxs,
    });
    this.emitFx({ type: "tape", tape: this.tape });
    this.broadcast();
  }

  /* ───────────── output ───────────── */

  broadcast() {
    const pub = publicView(this.state, {
      refereeMode: this.referee.mode,
      bankMode: this.bank.mode,
      tableAddress: this.tableAddress,
      explorerUrl: config.explorerUrl,
      onChainActions: this.onChainActions,
    });
    this.io.to(this.all).emit(S2C.state, pub);
    const now = Date.now();
    for (const seat of this.state.seats) {
      if (seat.kind !== "human" || !seat.playerId) continue;
      this.io.to(this.playerRoom(seat.playerId)).emit(S2C.private, privateView(this.state, seat.seat, now, this.challengeView(seat.seat)));
    }
  }

  /** Everything a (re)connecting TV needs to catch up. */
  snapshotFor(socketEmit: (ev: string, payload: unknown) => void) {
    socketEmit(S2C.state, publicView(this.state, { refereeMode: this.referee.mode, bankMode: this.bank.mode, tableAddress: this.tableAddress, explorerUrl: config.explorerUrl, onChainActions: this.onChainActions }));
    for (const tx of this.chainLog.slice(-12)) socketEmit(S2C.chainTx, tx);
    if (Object.keys(this.pitBoss).length) socketEmit(S2C.pitboss, this.pitBoss);
    if (this.tape) socketEmit(S2C.fx, { type: "tape", tape: this.tape } satisfies Fx);
  }

  private emitFx(fx: Fx) {
    this.io.to(this.all).emit(S2C.fx, fx);
  }

  private toast(seat: number, text: string) {
    const p = this.state.seats[seat]?.playerId;
    if (p) this.io.to(this.playerRoom(p)).emit(S2C.toast, { text });
  }

  private log(text: string) {
    this.state.log.push({ id: ++this.state.logSeq, t: Date.now(), kind: "join", text });
    if (this.state.log.length > 60) this.state.log.shift();
  }

  private uniqueName(name: string): string {
    const taken = new Set(this.state.seats.map((x) => x.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) if (!taken.has(`${name} ${i}`.toLowerCase())) return `${name} ${i}`;
  }

  private touch(broadcast = true) {
    this.lastActivity = Date.now();
    if (broadcast) this.broadcast();
  }

  /* ───────────── bots & pit boss ───────────── */

  private afterChange(prev: GameState) {
    const s = this.state;
    if (s.publicShots.length > prev.publicShots.length) void this.runPitBoss();
    this.scheduleBotTurn();
    this.scheduleBotSideMoves();
    this.scheduleBotRebuys();
    this.scheduleAfk();
  }

  private afkKey = "";
  /**
   * A disconnected player shouldn't freeze the table. If they're up for 20 s while offline and their
   * seat is house-signed, the dealer shoots them (at themselves: house rules). Face ID seats wait,
   * because only their phone can sign their trigger pull.
   */
  private scheduleAfk() {
    const s = this.state;
    const cur = s.seats[s.currentSeat];
    const key = `${s.round}:${s.shot}:${s.currentSeat}`;
    if (!cur || cur.kind !== "human" || cur.connected || this.seatUsesPasskey(cur.seat)) return;
    if (s.phase !== "AWAIT_AIM" && s.phase !== "AWAIT_TRIGGER") return;
    if (this.afkKey === key) return;
    this.afkKey = key;
    const gen = this.generation;
    setTimeout(() => {
      const now = this.state;
      const seat = now.seats[now.currentSeat];
      if (gen !== this.generation || `${now.round}:${now.shot}:${now.currentSeat}` !== key || !seat || seat.connected) return;
      this.log(`🎩 The dealer plays for ${seat.name} (disconnected)`);
      if (now.phase === "AWAIT_AIM") this.dispatch({ type: "AIM", seat: seat.seat, target: seat.seat });
      if (this.phase() === "AWAIT_TRIGGER") this.dispatch({ type: "PULL", seat: seat.seat, auth: { type: "host" } });
    }, 20_000 * config.timeScale);
  }

  private scheduleBotTurn() {
    const s = this.state;
    const cur = s.seats[s.currentSeat];
    if (!cur || cur.kind !== "bot" || this.botTurnBusy) return;
    if (s.phase !== "AWAIT_AIM" && s.phase !== "AWAIT_TRIGGER") return;
    this.botTurnBusy = true;
    const gen = this.generation;
    void this.runBotTurn(cur.seat, cur.personality ?? "intern")
      .catch((e) => console.warn(`[room ${this.code}] bot turn failed`, e))
      .finally(() => {
        if (gen !== this.generation) return;
        this.botTurnBusy = false;
        // If the moment was interrupted (e.g. RIGGED!) and it's still this bot's turn, try again.
        setTimeout(() => this.scheduleBotTurn(), 250 * config.timeScale);
      });
  }

  /** Read through a method so TS doesn't narrow across awaits (dispatch replaces this.state). */
  private phase(): GameState["phase"] {
    return this.state.phase;
  }

  private botStillUp(seat: number): boolean {
    const s = this.state;
    return s.currentSeat === seat && (s.phase === "AWAIT_AIM" || s.phase === "AWAIT_TRIGGER");
  }

  private async runBotTurn(seat: number, id: BotId) {
    const r = this.botRng;
    await sleep(r.int(TIMING.botThinkMin, TIMING.botThinkMax));
    if (!this.botStillUp(seat)) return;

    let view = botView(this.state, seat, Date.now());
    const thought = await think(id, view, r, { wantAim: true, wantTaunt: r.next() < 0.4 });
    if (!this.botStillUp(seat)) return;

    let aim = thought.aim;
    if (this.state.phase === "AWAIT_AIM" && canCheat(this.state, seat)) {
      const card = this.state.secret.cards[seat];
      const shouldPeek = card === Cheat.PEEK && (id === "accountant" || thought.cheatNow);
      const shouldSwap = card === Cheat.SWAP && thought.cheatNow && view.odds.pLiveNext >= 0.5;
      if (shouldPeek || shouldSwap) {
        this.dispatch({ type: "CHEAT", seat });
        view = botView(this.state, seat, Date.now());
        aim = heuristicAim(id, view, r); // decide again with what we just learned
        await sleep(r.int(500, 900));
        if (!this.botStillUp(seat)) return;
      }
    }

    if (this.state.phase === "AWAIT_AIM") {
      if (!inPlay(this.state, aim)) aim = seat;
      if (this.dispatch({ type: "AIM", seat, target: aim })) return;
      await sleep(r.int(700, 1300));
      if (!this.botStillUp(seat) || this.phase() !== "AWAIT_TRIGGER") return;
    }

    const aimingAt = this.state.aimingAt;
    if (thought.taunt || r.next() < 0.25) {
      const moment: TauntMoment = aimingAt === seat ? "selfShotSurvived" : "hitSomeone";
      this.taunt(seat, thought.taunt ?? pickTaunt(moment, r));
    }
    this.dispatch({ type: "PULL", seat, auth: { type: "host" } });
  }

  private scheduleBotSideMoves() {
    const s = this.state;
    if (s.phase !== "AWAIT_AIM" && s.phase !== "AWAIT_TRIGGER" && s.phase !== "LAST_CALL") return;
    const moment = `${s.round}:${s.shot}:${s.phase}:${s.aimingAt}:${s.countIsOff}`;
    for (const bot of s.seats) {
      if (bot.kind !== "bot" || bot.chips <= 0) continue;
      if (bot.seat === s.currentSeat && s.phase !== "LAST_CALL") continue; // its own turn is handled above
      if (!canCheat(s, bot.seat) && !canAccuse(s, bot.seat)) continue;
      const key = `${moment}:${bot.seat}`;
      if (this.botMoments.has(key)) continue;
      this.botMoments.add(key);
      if (this.botMoments.size > 500) this.botMoments.clear();
      const gen = this.generation;
      setTimeout(() => {
        if (gen === this.generation) void this.botSideMove(bot.seat, bot.personality ?? "intern", moment);
      }, this.botRng.int(400, 2200) * config.timeScale);
    }
  }

  private async botSideMove(seat: number, id: BotId, moment: string) {
    const stillMoment = () => {
      const s = this.state;
      return `${s.round}:${s.shot}:${s.phase}:${s.aimingAt}:${s.countIsOff}` === moment;
    };
    if (!stillMoment()) return;
    const r = this.botRng;
    const view = botView(this.state, seat, Date.now());
    const thought = await think(id, view, r, { wantAim: false, wantTaunt: false });
    if (!stillMoment()) return;
    const s = this.state;

    if (canCheat(s, seat) && thought.cheatNow) {
      const good = goodMomentForCard(view, { amShooter: s.currentSeat === seat, aimingAt: s.aimingAt, shooter: s.currentSeat });
      const garyAsap = id === "gary" && view.me.card !== Cheat.PEEK && r.next() < 0.35;
      if (good || garyAsap) {
        this.dispatch({ type: "CHEAT", seat });
        return;
      }
    }

    if (canAccuse(this.state, seat)) {
      // Only point fingers once there's something to go on: a shot fired, or the count is off.
      if (s.shot === 0 && !s.countIsOff) return;
      const target = pickAccusation(id, view, thought.suspicion, r);
      if (target === null) return;
      if (!this.dispatch({ type: "ACCUSE", accuser: seat, accused: target, auth: { type: "host" } })) {
        this.taunt(seat, pickTaunt(s.countIsOff ? "countOff" : "accusing", r));
      }
    }
  }

  private taunt(seat: number, taunt: TauntId) {
    this.emitFx({ type: "taunt", seat, taunt, text: TAUNTS[taunt] });
  }

  private async runPitBoss() {
    if (this.pitBossBusy) return;
    this.pitBossBusy = true;
    const gen = this.generation;
    try {
      const read = await readPitBoss(pitBossView(this.state));
      if (gen !== this.generation) return;
      for (const seat of fundedSeats(this.state)) {
        const next = read[seat];
        if (next === undefined) continue;
        const old = this.pitBoss[seat];
        this.pitBoss[seat] = old === undefined ? next : 0.55 * old + 0.45 * next;
      }
      for (const seat of this.state.seats) if (seat.chips <= 0) delete this.pitBoss[seat.seat];
      this.io.to(this.all).emit(S2C.pitboss, this.pitBoss);
    } finally {
      this.pitBossBusy = false;
    }
  }
}
