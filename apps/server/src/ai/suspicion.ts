import type { PitBossView } from "../engine/views";

type SeatBehavior = PitBossView["seats"][number];

/**
 * Code-only suspicion score from PUBLIC behavior. Used when Jev is unavailable, and blended
 * with Jev's answers otherwise. Never sees secrets: its input type has none.
 */
export function heuristicSuspicion(v: { countIsOff: boolean; seats: SeatBehavior[] }): Record<number, number> {
  const out: Record<number, number> = {};
  for (const s of v.seats) {
    let p = 0.12;
    if (v.countIsOff) p += 0.18;
    for (const shot of s.selfShots) {
      if (shot.pLive >= 0.5) p += 0.12; // confident self-shots look like someone who knows
      if (shot.pLive >= 0.5 && !shot.live) p += 0.14;
      if (shot.pLive >= 0.5 && shot.hesitationMs < 1500) p += 0.06;
    }
    if (s.busted) p = 0.02;
    out[s.seat] = Math.max(0.02, Math.min(0.95, p));
  }
  return out;
}
