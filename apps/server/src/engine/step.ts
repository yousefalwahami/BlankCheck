import {
  Cheat,
  CHEAT_INFO,
  MAX_SEATS,
  MAX_WINDOWS,
  MIN_SEATS,
  MONEY,
  NO_SHELL,
  PLAYABLE_CHEATS,
  TIMING,
  dollars,
  envelopeHash,
  fromHex,
  shellsHash,
  toHex,
  type CashOutResult,
  type CheatCode,
  type Phase,
} from "@blankcheck/shared";
import {
  BUY_IN_PHASES,
  canAfford,
  emptySecret,
  envelopeKey,
  fundedSeats,
  generateShells,
  inPlay,
  nextFunded,
  potLeaders,
  profitChips,
  publicPLive,
  pushLog,
  seatName,
} from "./rules";
import type { Action, Effect, GameState, StepCtx, StepResult } from "./types";

class RuleError extends Error {}

function rule(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new RuleError(msg);
}

const PLAY_PHASES: Phase[] = ["AWAIT_AIM", "AWAIT_TRIGGER"];
const ACCUSE_PHASES: Phase[] = ["AWAIT_AIM", "AWAIT_TRIGGER", "LAST_CALL"];

/**
 * The rules, as a reducer. Returns a new state plus effects (chain calls, timers, fx, toasts)
 * for the room controller to carry out. Invalid actions return the old state and an error.
 */
export function step(state: GameState, action: Action, ctx: StepCtx): StepResult {
  const s = structuredClone(state);
  const fx: Effect[] = [];
  try {
    reduce(s, action, ctx, fx);
  } catch (e) {
    if (e instanceof RuleError) return { state, effects: [], error: e.message };
    throw e;
  }
  return { state: s, effects: fx };
}

function reduce(s: GameState, a: Action, ctx: StepCtx, fx: Effect[]): void {
  switch (a.type) {
    case "START": {
      rule(s.phase === "LOBBY", "The game already started");
      rule(s.seats.length >= MIN_SEATS, `Need at least ${MIN_SEATS} players`);
      rule(s.seats.length <= MAX_SEATS, `At most ${MAX_SEATS} players`);
      const waiting = s.seats.filter((x) => x.chips === 0);
      rule(waiting.length === 0, `Waiting for ${waiting.map((x) => x.name).join(", ")} to buy in`);
      pushLog(s, ctx.now, "info", "The dealer takes a seat. Everyone cheats. The chain remembers.");
      const funded = fundedSeats(s);
      beginRound(s, ctx, fx, funded[ctx.rng.int(0, funded.length - 1)]);
      return;
    }

    case "BUY_IN": {
      rule(BUY_IN_PHASES.includes(s.phase), "Hold on: finish this shot first");
      const seat = s.seats[a.seat];
      rule(seat, "No such seat");
      rule(seat.chips === 0, "You still have chips");
      rule(canAfford(seat), `You need ${dollars(MONEY.buyInCents)} in your wallet`);
      rule(!(s.phase === "ROUND_END" && s.round + 1 >= s.config.rounds), "The game is over");
      seat.chips = MONEY.buyInChips;
      seat.buyIns += 1;
      seat.bankrollCents! -= MONEY.buyInCents;
      pushLog(s, ctx.now, "money", `💰 ${seat.name} buys in: ${dollars(MONEY.buyInCents)} → ${MONEY.buyInChips} chips`, seat.seat);
      fx.push({ type: "fx", fx: { type: "buyIn", seat: seat.seat, chips: MONEY.buyInChips, cents: MONEY.buyInCents } });
      if (s.phase === "LOBBY") return; // the table is created with everyone's first buy-in

      fx.push({
        type: "chain",
        tag: `buyin:${s.round}:${seat.seat}:${seat.buyIns}`,
        call: { kind: "buyIn", round: s.round, seat: seat.seat, paymentTx: a.paymentTx },
      });
      s.tape[s.tape.length - 1]?.buyIns.push({ seat: seat.seat });
      // Everyone who could buy back in has: don't make the table wait for the timer.
      if (s.phase === "BUY_INS" && s.seats.every((x) => x.chips > 0 || !canAfford(x)) && fundedSeats(s).length >= 2) {
        fx.push({ type: "cancelTimer", key: "phase" });
        startNextRound(s, ctx, fx);
      }
      return;
    }

    case "BEGIN_TURNS": {
      rule(s.phase === "ROUND_START", "Not starting a round");
      s.phase = "AWAIT_AIM";
      s.turnStartedAt = ctx.now;
      return;
    }

    case "AIM": {
      rule(PLAY_PHASES.includes(s.phase), "Not your moment");
      rule(a.seat === s.currentSeat, "It's not your turn");
      rule(inPlay(s, a.target), "They're broke: nothing to shoot for");
      s.aimingAt = a.target;
      s.phase = "AWAIT_TRIGGER";
      return;
    }

    case "PULL": {
      rule(s.phase === "AWAIT_TRIGGER", "Pick a target first");
      rule(a.seat === s.currentSeat, "It's not your turn");
      rule(s.aimingAt !== null && inPlay(s, s.aimingAt), "Pick a target with chips");
      const target = s.aimingAt;
      s.phase = "RESOLVING";
      s.pendingShot = {
        shooter: a.seat,
        target,
        hesitationMs: s.turnStartedAt === null ? 0 : Math.max(0, ctx.now - s.turnStartedAt),
        pLive: publicPLive(s),
      };
      fx.push({
        type: "chain",
        tag: `trigger:${s.round}:${s.shot}`,
        call: { kind: "pullTrigger", round: s.round, shot: s.shot, shooter: a.seat, target, auth: a.auth },
        then: { type: "FIRE" },
      });
      return;
    }

    case "FIRE": {
      rule(s.phase === "RESOLVING" && s.pendingShot, "No trigger pulled");
      fire(s, ctx, fx);
      return;
    }

    case "ADVANCE": {
      rule(s.phase === "RESOLVING" && s.lastShot, "Nothing to advance");
      const { shooter, again } = s.lastShot;
      s.lastShot = null;
      if (fundedSeats(s).length < 2) return endRound(s, ctx, fx);
      if (s.shot >= s.secret.shells.length) return enterLastCall(s, ctx, fx);
      s.currentSeat = again && inPlay(s, shooter) ? shooter : nextFunded(s, shooter);
      s.aimingAt = null;
      s.phase = "AWAIT_AIM";
      s.turnStartedAt = ctx.now;
      return;
    }

    case "CHEAT": {
      rule(PLAY_PHASES.includes(s.phase), "You can't play a card right now");
      rule(inPlay(s, a.seat), "You're broke: buy back in first");
      const card = s.secret.cards[a.seat];
      rule(card !== undefined, "You have no card this round");
      rule(!s.secret.used[a.seat], "You already played your card");
      const i = s.shot;
      rule(i < s.secret.current.length, "The gun is empty");
      const sec = s.secret;
      let note = `${CHEAT_INFO[card].emoji} ${CHEAT_INFO[card].name} played on shell #${i + 1}.`;
      if (card === Cheat.PEEK) {
        sec.peeks[a.seat] = { shell: i, live: sec.current[i] === 1, until: ctx.now + TIMING.peekVisible };
      } else if (card === Cheat.HOT_LOAD) {
        sec.current[i] = 1;
      } else if (card === Cheat.DUD) {
        sec.current[i] = 0;
      } else if (card === Cheat.SWAP) {
        if (i + 1 < sec.current.length) [sec.current[i], sec.current[i + 1]] = [sec.current[i + 1], sec.current[i]];
        else note = "🔀 SWAP fizzled: that was the last shell. (It still counts as a cheat.)";
      }
      sec.used[a.seat] = { cheat: card, shell: i };
      sec.pendingCheats[a.seat] = { cheat: card, shell: i };
      sec.chamberCheats.push({ seat: a.seat, cheat: card });
      fx.push({ type: "toast", seat: a.seat, text: note });
      return;
    }

    case "ACCUSE": {
      rule(ACCUSE_PHASES.includes(s.phase), "Hold on. Wait for the shot to land.");
      rule(inPlay(s, a.accuser), "You need chips on the table to call RIGGED!");
      rule(inPlay(s, a.accused), "They're broke: nothing to take");
      rule(a.accuser !== a.accused, "You can't accuse yourself");
      rule(!s.accuseUsed.includes(a.accuser), "You already called RIGGED! this round");
      rule(!s.busted.includes(a.accused), "They're already BUSTED this round");
      s.accuseUsed.push(a.accuser);

      // Flush: seal any unsealed cheats so the accused's envelopes are complete before they're opened.
      const sealed = sealWindow(s, ctx);
      fx.push({ type: "chain", tag: `seal:${s.round}:${sealed.window}`, call: { kind: "seal", round: s.round, window: sealed.window, envelopes: sealed.hashes } });
      fx.push({
        type: "chain",
        tag: `accuse:${s.round}:${a.accuser}`,
        call: { kind: "accuse", round: s.round, accuser: a.accuser, accused: a.accused, auth: a.auth },
      });
      fx.push({
        type: "chain",
        tag: `reveal:${s.round}:${a.accused}:0`,
        call: { kind: "reveal", round: s.round, seat: a.accused, mode: 0, entries: roundEntries(s, s.round, a.accused) },
        then: { type: "VERDICT" },
        minMs: TIMING.riggedTheater,
      });

      if (s.phase === "LAST_CALL") {
        fx.push({ type: "cancelTimer", key: "phase" });
        s.lastCallEndsAt = null;
      }
      s.rigged = { accuser: a.accuser, accused: a.accused, verdict: null, evidence: null, chipsMoved: null, resumePhase: s.phase };
      s.phase = "RIGGED";
      pushLog(s, ctx.now, "rigged", `🚨 ${seatName(s, a.accuser)} yells RIGGED! at ${seatName(s, a.accused)}`, a.accuser);
      fx.push({ type: "fx", fx: { type: "rigged", accuser: a.accuser, accused: a.accused } });
      return;
    }

    case "VERDICT": {
      rule(s.phase === "RIGGED" && s.rigged && s.rigged.verdict === null, "No accusation pending");
      const { accuser, accused } = s.rigged;
      const opened = roundEnvelopes(s, s.round, accused);
      for (const e of opened) e.caught = true;
      const evidence = opened.filter((e) => e.cheat !== Cheat.NONE).map((e) => ({ window: e.window, cheat: e.cheat, shell: e.shell }));
      const verdict = evidence.length > 0 ? "GUILTY" : "INNOCENT";
      // Must match REVEAL (mode 0) in blank_check.c: guilty hands over every chip, a wrong call costs one.
      const from = verdict === "GUILTY" ? accused : accuser;
      const to = verdict === "GUILTY" ? accuser : accused;
      const moved = verdict === "GUILTY" ? s.seats[accused].chips : Math.min(1, s.seats[accuser].chips);
      s.seats[from].chips -= moved;
      s.seats[to].chips += moved;
      if (verdict === "GUILTY") s.busted.push(accused);
      s.rigged.verdict = verdict;
      s.rigged.evidence = evidence;
      s.rigged.chipsMoved = moved;
      s.tape[s.tape.length - 1].accusations.push({ accuser, accused, verdict, window: s.window - 1, chipsMoved: moved });
      const broke = s.seats[from].chips === 0;
      pushLog(
        s,
        ctx.now,
        "verdict",
        verdict === "GUILTY"
          ? `⚖️ GUILTY: ${seatName(s, accused)} played ${evidence.map((e) => CHEAT_INFO[e.cheat].name).join(", ")} and hands over ${moved} chip${moved === 1 ? "" : "s"}`
          : `⚖️ INNOCENT: ${seatName(s, accuser)} pays ${seatName(s, accused)} a chip for the false call`,
        from,
      );
      fx.push({ type: "fx", fx: { type: "verdict", accuser, accused, verdict, evidence, from, to, chips: moved, broke } });
      if (broke) wentBroke(s, ctx, fx, from);
      fx.push({ type: "timer", key: "phase", ms: TIMING.verdictShow, action: { type: "RESUME" } });
      return;
    }

    case "RESUME": {
      rule(s.phase === "RIGGED" && s.rigged?.verdict, "Nothing to resume");
      const resume = s.rigged.resumePhase;
      s.rigged = null;
      if (fundedSeats(s).length < 2) return endRound(s, ctx, fx);
      if (resume === "LAST_CALL") return enterLastCall(s, ctx, fx);
      // Must match the referee: a shooter who went broke in a verdict passes the gun on.
      if (!inPlay(s, s.currentSeat)) {
        s.currentSeat = nextFunded(s, s.currentSeat);
        s.aimingAt = null;
        s.phase = "AWAIT_AIM";
        s.turnStartedAt = ctx.now;
      } else if (s.aimingAt !== null && !inPlay(s, s.aimingAt)) {
        s.aimingAt = null;
        s.phase = "AWAIT_AIM";
      } else {
        s.phase = resume;
      }
      return;
    }

    case "LAST_CALL_END": {
      rule(s.phase === "LAST_CALL", "Not in Last Call");
      s.lastCallEndsAt = null;
      endRound(s, ctx, fx);
      return;
    }

    case "NEXT_ROUND": {
      rule(s.phase === "ROUND_END", "The round isn't over");
      if (s.round + 1 >= s.config.rounds) return gameOver(s, ctx, fx, false);
      if (fundedSeats(s).length >= 2) return startNextRound(s, ctx, fx);
      const couldPlay = s.seats.filter((x) => x.chips > 0 || canAfford(x)).length;
      if (couldPlay < 2) return gameOver(s, ctx, fx, true);
      s.phase = "BUY_INS";
      s.buyInsEndAt = ctx.now + TIMING.buyInWindow;
      pushLog(s, ctx.now, "money", "💸 Not enough chips on the table. Buy back in to keep playing!");
      fx.push({ type: "fx", fx: { type: "buyInWindow", endsAt: s.buyInsEndAt } });
      fx.push({ type: "timer", key: "phase", ms: TIMING.buyInWindow, action: { type: "BUY_INS_END" } });
      return;
    }

    case "BUY_INS_END": {
      rule(s.phase === "BUY_INS", "Not waiting for buy-ins");
      s.buyInsEndAt = null;
      if (fundedSeats(s).length >= 2) return startNextRound(s, ctx, fx);
      return gameOver(s, ctx, fx, true);
    }

    case "TAPE": {
      rule(s.phase === "OVER", "The game isn't over");
      s.phase = "TAPE";
      for (const r of s.tape) {
        r.envelopes = Object.values(s.secret.envelopes)
          .filter((e) => e.round === r.round)
          .sort((x, y) => x.window - y.window || x.seat - y.seat)
          .map((e) => ({ window: e.window, seat: e.seat, cheat: e.cheat, shell: e.shell, salt: toHex(e.salt), hash: toHex(e.hash), caught: e.caught }));
        for (const seat of s.seats) {
          const entries = roundEntries(s, r.round, seat.seat);
          if (entries.length === 0) continue;
          fx.push({ type: "chain", tag: `tape:${r.round}:${seat.seat}`, call: { kind: "reveal", round: r.round, seat: seat.seat, mode: 1, entries } });
        }
        if (r.shells.length > 0) {
          fx.push({
            type: "chain",
            tag: `shells:${r.round}`,
            call: { kind: "revealShells", round: r.round, shells: r.shells, salt: fromHex(r.shellSalt) },
          });
        }
      }
      fx.push({ type: "tape" });
      return;
    }
  }
}

function startNextRound(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  s.buyInsEndAt = null;
  beginRound(s, ctx, fx, nextFunded(s, s.lastShooter));
}

function beginRound(s: GameState, ctx: StepCtx, fx: Effect[], firstSeat: number): void {
  s.round += 1;
  const shells = generateShells(ctx.rng);
  const salt = ctx.salt();
  const commit = shellsHash(s.tableKey, s.round, shells, salt);
  const live = shells.filter((x) => x === 1).length;

  s.secret = { ...emptySecret(), envelopes: s.secret.envelopes, shells, current: shells.slice(), shellSalt: salt, commit };
  for (const seat of fundedSeats(s)) {
    const dealt = ctx.rng.pick(PLAYABLE_CHEATS) as CheatCode;
    s.secret.cards[seat] = ctx.forceCard?.(s.round, seat) ?? dealt;
  }

  s.announced = { live, blank: shells.length - live };
  s.fired = { live: 0, blank: 0 };
  s.countIsOff = false;
  s.shot = 0;
  s.window = 0;
  s.busted = [];
  s.accuseUsed = [];
  s.aimingAt = null;
  s.pendingShot = null;
  s.lastShot = null;
  s.currentSeat = inPlay(s, firstSeat) ? firstSeat : nextFunded(s, firstSeat);
  s.phase = "ROUND_START";
  s.turnStartedAt = null;

  s.tape.push({
    round: s.round,
    shells,
    shellSalt: toHex(salt),
    commit: toHex(commit),
    announced: { ...s.announced },
    firstSeat: s.currentSeat,
    shots: [],
    envelopes: [],
    accusations: [],
    buyIns: [],
    pot: null,
  });

  pushLog(s, ctx.now, "round", `Round ${s.round + 1} of ${s.config.rounds}: ${live} LIVE · ${shells.length - live} BLANK`);
  fx.push({
    type: "chain",
    tag: `commit:${s.round}`,
    call: { kind: "commitRound", round: s.round, shellCount: shells.length, liveCount: live, firstSeat: s.currentSeat, commit },
  });
  fx.push({ type: "fx", fx: { type: "round", round: s.round, rounds: s.config.rounds, live, blank: shells.length - live } });
  fx.push({ type: "timer", key: "phase", ms: TIMING.roundIntro, action: { type: "BEGIN_TURNS" } });
}

function fire(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  const { shooter, target, hesitationMs, pLive } = s.pendingShot!;
  const i = s.shot;
  const live = s.secret.current[i] === 1;
  const committed = s.secret.shells[i];

  // Must match RESOLVE_SHOT in blank_check.c: a live hit knocks one chip into the pot.
  if (live) {
    s.fired.live += 1;
    if (s.seats[target].chips > 0) {
      s.seats[target].chips -= 1;
      s.pot += 1;
    }
  } else {
    s.fired.blank += 1;
  }
  const broke = live && s.seats[target].chips === 0;
  const again = !live && target === shooter;

  const sealed = sealWindow(s, ctx);
  fx.push({
    type: "chain",
    tag: `resolve:${s.round}:${i}`,
    call: { kind: "resolveShot", round: s.round, shot: i, isLive: live, window: sealed.window, envelopes: sealed.hashes },
  });

  s.tape[s.tape.length - 1].shots.push({
    shot: i,
    window: sealed.window,
    shooter,
    target,
    shellIndex: i,
    committed,
    fired: live ? 1 : 0,
    cheats: s.secret.chamberCheats,
    pLiveAnnounced: pLive,
    hesitationMs,
  });
  s.publicShots.push({ round: s.round, shooter, target, live, pLive, hesitationMs });
  s.secret.chamberCheats = [];
  s.shot += 1;
  s.lastShooter = shooter;
  s.pendingShot = null;
  s.lastShot = { shooter, target, live, again };

  const who = seatName(s, shooter);
  const whom = target === shooter ? "themselves" : seatName(s, target);
  pushLog(s, ctx.now, "shot", live ? `💥 BANG. ${who} shot ${whom}: a chip into the pot.` : `💨 click. ${who} shot ${whom}.${again ? " Goes again." : ""}`, shooter);

  const wasOff = s.countIsOff;
  const liveOver = s.fired.live > s.announced.live;
  const blankOver = s.fired.blank > s.announced.blank;
  if (liveOver || blankOver) s.countIsOff = true;

  fx.push({ type: "fx", fx: { type: "shot", shooter, target, live, chipsLeft: s.seats[target].chips, broke, pot: s.pot, again } });
  if (broke) wentBroke(s, ctx, fx, target);
  if (!wasOff && s.countIsOff) {
    pushLog(s, ctx.now, "mismatch", `⚠ THE COUNT IS OFF: ${liveOver ? "too many LIVE" : "too many BLANK"}`);
    fx.push({ type: "fx", fx: { type: "mismatch", which: liveOver ? "live" : "blank" } });
  }
  fx.push({ type: "timer", key: "phase", ms: TIMING.shotAnim, action: { type: "ADVANCE" } });
}

function wentBroke(s: GameState, ctx: StepCtx, fx: Effect[], seat: number): void {
  const x = s.seats[seat];
  x.cleanedOut = !canAfford(x);
  pushLog(
    s,
    ctx.now,
    "elim",
    x.cleanedOut ? `💀 ${x.name} is cleaned out` : `💸 ${x.name} is broke. Buy back in for ${dollars(MONEY.buyInCents)}!`,
    seat,
  );
  fx.push({ type: "fx", fx: { type: "broke", seat, cleanedOut: x.cleanedOut } });
}

function enterLastCall(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  s.phase = "LAST_CALL";
  s.aimingAt = null;
  s.lastCallEndsAt = ctx.now + TIMING.lastCall;
  if (Object.keys(s.secret.pendingCheats).length > 0 && s.window < MAX_WINDOWS) {
    const sealed = sealWindow(s, ctx);
    fx.push({ type: "chain", tag: `seal:${s.round}:${sealed.window}`, call: { kind: "seal", round: s.round, window: sealed.window, envelopes: sealed.hashes } });
  }
  fx.push({ type: "fx", fx: { type: "lastCall", endsAt: s.lastCallEndsAt } });
  fx.push({ type: "timer", key: "phase", ms: TIMING.lastCall, action: { type: "LAST_CALL_END" } });
}

/** The pot goes to the chip leader (ties split; the remainder carries over). Must match END_ROUND in blank_check.c. */
function endRound(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  s.phase = "ROUND_END";
  s.aimingAt = null;
  s.lastCallEndsAt = null;
  const winners = potLeaders(s);
  const chipsEach = winners.length ? Math.floor(s.pot / winners.length) : 0;
  for (const w of winners) s.seats[w].chips += chipsEach;
  s.pot -= chipsEach * winners.length;
  s.tape[s.tape.length - 1].pot = { winners, chipsEach, carried: s.pot };
  fx.push({ type: "chain", tag: `endround:${s.round}`, call: { kind: "endRound", round: s.round } });
  if (chipsEach > 0) {
    pushLog(s, ctx.now, "money", `🏦 The pot (${chipsEach * winners.length}) goes to ${winners.map((w) => seatName(s, w)).join(" & ")}`);
  }
  fx.push({ type: "fx", fx: { type: "potAward", round: s.round, winners: chipsEach > 0 ? winners : [], chipsEach, carried: s.pot } });
  fx.push({ type: "timer", key: "phase", ms: TIMING.potAward, action: { type: "NEXT_ROUND" } });
}

/** Everyone cashes out at $4 a chip; the biggest profit wins (lowest seat on a tie, like the referee). */
function gameOver(s: GameState, ctx: StepCtx, fx: Effect[], early: boolean): void {
  if (early) {
    // Out of players before the last round: COMMIT_ROUND with 0 shells finishes the game on-chain.
    fx.push({
      type: "chain",
      tag: `finish:${s.round + 1}`,
      call: { kind: "commitRound", round: s.round + 1, shellCount: 0, liveCount: 0, firstSeat: 0, commit: new Uint8Array(32) },
    });
    pushLog(s, ctx.now, "info", "Not enough players left with money. Cashing out.");
  }
  const results: CashOutResult[] = s.seats.map((x) => {
    const cashOutCents = x.chips * MONEY.chipCents;
    const spentCents = x.buyIns * MONEY.buyInCents;
    return { seat: x.seat, chips: x.chips, buyIns: x.buyIns, spentCents, cashOutCents, profitCents: cashOutCents - spentCents };
  });
  let w = 0;
  for (const x of s.seats) if (profitChips(x) > profitChips(s.seats[w])) w = x.seat;
  for (const x of s.seats) x.bankrollCents = (x.bankrollCents ?? 0) + x.chips * MONEY.chipCents;
  s.winner = w;
  s.results = results;
  s.phase = "OVER";
  s.aimingAt = null;
  s.lastCallEndsAt = null;
  s.buyInsEndAt = null;
  const top = results[w];
  pushLog(s, ctx.now, "win", `🏆 ${seatName(s, w)} cashes out ${dollars(top.cashOutCents)} (${top.profitCents >= 0 ? "+" : ""}${dollars(top.profitCents)})`, w);
  fx.push({ type: "fx", fx: { type: "gameOver", winner: w, results } });
  fx.push({ type: "cashOut", results });
  fx.push({ type: "timer", key: "phase", ms: TIMING.gameOverToTape, action: { type: "TAPE" } });
}

/** Seal one envelope per seat (a decoy NONE unless that seat has an unsealed cheat). */
function sealWindow(s: GameState, ctx: StepCtx): { window: number; hashes: Uint8Array[] } {
  rule(s.window < MAX_WINDOWS, "Too many seal windows this round");
  const w = s.window;
  const hashes: Uint8Array[] = [];
  for (const seat of s.seats) {
    const p = s.secret.pendingCheats[seat.seat];
    const cheat: CheatCode = p?.cheat ?? Cheat.NONE;
    const shell = p?.shell ?? NO_SHELL;
    const salt = ctx.salt();
    const hash = envelopeHash(s.tableKey, s.round, w, seat.seat, cheat, shell, salt);
    s.secret.envelopes[envelopeKey(s.round, w, seat.seat)] = { round: s.round, window: w, seat: seat.seat, cheat, shell, salt, hash, caught: false };
    hashes.push(hash);
  }
  s.secret.pendingCheats = {};
  s.window += 1;
  return { window: w, hashes };
}

function roundEnvelopes(s: GameState, round: number, seat: number) {
  const out = [];
  for (let w = 0; ; w++) {
    const e = s.secret.envelopes[envelopeKey(round, w, seat)];
    if (!e) break;
    out.push(e);
  }
  return out;
}

function roundEntries(s: GameState, round: number, seat: number) {
  return roundEnvelopes(s, round, seat).map((e) => ({ cheat: e.cheat, shell: e.shell, salt: e.salt }));
}

