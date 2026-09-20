import {
  EVT,
  IX,
  MAX_ROUNDS,
  MAX_SEATS,
  MAX_SHELLS,
  MAX_WINDOWS,
  MIN_SHELLS,
  NO_SEAT,
  ROUND_NONE,
  TABLE_MAGIC,
  TABLE_OFFSETS as O,
  TABLE_SIZE,
  TABLE_STATUS,
  bytesEqual,
  encodeRefereeEvent,
  envOffset,
  envelopeHash,
  shellsHash,
} from "@blankcheck/shared";

/*
 * A line-by-line TypeScript mirror of programs/referee/src/blank_check.c.
 * MockReferee runs every instruction through this, so the offline game exercises the exact same
 * rules and byte layouts as the chain. Keep the two files in sync (error codes included).
 */

export const ERR = {
  SHORT: 0x2000,
  BAD_IX: 0x2001,
  ACCT: 0x2002,
  NOT_TABLE: 0x2003,
  NOT_HOST: 0x2004,
  NOT_SEAT: 0x2005,
  STATUS: 0x2006,
  ROUND: 0x2007,
  ARGS: 0x2008,
  TURN: 0x2009,
  PENDING: 0x200a,
  WINDOW: 0x200b,
  ACCUSE: 0x200c,
  HASH: 0x200d,
  CREATE: 0x200e,
  WRITABLE: 0x200f,
  RESIZE: 0x2010,
  SHOT: 0x2011,
  EVENT: 0x2012,
  CHIPS: 0x2013,
} as const;

export const ERR_NAMES: Record<number, string> = Object.fromEntries(Object.entries(ERR).map(([k, v]) => [v, k]));

export class Revert extends Error {
  constructor(public code: number) {
    super(`referee reverted: ${ERR_NAMES[code] ?? code.toString(16)}`);
  }
}

export type AccountStore = Map<string, Uint8Array>;

export type ExecCtx = {
  /** Transaction account addresses: 0 = fee payer, 1 = program, 2+ = others. */
  accounts: Uint8Array[];
  /** Which account indices count as authorized (fee payer always is). */
  authorized: Set<number>;
  store: AccountStore;
};

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const fail = (code: number): never => {
  throw new Revert(code);
};

type G = { t: Uint8Array; T: DataView; events: Uint8Array[] };

const chips = (g: G, i: number) => g.T.getUint16(O.chips + 2 * i, true);
const setChips = (g: G, i: number, v: number) => g.T.setUint16(O.chips + 2 * i, v, true);
const pot = (g: G) => g.T.getUint16(O.pot, true);
const setPot = (g: G, v: number) => g.T.setUint16(O.pot, v, true);
const u8 = (v: number) => Math.min(v, 255);

export function execute(ix: Uint8Array, ctx: ExecCtx): Uint8Array[] {
  const events: Uint8Array[] = [];
  if (ix.length < 6) fail(ERR.SHORT);
  const dv = new DataView(ix.buffer, ix.byteOffset, ix.byteLength);
  const kind = dv.getUint32(0, true);
  const tableIdx = dv.getUint16(4, true);
  if (tableIdx >= ctx.accounts.length) fail(ERR.ACCT);
  const tableAddr = ctx.accounts[tableIdx];

  if (kind === IX.CREATE_TABLE) {
    createTable(ix, dv, ctx, tableAddr, events);
    return events;
  }

  const t = ctx.store.get(hex(tableAddr));
  if (!t || t.length < TABLE_SIZE) fail(ERR.NOT_TABLE);
  for (let i = 0; i < 4; i++) if (t![i] !== TABLE_MAGIC[i]) fail(ERR.NOT_TABLE);
  const table = t!;
  const g: G = { t: table, T: new DataView(table.buffer, table.byteOffset, table.byteLength), events };
  const host = () => {
    if (!bytesEqual(ctx.accounts[0], table.subarray(O.host, O.host + 32))) fail(ERR.NOT_HOST);
  };
  const seatAuth = (walletIdx: number, seat: number) => {
    if (walletIdx >= ctx.accounts.length) fail(ERR.ACCT);
    const w = table.subarray(O.seatWallet + seat * 32, O.seatWallet + seat * 32 + 32);
    const hostAddr = table.subarray(O.host, O.host + 32);
    const addr = ctx.accounts[walletIdx];
    const ok = bytesEqual(addr, w) || bytesEqual(addr, hostAddr);
    if (!ok) fail(ERR.NOT_SEAT);
    if (walletIdx !== 0 && !ctx.authorized.has(walletIdx)) fail(ERR.NOT_SEAT);
  };
  const n = table[O.numSeats];

  switch (kind) {
    case IX.COMMIT_ROUND: {
      if (ix.length !== 6 + 4 + 32) fail(ERR.SHORT);
      host();
      const [round, shellCount, liveCount, firstSeat] = [ix[6], ix[7], ix[8], ix[9]];
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      const cur = table[O.round];
      if (round !== (cur === ROUND_NONE ? 0 : cur + 1)) fail(ERR.ROUND);
      if (!table[O.roundEnded]) fail(ERR.ROUND);
      if (shellCount === 0) {
        finishByProfit(g, 1);
        return events;
      }
      if (round >= MAX_ROUNDS || round >= table[O.roundsTotal]) fail(ERR.ROUND);
      if (shellCount < MIN_SHELLS || shellCount > MAX_SHELLS || liveCount < 1 || liveCount >= shellCount) fail(ERR.ARGS);
      if (firstSeat >= n || chips(g, firstSeat) === 0) fail(ERR.TURN);
      table[O.round] = round;
      table[O.roundEnded] = 0;
      table.set(ix.subarray(10, 42), O.shellsCommit + round * 32);
      table[O.shellCount + round] = shellCount;
      table[O.liveCount + round] = liveCount;
      table[O.windowCount + round] = 0;
      table[O.currentSeat] = firstSeat;
      table[O.shot] = 0;
      table[O.window] = 0;
      table.fill(0, O.busted, O.busted + MAX_SEATS);
      table.fill(0, O.accuseUsed, O.accuseUsed + MAX_SEATS);
      clearPending(table);
      emit(g, EVT.ROUND_COMMITTED, round, 0, firstSeat, NO_SEAT, shellCount, liveCount);
      return events;
    }

    case IX.PULL_TRIGGER: {
      if (ix.length !== 6 + 2 + 4) fail(ERR.SHORT);
      const walletIdx = dv.getUint16(6, true);
      const [round, shot, shooter, target] = [ix[8], ix[9], ix[10], ix[11]];
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (table[O.round] === ROUND_NONE || round !== table[O.round] || table[O.roundEnded]) fail(ERR.ROUND);
      if (shot !== table[O.shot] || shot >= table[O.shellCount + round]) fail(ERR.SHOT);
      if (shooter >= n || target >= n) fail(ERR.ARGS);
      if (shooter !== table[O.currentSeat] || chips(g, shooter) === 0 || chips(g, target) === 0) fail(ERR.TURN);
      if (table[O.triggerPulled] || table[O.pendingAccused] !== NO_SEAT) fail(ERR.PENDING);
      seatAuth(walletIdx, shooter);
      table[O.triggerPulled] = 1;
      table[O.pendingTarget] = target;
      emit(g, EVT.TRIGGER_PULLED, round, shot, shooter, target, 0, 0);
      return events;
    }

    case IX.RESOLVE_SHOT: {
      if (ix.length < 11) fail(ERR.SHORT);
      host();
      const [round, shot, isLive, window, cnt] = [ix[6], ix[7], ix[8], ix[9], ix[10]];
      if (ix.length !== 11 + 32 * cnt || cnt !== n) fail(ERR.SHORT);
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (round !== table[O.round]) fail(ERR.ROUND);
      if (shot !== table[O.shot]) fail(ERR.SHOT);
      if (!table[O.triggerPulled]) fail(ERR.PENDING);
      if (window !== table[O.window] || window >= MAX_WINDOWS) fail(ERR.WINDOW);
      if (isLive > 1) fail(ERR.ARGS);
      const shooter = table[O.currentSeat];
      const target = table[O.pendingTarget];
      // A live hit knocks one chip into the pot.
      if (isLive && chips(g, target) > 0) {
        setChips(g, target, chips(g, target) - 1);
        setPot(g, pot(g) + 1);
      }
      storeEnvelopes(table, round, window, ix.subarray(11), cnt);
      table[O.shot] = shot + 1;
      table[O.triggerPulled] = 0;
      table[O.pendingTarget] = NO_SEAT;
      emit(g, EVT.SHOT_RESOLVED, round, shot, shooter, target, isLive, u8(chips(g, target)));
      // A blank on yourself means you go again; otherwise the next seat with chips.
      if (!(isLive === 0 && target === shooter)) table[O.currentSeat] = nextFunded(g, shooter);
      return events;
    }

    case IX.SEAL: {
      if (ix.length < 9) fail(ERR.SHORT);
      host();
      const [round, window, cnt] = [ix[6], ix[7], ix[8]];
      if (ix.length !== 9 + 32 * cnt || cnt !== n) fail(ERR.SHORT);
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (round !== table[O.round]) fail(ERR.ROUND);
      if (window !== table[O.window] || window >= MAX_WINDOWS) fail(ERR.WINDOW);
      if (table[O.triggerPulled]) fail(ERR.PENDING);
      storeEnvelopes(table, round, window, ix.subarray(9), cnt);
      emit(g, EVT.SEALED, round, window, NO_SEAT, NO_SEAT, cnt, 0);
      return events;
    }

    case IX.ACCUSE: {
      if (ix.length !== 6 + 2 + 3) fail(ERR.SHORT);
      const walletIdx = dv.getUint16(6, true);
      const [round, accuser, accused] = [ix[8], ix[9], ix[10]];
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (round !== table[O.round] || table[O.roundEnded]) fail(ERR.ROUND);
      if (accuser >= n || accused >= n || accuser === accused) fail(ERR.ARGS);
      if (chips(g, accuser) === 0 || chips(g, accused) === 0) fail(ERR.TURN);
      if (table[O.accuseUsed + accuser] || table[O.busted + accused]) fail(ERR.ACCUSE);
      if (table[O.pendingAccused] !== NO_SEAT || table[O.triggerPulled]) fail(ERR.PENDING);
      seatAuth(walletIdx, accuser);
      table[O.accuseUsed + accuser] = 1;
      table[O.pendingAccuser] = accuser;
      table[O.pendingAccused] = accused;
      emit(g, EVT.ACCUSED, round, table[O.window], accuser, accused, 0, 0);
      return events;
    }

    case IX.REVEAL: {
      if (ix.length < 10) fail(ERR.SHORT);
      host();
      const [round, seat, mode, cnt] = [ix[6], ix[7], ix[8], ix[9]];
      if (ix.length !== 10 + 34 * cnt) fail(ERR.SHORT);
      if (round >= MAX_ROUNDS || seat >= n || mode > 1) fail(ERR.ARGS);
      if (mode === 0) {
        if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
        if (round !== table[O.round]) fail(ERR.ROUND);
        if (seat !== table[O.pendingAccused]) fail(ERR.PENDING);
        if (cnt !== table[O.window]) fail(ERR.WINDOW);
      } else {
        if (table[O.status] !== TABLE_STATUS.FINISHED) fail(ERR.STATUS);
        if (table[O.round] === ROUND_NONE || round > table[O.round]) fail(ERR.ROUND);
        if (cnt !== table[O.windowCount + round]) fail(ERR.WINDOW);
      }
      let guilty = 0;
      for (let i = 0; i < cnt; i++) {
        const at = 10 + 34 * i;
        const cheat = ix[at];
        const shell = ix[at + 1];
        const salt = ix.subarray(at + 2, at + 34);
        const h = envelopeHash(tableAddr, round, i, seat, cheat, shell, salt);
        const stored = table.subarray(envOffset(round, i, seat), envOffset(round, i, seat) + 32);
        if (!bytesEqual(h, stored)) fail(ERR.HASH);
        if (cheat !== 0) guilty = 1;
        if (mode === 1) emit(g, EVT.ENVELOPE_OPENED, round, i, seat, NO_SEAT, cheat, shell);
      }
      if (mode === 0) {
        // Guilty: the accuser takes ALL of the cheater's chips. Wrong call: the accuser pays one.
        const accuser = table[O.pendingAccuser];
        const from = guilty ? seat : accuser;
        const to = guilty ? accuser : seat;
        const moved = guilty ? chips(g, seat) : Math.min(1, chips(g, accuser));
        setChips(g, from, chips(g, from) - moved);
        setChips(g, to, chips(g, to) + moved);
        if (guilty) table[O.busted + seat] = 1;
        clearPending(table);
        emit(g, EVT.VERDICT, round, table[O.window], accuser, seat, guilty, u8(moved));
        // A shooter who went broke in a verdict passes the gun on.
        const cur = table[O.currentSeat];
        if (chips(g, cur) === 0) table[O.currentSeat] = nextFunded(g, cur);
      }
      return events;
    }

    case IX.REVEAL_SHELLS: {
      if (ix.length < 8) fail(ERR.SHORT);
      host();
      const [round, cnt] = [ix[6], ix[7]];
      if (ix.length !== 8 + cnt + 32) fail(ERR.SHORT);
      if (table[O.status] !== TABLE_STATUS.FINISHED) fail(ERR.STATUS);
      if (round >= MAX_ROUNDS || table[O.round] === ROUND_NONE || round > table[O.round]) fail(ERR.ROUND);
      if (cnt !== table[O.shellCount + round]) fail(ERR.ARGS);
      const shells = ix.subarray(8, 8 + cnt);
      let live = 0;
      for (const s of shells) {
        if (s > 1) fail(ERR.ARGS);
        live += s;
      }
      if (live !== table[O.liveCount + round]) fail(ERR.HASH);
      const h = shellsHash(tableAddr, round, shells, ix.subarray(8 + cnt, 8 + cnt + 32));
      if (!bytesEqual(h, table.subarray(O.shellsCommit + round * 32, O.shellsCommit + round * 32 + 32))) fail(ERR.HASH);
      emit(g, EVT.SHELLS_REVEALED, round, 0, NO_SEAT, NO_SEAT, cnt, live);
      return events;
    }

    case IX.BUY_IN: {
      if (ix.length !== 6 + 2 + 64) fail(ERR.SHORT);
      host();
      const [round, seat] = [ix[6], ix[7]];
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (table[O.round] === ROUND_NONE || round !== table[O.round]) fail(ERR.ROUND);
      if (seat >= n) fail(ERR.ARGS);
      if (chips(g, seat) !== 0) fail(ERR.CHIPS);
      if (table[O.triggerPulled] || table[O.pendingAccused] !== NO_SEAT) fail(ERR.PENDING);
      setChips(g, seat, table[O.buyInChips]);
      table[O.buyIns + seat] = u8(table[O.buyIns + seat] + 1);
      emit(g, EVT.BUY_IN, round, 0, seat, NO_SEAT, table[O.buyInChips], table[O.buyIns + seat]);
      return events;
    }

    case IX.END_ROUND: {
      if (ix.length !== 6 + 1) fail(ERR.SHORT);
      host();
      const round = ix[6];
      if (table[O.status] !== TABLE_STATUS.PLAYING) fail(ERR.STATUS);
      if (table[O.round] === ROUND_NONE || round !== table[O.round] || table[O.roundEnded]) fail(ERR.ROUND);
      if (table[O.triggerPulled] || table[O.pendingAccused] !== NO_SEAT) fail(ERR.PENDING);
      if (table[O.shot] < table[O.shellCount + round] && funded(g) >= 2) fail(ERR.SHOT);
      // The pot goes to the chip leader(s); an uneven split leaves the remainder in the pot.
      let max = 0;
      for (let i = 0; i < n; i++) max = Math.max(max, chips(g, i));
      let mask = 0;
      let count = 0;
      if (max > 0) for (let i = 0; i < n; i++) if (chips(g, i) === max) (mask |= 1 << i), count++;
      const each = count ? Math.floor(pot(g) / count) : 0;
      for (let i = 0; i < n; i++) if (mask & (1 << i)) setChips(g, i, chips(g, i) + each);
      setPot(g, pot(g) - each * count);
      table[O.roundEnded] = 1;
      emit(g, EVT.POT_AWARDED, round, 0, mask, NO_SEAT, u8(each), u8(pot(g)));
      if (round + 1 >= table[O.roundsTotal]) finishByProfit(g, 0);
      return events;
    }

    default:
      return fail(ERR.BAD_IX);
  }

  function createTable(ix: Uint8Array, dv: DataView, ctx: ExecCtx, addr: Uint8Array, events: Uint8Array[]) {
    if (ix.length < 17) fail(ERR.SHORT);
    const gameId = dv.getBigUint64(6, true);
    const n = ix[14];
    const buyInChips = ix[15];
    const rounds = ix[16];
    if (n < 2 || n > MAX_SEATS || buyInChips < 1 || buyInChips > 10 || rounds < 1 || rounds > MAX_ROUNDS) fail(ERR.ARGS);
    if (ix.length < 17 + 32 * n + 4) fail(ERR.SHORT);
    const proofSz = dv.getUint32(17 + 32 * n, true);
    if (ix.length !== 17 + 32 * n + 4 + proofSz) fail(ERR.SHORT);
    if (ctx.store.has(hex(addr))) fail(ERR.CREATE);
    const t = new Uint8Array(TABLE_SIZE);
    const g: G = { t, T: new DataView(t.buffer), events };
    t.set(TABLE_MAGIC, O.magic);
    t.set(ctx.accounts[0], O.host);
    g.T.setBigUint64(O.gameId, gameId, true);
    t[O.status] = TABLE_STATUS.PLAYING;
    t[O.numSeats] = n;
    t[O.buyInChips] = buyInChips;
    t[O.roundsTotal] = rounds;
    t[O.round] = ROUND_NONE;
    t[O.roundEnded] = 1;
    clearPending(t);
    t[O.winner] = NO_SEAT;
    for (let i = 0; i < n; i++) {
      setChips(g, i, buyInChips); // everyone bought in at the lobby
      t[O.buyIns + i] = 1;
      t.set(ix.subarray(17 + 32 * i, 17 + 32 * i + 32), O.seatWallet + 32 * i);
    }
    ctx.store.set(hex(addr), t);
    emit(g, EVT.TABLE_CREATED, 0, 0, NO_SEAT, NO_SEAT, n, buyInChips);
  }
}

function emit(g: G, kind: number, round: number, windowOrShot: number, seatA: number, seatB: number, value: number, value2: number) {
  g.events.push(encodeRefereeEvent({ kind, round, windowOrShot, seatA, seatB, value, value2, gameId: g.T.getBigUint64(O.gameId, true) }));
}

function clearPending(t: Uint8Array) {
  t[O.triggerPulled] = 0;
  t[O.pendingTarget] = NO_SEAT;
  t[O.pendingAccuser] = NO_SEAT;
  t[O.pendingAccused] = NO_SEAT;
}

function storeEnvelopes(t: Uint8Array, round: number, window: number, env: Uint8Array, cnt: number) {
  for (let i = 0; i < cnt; i++) t.set(env.subarray(32 * i, 32 * i + 32), envOffset(round, window, i));
  t[O.window] = window + 1;
  t[O.windowCount + round] = window + 1;
}

/** Must match nextFunded() in apps/server/src/engine/rules.ts. */
function nextFunded(g: G, from: number): number {
  const n = g.t[O.numSeats];
  for (let i = 1; i <= n; i++) {
    const c = (from + i) % n;
    if (chips(g, c) > 0) return c;
  }
  return from;
}

function funded(g: G): number {
  let k = 0;
  for (let i = 0; i < g.t[O.numSeats]; i++) if (chips(g, i) > 0) k++;
  return k;
}

/** The game is over: the winner is the biggest profit in chips (chips − buy-ins × chips-per-buy-in). */
function finishByProfit(g: G, early: number) {
  const t = g.t;
  const profit = (i: number) => chips(g, i) - t[O.buyIns + i] * t[O.buyInChips];
  let best = 0;
  for (let i = 1; i < t[O.numSeats]; i++) if (profit(i) > profit(best)) best = i;
  t[O.status] = TABLE_STATUS.FINISHED;
  t[O.winner] = best;
  emit(g, EVT.GAME_OVER, t[O.round], 0, best, NO_SEAT, early, 0);
}
