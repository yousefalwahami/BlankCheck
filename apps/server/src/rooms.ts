import {
  BOTS,
  Cheat,
  MAX_SEATS,
  S2C,
  TAUNTS,
  TIMING,
  randomBytes,
  type BotId,
  type Challenge,
  type ChainTx,
  type Fx,
  type PasskeyAssertion,
  type TapeData,
  type TauntId,
} from "@blankcheck/shared";
import type { Server } from "socket.io";
import { goodMomentForCard, heuristicAim, pickAccusation, think } from "./ai/bots";
import { readPitBoss } from "./ai/pitBoss";
import { pickTaunt, type TauntMoment } from "./ai/taunts";
import { config } from "./config";
import { cryptoRng, seededRng, type Rng } from "./engine/rng";
import { isAlive, livingSeats, makeSeat, newGameState } from "./engine/rules";
import { step } from "./engine/step";
import type { Action, ChainCall, Effect, GameState, SeatAuth } from "./engine/types";
import { botView, canAccuse, canCheat, pitBossView, privateView, publicView } from "./engine/views";
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

  constructor(
    readonly code: string,
    private readonly io: Server,
    private readonly makeReferee: () => Referee,
    hearts: number,
    faceIdOnTrigger: boolean,
  ) {
    this.referee = makeReferee();
    this.rng = config.demoSeed ? seededRng(config.demoSeed) : cryptoRng();
    this.state = newGameState(code, { hearts, faceIdOnTrigger });
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

  join(playerId: string, rawName: string): { seat: number } | { error: string } {
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
    this.state.seats.push(makeSeat(seat, name, "human", { playerId, connected: true }));
    this.log(`${name} sat down`);
    this.touch();
    return { seat };
  }

  addBot(personality: BotId): string | undefined {
    if (this.state.phase !== "LOBBY") return "The game already started";
    if (this.state.seats.length >= MAX_SEATS) return "The table is full";
    const seat = this.state.seats.length;
    const name = this.uniqueName(BOTS[personality].name);
    this.state.seats.push(makeSeat(seat, name, "bot", { personality, wallet: this.referee.hostAddress(), walletReady: true }));
    this.log(`${BOTS[personality].emoji} ${name} pulls up a chair`);
    this.touch();
  }

  kick(seat: number): string | undefined {
    if (this.state.phase !== "LOBBY") return "Can't kick mid-game";
    const removed = this.state.seats.splice(seat, 1)[0];
    if (!removed) return "No such seat";
    this.state.seats.forEach((x, i) => (x.seat = i));
    if (removed.playerId) this.io.to(this.playerRoom(removed.playerId)).emit(S2C.toast, { text: "The host removed you from the table." });
    this.touch();
  }

  setConfig(c: { hearts?: number; faceIdOnTrigger?: boolean }): string | undefined {
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
      this.touch();
      return { wallet };
    } catch (e) {
      console.warn(`[room ${this.code}] wallet bind failed:`, e);
      return { error: "Couldn't create your wallet. You can still play; the house key will sign for you." };
    }
  }

  setConnected(playerId: string, connected: boolean) {
    const s = this.state.seats.find((x) => x.playerId === playerId);
    if (s) {
      s.connected = connected;
      this.touch();
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
    this.enqueueChain("create", undefined, () =>
      this.referee.createTable({ gameId, wallets: this.tableWallets, hearts: this.state.config.hearts }),
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
    if (config.demoSeed) this.rng = seededRng(config.demoSeed);
    const seats = this.state.seats.map((x) => ({ ...x, hearts: 0, wallet: x.kind === "bot" ? this.referee.hostAddress() : x.wallet }));
    this.state = newGameState(this.code, this.state.config);
    this.state.seats = seats;
    this.log("New game. Same table. Same liars.");
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
    if (accused === seat || !isAlive(s, accused)) return "Pick a living player";
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
    if (!s || s.hearts > 0 || this.state.phase === "LOBBY") return;
    this.emitFx({ type: "boo", seat });
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
    if (ch.round !== s.round) return false;
    if (ch.kind === "trigger") return s.phase === "AWAIT_TRIGGER" && s.currentSeat === seat && s.aimingAt === ch.target && ch.shot === s.shot;
    return canAccuse(s, seat) && ch.accused !== undefined && isAlive(s, ch.accused) && !s.busted.includes(ch.accused);
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
    if (gen !== this.generation) return;
    this.tape = buildTape(this.state, this.receipts, {
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
    socketEmit(S2C.state, publicView(this.state, { refereeMode: this.referee.mode, tableAddress: this.tableAddress, explorerUrl: config.explorerUrl, onChainActions: this.onChainActions }));
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
      if (!isAlive(this.state, aim)) aim = seat;
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
      if (bot.kind !== "bot" || bot.hearts <= 0) continue;
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
      for (const seat of livingSeats(this.state)) {
        const next = read[seat];
        if (next === undefined) continue;
        const old = this.pitBoss[seat];
        this.pitBoss[seat] = old === undefined ? next : 0.55 * old + 0.45 * next;
      }
      for (const seat of this.state.seats) if (seat.hearts <= 0) delete this.pitBoss[seat.seat];
      this.io.to(this.all).emit(S2C.pitboss, this.pitBoss);
    } finally {
      this.pitBossBusy = false;
    }
  }
}
