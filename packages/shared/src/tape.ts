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
      emoji: "🔫",
      title: "Sharpshooter",
      seats: sharp,
      detail: sharp.length ? `knocked ${damage.get(sharp[0])} chip(s) off other players` : "Nobody hit anybody.",
    },
    {
      id: "luckiest",
      emoji: "🍀",
      title: "Luckiest",
      seats: luckiest ? [luckiest.seat] : [],
      detail: luckiest ? `Shot themselves at ${Math.round(luckiest.p * 100)}% LIVE odds and lived` : "Nobody pushed their luck.",
    },
    {
      id: "slowest",
      emoji: "⏱",
      title: "Slowest Trigger",
      seats: slow,
      detail: slow.length ? `${(slowAvg.get(slow[0])! / 1000).toFixed(1)}s average before pulling` : "—",
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
