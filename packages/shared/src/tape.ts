import { bytesEqual, fromHex, toHex } from "./bytes";
import { Cheat, CHEAT_INFO, MONEY, dollars } from "./constants";
import { envelopeHash, shellsHash } from "./hash";
import type { Award, TapeData, TapeEnvelope, TapeRound } from "./types";

/** Re-hash a revealed envelope and compare it with the hash that was sealed on-chain. */
export function verifyTapeEnvelope(tableKey: string, round: number, e: TapeEnvelope): boolean {
  const h = envelopeHash(fromHex(tableKey), round, e.window, e.seat, e.cheat, e.shell, fromHex(e.salt));
  return bytesEqual(h, fromHex(e.hash));
}

/** Re-hash a round's revealed shell order and compare it with the committed hash. */
export function verifyTapeShells(tableKey: string, r: TapeRound): boolean {
  return toHex(shellsHash(fromHex(tableKey), r.round, r.shells, fromHex(r.shellSalt))) === r.commit.toLowerCase();
}

export type ReplayedShot = { shot: number; expected: 0 | 1; reported: 0 | 1; ok: boolean; cheated: boolean };

/**
 * Committed shell order + revealed cheats must reproduce every shot that was reported.
 * Cheats always hit the chambered shell, so replaying them shot by shot is exact.
 */
export function replayRound(r: TapeRound): ReplayedShot[] {
  const cur = r.shells.slice();
  const out: ReplayedShot[] = [];
  for (const s of r.shots) {
    const i = s.shellIndex;
    for (const c of s.cheats) {
      if (c.cheat === Cheat.HOT_LOAD) cur[i] = 1;
      else if (c.cheat === Cheat.DUD) cur[i] = 0;
      else if (c.cheat === Cheat.SWAP && i + 1 < cur.length) [cur[i], cur[i + 1]] = [cur[i + 1], cur[i]];
    }
    out.push({ shot: s.shot, expected: cur[i], reported: s.fired, ok: cur[i] === s.fired, cheated: s.cheats.length > 0 });
  }
  return out;
}

/** Every non-NONE envelope must be matched by a cheat the server says it applied (and vice versa). */
export function envelopesMatchShots(r: TapeRound): boolean {
  const fromEnv = r.envelopes
    .filter((e) => e.cheat !== Cheat.NONE)
    .map((e) => `${e.seat}:${e.cheat}:${e.shell}`)
    .sort();
  const fromShots = r.shots
    .flatMap((s) => s.cheats.map((c) => `${c.seat}:${c.cheat}:${s.shellIndex}`))
    .sort();
  // A cheat can sit on a shell that never fired (the game ended first), so shots ⊆ envelopes.
  return fromShots.every((k) => fromEnv.includes(k));
}

function argmax(scores: Map<number, number>, min = 1): number[] {
  let best = -Infinity;
  for (const v of scores.values()) best = Math.max(best, v);
  if (best < min) return [];
  return [...scores.entries()].filter(([, v]) => v === best).map(([k]) => k);
}

export function computeAwards(t: TapeData): Award[] {
  const seats = t.seats.map((s) => s.seat);
  const zero = () => new Map(seats.map((s) => [s, 0]));
  const name = (s: number) => t.seats.find((x) => x.seat === s)?.name ?? `Seat ${s + 1}`;

  const escaped = zero();
  const cheats = zero();
  const falseCalls = zero();
  const damage = zero();
  const hesitation = new Map<number, { total: number; n: number }>();
  let luckiest: { seat: number; p: number } | null = null;

  for (const r of t.rounds) {
    for (const e of r.envelopes) {
      if (e.cheat === Cheat.NONE) continue;
      cheats.set(e.seat, (cheats.get(e.seat) ?? 0) + 1);
      if (!e.caught) escaped.set(e.seat, (escaped.get(e.seat) ?? 0) + 1);
    }
    for (const a of r.accusations) if (a.verdict === "INNOCENT") falseCalls.set(a.accuser, (falseCalls.get(a.accuser) ?? 0) + 1);
    for (const s of r.shots) {
      if (s.fired === 1 && s.target !== s.shooter) damage.set(s.shooter, (damage.get(s.shooter) ?? 0) + 1);
      if (s.fired === 0 && s.target === s.shooter && (!luckiest || s.pLiveAnnounced > luckiest.p)) {
        luckiest = { seat: s.shooter, p: s.pLiveAnnounced };
      }
      const h = hesitation.get(s.shooter) ?? { total: 0, n: 0 };
      h.total += s.hesitationMs;
      h.n += 1;
      hesitation.set(s.shooter, h);
    }
  }

  const liar = argmax(escaped);
  const accuser = argmax(falseCalls);
  const honest = seats.filter((s) => (cheats.get(s) ?? 0) === 0);
  const sharp = argmax(damage);
  const slowAvg = new Map([...hesitation.entries()].map(([s, h]) => [s, h.n ? Math.round(h.total / h.n) : 0]));
  const slow = argmax(slowAvg);
  const buyIns = new Map(t.money.results.map((r) => [r.seat, r.buyIns]));
  const customer = argmax(buyIns, 2);

  const list = (xs: number[]) => xs.map(name).join(" & ");
  return [
    {
      id: "liar",
      emoji: "🤥",
      title: "Biggest Liar",
      seats: liar,
      detail: liar.length ? `${escaped.get(liar[0])} cheat(s) nobody caught` : "Nobody got away with anything. Suspicious.",
    },
    {
      id: "accuser",
      emoji: "🙈",
      title: "Worst Accuser",
      seats: accuser,
      detail: accuser.length ? `${falseCalls.get(accuser[0])} false RIGGED! call(s)` : "Every accusation landed.",
    },
    {
      id: "honest",
      emoji: "😇",
      title: "Suspiciously Honest",
      seats: honest,
      detail: honest.length ? `${list(honest)} never played a card` : "Everyone cheated. Good.",
    },
    {
      id: "sharpshooter",
      emoji: "🎉",
      title: "Confetti King",
      seats: sharp,
      detail: sharp.length ? `knocked ${damage.get(sharp[0])} chip(s) off other players` : "Nobody hit anybody.",
    },
    {
      id: "luckiest",
      emoji: "🍀",
      title: "Luckiest",
      seats: luckiest ? [luckiest.seat] : [],
      detail: luckiest ? `Popped themselves at ${Math.round(luckiest.p * 100)}% LIVE odds and lived` : "Nobody pushed their luck.",
    },
    {
      id: "slowest",
      emoji: "⏱",
      title: "Slowest Pop",
      seats: slow,
      detail: slow.length ? `${(slowAvg.get(slow[0])! / 1000).toFixed(1)}s average before popping` : "—",
    },
    {
      id: "customer",
      emoji: "💸",
      title: "Best Customer",
      seats: customer,
      detail: customer.length ? `bought in ${buyIns.get(customer[0])} times (${dollars(buyIns.get(customer[0])! * MONEY.buyInCents)})` : "Nobody needed a second buy-in.",
    },
  ];
}

export function describeCheat(cheat: number, shell: number): string {
  const info = CHEAT_INFO[cheat as keyof typeof CHEAT_INFO];
  if (!info || cheat === Cheat.NONE) return "nothing";
  return `${info.emoji} ${info.name}${shell !== 0xff ? ` on shell #${shell + 1}` : ""}`;
}

export type TapeLedgerKind = "round" | "shot" | "lie" | "rigged" | "buyin" | "pot";

export type TapeLedgerEvent = {
  id: string;
  kind: TapeLedgerKind;
  round: number;
  window?: number;
  shot?: number;
  seats: number[];
  title: string;
  detail: string;
  search: string;
  caught?: boolean;
  verdict?: "GUILTY" | "INNOCENT";
  committed?: 0 | 1;
  fired?: 0 | 1;
  tx?: string;
};

function shellWord(v: 0 | 1): "LIVE" | "BLANK" {
  return v === 1 ? "LIVE" : "BLANK";
}

function uniqSeats(seats: number[]): number[] {
  return [...new Set(seats)];
}

function haystack(parts: Array<string | number | undefined | null>): string {
  return parts
    .filter((p) => p !== undefined && p !== null && p !== "")
    .join(" ")
    .toLowerCase();
}

/** Flatten every sealed round, shot, lie, accusation, buy-in, and pot into a searchable ledger. */
export function flattenTapeEvents(tape: TapeData, name: (seat: number) => string): TapeLedgerEvent[] {
  const out: TapeLedgerEvent[] = [];
  for (const r of tape.rounds) {
    const rn = r.round + 1;
    out.push({
      id: `r${r.round}`,
      kind: "round",
      round: r.round,
      seats: [r.firstSeat],
      title: `ROUND ${rn} SEALED`,
      detail: `${r.announced.live} LIVE · ${r.announced.blank} BLANK`,
      search: haystack([
        "round",
        rn,
        r.round,
        "sealed",
        name(r.firstSeat),
        r.announced.live,
        "live",
        r.announced.blank,
        "blank",
        r.commit.slice(0, 16),
        r.commit,
        r.commitTx,
        r.revealShellsTx,
      ]),
      tx: r.revealShellsTx ?? r.commitTx,
    });

    for (const s of r.shots) {
      const self = s.shooter === s.target;
      const targetLabel = self ? "THEMSELVES" : name(s.target);
      const cheatNames = s.cheats.map((c) => CHEAT_INFO[c.cheat]?.name ?? String(c.cheat));
      const cheatLine = s.cheats.map((c) => `${name(c.seat)} ${CHEAT_INFO[c.cheat]?.name ?? c.cheat}`).join(", ");
      const committed = shellWord(s.committed);
      const fired = shellWord(s.fired);
      const tampered = s.committed !== s.fired || s.cheats.length > 0;
      out.push({
        id: `r${r.round}-s${s.shot}`,
        kind: "shot",
        round: r.round,
        window: s.window,
        shot: s.shot,
        seats: uniqSeats([s.shooter, s.target, ...s.cheats.map((c) => c.seat)]),
        title: `${name(s.shooter)} → ${targetLabel}`,
        detail: [
          `sealed ${committed} · fired ${fired}`,
          tampered ? "tampered" : null,
          cheatLine || null,
          `${(s.hesitationMs / 1000).toFixed(1)}s hesitation`,
        ]
          .filter(Boolean)
          .join(" · "),
        search: haystack([
          "shot",
          "round",
          rn,
          r.round,
          name(s.shooter),
          targetLabel,
          self ? "themselves" : name(s.target),
          committed,
          fired,
          cheatLine,
          ...cheatNames,
          tampered ? "tampered" : "",
          s.triggerTx,
          s.resolveTx,
        ]),
        committed: s.committed,
        fired: s.fired,
        tx: s.resolveTx ?? s.triggerTx,
      });
    }

    for (const e of r.envelopes) {
      if (e.cheat === Cheat.NONE) continue;
      const info = CHEAT_INFO[e.cheat];
      const cheatName = info?.name ?? String(e.cheat);
      const stamp = e.caught ? "CAUGHT" : "GOT AWAY WITH IT";
      out.push({
        id: `r${r.round}-lie-${e.window}-${e.seat}`,
        kind: "lie",
        round: r.round,
        window: e.window,
        seats: [e.seat],
        title: `${name(e.seat)} played ${cheatName}`,
        detail: `${describeCheat(e.cheat, e.shell)} · ${stamp}`,
        search: haystack([
          "lie",
          "cheat",
          "round",
          rn,
          r.round,
          name(e.seat),
          cheatName,
          info?.key,
          e.caught ? "caught" : "got away",
          stamp,
          e.hash.slice(0, 16),
          e.hash,
          e.sealTx,
          e.revealTx,
          `shell ${e.shell + 1}`,
        ]),
        caught: e.caught,
        tx: e.revealTx ?? e.sealTx,
      });
    }

    for (const [i, a] of r.accusations.entries()) {
      out.push({
        id: `r${r.round}-rigged-${a.window}-${a.accuser}-${i}`,
        kind: "rigged",
        round: r.round,
        window: a.window,
        seats: uniqSeats([a.accuser, a.accused]),
        title: `${name(a.accuser)} called RIGGED on ${name(a.accused)}`,
        detail: `${a.verdict} · ${a.chipsMoved} chip${a.chipsMoved === 1 ? "" : "s"}`,
        search: haystack(["rigged", "accusation", "round", rn, r.round, name(a.accuser), name(a.accused), a.verdict, a.tx]),
        verdict: a.verdict,
        tx: a.tx,
      });
    }

    for (const [i, b] of r.buyIns.entries()) {
      out.push({
        id: `r${r.round}-buyin-${b.seat}-${i}`,
        kind: "buyin",
        round: r.round,
        seats: [b.seat],
        title: `${name(b.seat)} bought back in`,
        detail: "buy-in",
        search: haystack(["buyin", "buy-in", "buy in", "round", rn, r.round, name(b.seat), b.tx]),
        tx: b.tx,
      });
    }

    if (r.pot) {
      const who = r.pot.winners.length ? r.pot.winners.map(name).join(" & ") : "nobody";
      out.push({
        id: `r${r.round}-pot`,
        kind: "pot",
        round: r.round,
        seats: [...r.pot.winners],
        title: r.pot.winners.length ? `POT → ${who}` : "POT EMPTY",
        detail: r.pot.winners.length
          ? `${r.pot.chipsEach} chip${r.pot.chipsEach === 1 ? "" : "s"} each${r.pot.carried ? ` · ${r.pot.carried} carried` : ""}`
          : r.pot.carried
            ? `${r.pot.carried} carried`
            : "empty",
        search: haystack(["pot", "round", rn, r.round, who, r.pot.tx]),
        tx: r.pot.tx,
      });
    }
  }
  return out;
}
