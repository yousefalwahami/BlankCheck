import {
  Cheat,
  CHEAT_INFO,
  MAX_ROUNDS,
  MAX_SEATS,
  MAX_WINDOWS,
  MIN_SEATS,
  NO_SHELL,
  PLAYABLE_CHEATS,
  TIMING,
  envelopeHash,
  fromHex,
  shellsHash,
  toHex,
  type CheatCode,
  type Phase,
} from "@blankcheck/shared";
import {
  emptySecret,
  envelopeKey,
  generateShells,
  isAlive,
  livingSeats,
  nextLiving,
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
      for (const seat of s.seats) seat.hearts = s.config.hearts;
      pushLog(s, ctx.now, "info", "The dealer takes a seat. Everyone cheats. The chain remembers.");
      beginRound(s, ctx, fx, ctx.rng.int(0, s.seats.length - 1));
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
      rule(isAlive(s, a.target), "That player is out");
      s.aimingAt = a.target;
      s.phase = "AWAIT_TRIGGER";
      return;
    }

    case "PULL": {
      rule(s.phase === "AWAIT_TRIGGER", "Pick a target first");
      rule(a.seat === s.currentSeat, "It's not your turn");
      rule(s.aimingAt !== null && isAlive(s, s.aimingAt), "Pick a living target");
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
      if (livingSeats(s).length <= 1) return gameOver(s, ctx, fx);
      if (s.shot >= s.secret.shells.length) return enterLastCall(s, ctx, fx);
      s.currentSeat = again ? shooter : nextLiving(s, shooter);
      s.aimingAt = null;
      s.phase = "AWAIT_AIM";
      s.turnStartedAt = ctx.now;
      return;
    }

    case "CHEAT": {
      rule(PLAY_PHASES.includes(s.phase), "You can't play a card right now");
      rule(isAlive(s, a.seat), "Ghosts can't cheat");
      const card = s.secret.cards[a.seat];
      rule(card !== undefined, "You have no card this round");
      rule(!s.secret.used[a.seat], "You already played your card");
      const i = s.shot;
      rule(i < s.secret.current.length, "The popper is empty");
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
      rule(isAlive(s, a.accuser), "Ghosts can't accuse");
      rule(isAlive(s, a.accused), "That player is already out");
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
      s.rigged = { accuser: a.accuser, accused: a.accused, verdict: null, evidence: null, resumePhase: s.phase };
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
      const loser = verdict === "GUILTY" ? accused : accuser;
      s.seats[loser].hearts = Math.max(0, s.seats[loser].hearts - 1);
      if (verdict === "GUILTY") s.busted.push(accused);
      s.rigged.verdict = verdict;
      s.rigged.evidence = evidence;
      s.tape[s.tape.length - 1].accusations.push({ accuser, accused, verdict, window: s.window - 1 });
      const eliminated = s.seats[loser].hearts === 0;
      pushLog(
        s,
        ctx.now,
        "verdict",
        verdict === "GUILTY"
          ? `⚖️ GUILTY: ${seatName(s, accused)} played ${evidence.map((e) => CHEAT_INFO[e.cheat].name).join(", ")}`
          : `⚖️ INNOCENT: ${seatName(s, accuser)} pays for the false call`,
        loser,
      );
      if (eliminated) pushLog(s, ctx.now, "elim", `👻 ${seatName(s, loser)} is out`, loser);
      fx.push({ type: "fx", fx: { type: "verdict", accuser, accused, verdict, evidence, loser, eliminated } });
      fx.push({ type: "timer", key: "phase", ms: TIMING.verdictShow, action: { type: "RESUME" } });
      return;
    }

    case "RESUME": {
      rule(s.phase === "RIGGED" && s.rigged?.verdict, "Nothing to resume");
      const resume = s.rigged.resumePhase;
      s.rigged = null;
      if (livingSeats(s).length <= 1) return gameOver(s, ctx, fx);
      if (resume === "LAST_CALL") return enterLastCall(s, ctx, fx);
      // Must match the referee: a shooter eliminated by a verdict passes the gun on.
      if (!isAlive(s, s.currentSeat)) {
        s.currentSeat = nextLiving(s, s.currentSeat);
        s.aimingAt = null;
        s.phase = "AWAIT_AIM";
        s.turnStartedAt = ctx.now;
      } else if (s.aimingAt !== null && !isAlive(s, s.aimingAt)) {
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
      beginRound(s, ctx, fx, nextLiving(s, s.lastShooter));
      return;
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

function beginRound(s: GameState, ctx: StepCtx, fx: Effect[], firstSeat: number): void {
  if (s.round + 1 >= MAX_ROUNDS) return gameOverByCap(s, ctx, fx);
  s.round += 1;
  const shells = generateShells(ctx.rng);
  const salt = ctx.salt();
  const commit = shellsHash(s.tableKey, s.round, shells, salt);
  const live = shells.filter((x) => x === 1).length;

  s.secret = { ...emptySecret(), envelopes: s.secret.envelopes, shells, current: shells.slice(), shellSalt: salt, commit };
  for (const seat of livingSeats(s)) {
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
  s.currentSeat = isAlive(s, firstSeat) ? firstSeat : nextLiving(s, firstSeat);
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
  });

  pushLog(s, ctx.now, "round", `Round ${s.round + 1}: ${live} LIVE · ${shells.length - live} BLANK`);
  fx.push({
    type: "chain",
    tag: `commit:${s.round}`,
    call: { kind: "commitRound", round: s.round, shellCount: shells.length, liveCount: live, firstSeat: s.currentSeat, commit },
  });
  fx.push({ type: "fx", fx: { type: "round", round: s.round, live, blank: shells.length - live } });
  fx.push({ type: "timer", key: "phase", ms: TIMING.roundIntro, action: { type: "BEGIN_TURNS" } });
}

function fire(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  const { shooter, target, hesitationMs, pLive } = s.pendingShot!;
  const i = s.shot;
  const live = s.secret.current[i] === 1;
  const committed = s.secret.shells[i];

  if (live) {
    s.fired.live += 1;
    s.seats[target].hearts = Math.max(0, s.seats[target].hearts - 1);
  } else {
    s.fired.blank += 1;
  }
  const eliminated = live && s.seats[target].hearts === 0;
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
  pushLog(s, ctx.now, "shot", live ? `🎉 POP! ${who} popped ${whom}.` : `💨 pfft. ${who} popped ${whom}.${again ? " Goes again." : ""}`, shooter);
  if (eliminated) pushLog(s, ctx.now, "elim", `👻 ${seatName(s, target)} is out`, target);

  const wasOff = s.countIsOff;
  const liveOver = s.fired.live > s.announced.live;
  const blankOver = s.fired.blank > s.announced.blank;
  if (liveOver || blankOver) s.countIsOff = true;

  fx.push({ type: "fx", fx: { type: "shot", shooter, target, live, heartsLeft: s.seats[target].hearts, eliminated, again } });
  if (!wasOff && s.countIsOff) {
    pushLog(s, ctx.now, "mismatch", `⚠ THE COUNT IS OFF: ${liveOver ? "too many LIVE" : "too many BLANK"}`);
    fx.push({ type: "fx", fx: { type: "mismatch", which: liveOver ? "live" : "blank" } });
  }
  fx.push({ type: "timer", key: "phase", ms: TIMING.shotAnim, action: { type: "ADVANCE" } });
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

function gameOver(s: GameState, ctx: StepCtx, fx: Effect[], winner?: number): void {
  const w = winner ?? livingSeats(s)[0] ?? s.currentSeat;
  s.winner = w;
  s.phase = "OVER";
  s.aimingAt = null;
  s.lastCallEndsAt = null;
  pushLog(s, ctx.now, "win", `🏆 ${seatName(s, w)} is the last one standing`, w);
  fx.push({ type: "fx", fx: { type: "gameOver", winner: w } });
  fx.push({ type: "timer", key: "phase", ms: TIMING.gameOverToTape, action: { type: "TAPE" } });
}

/** Out of on-chain round slots: most hearts wins (lowest seat on a tie). Must match COMMIT_ROUND with 0 shells. */
function gameOverByCap(s: GameState, ctx: StepCtx, fx: Effect[]): void {
  let best = 0;
  for (const seat of s.seats) if (seat.hearts > s.seats[best].hearts) best = seat.seat;
  fx.push({
    type: "chain",
    tag: `finish:${s.round + 1}`,
    call: { kind: "commitRound", round: s.round + 1, shellCount: 0, liveCount: 0, firstSeat: 0, commit: new Uint8Array(32) },
  });
  pushLog(s, ctx.now, "info", "The dealer is out of shells. Most hearts wins.");
  gameOver(s, ctx, fx, best);
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
