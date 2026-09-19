import { noul } from "@typesafe-ai/sdk";
import type { PitBossView } from "../engine/views";
import { askJev } from "./jev";
import { heuristicSuspicion } from "./suspicion";

/**
 * The Pit Boss (spec §8.5): one Jev call per resolved shot, one `noul` per seat.
 * Its input is PitBossView, a type with no secret fields. If it ever saw secrets it would be an oracle.
 */
export async function readPitBoss(v: PitBossView): Promise<Record<number, number>> {
  const heur = heuristicSuspicion(v);
  if (v.seats.length < 2) return heur;
  const answers = await askJev(v, Object.fromEntries(v.seats.map((s) => [`seat_${s.seat}`, noul(`${s.name} has played a cheat card this round`)])));
  if (!answers) return heur;
  const out: Record<number, number> = {};
  for (const s of v.seats) {
    const j = (answers as Record<string, { noul?: number }>)[`seat_${s.seat}`]?.noul;
    out[s.seat] = s.busted ? 0.02 : j === undefined ? heur[s.seat] : 0.7 * j + 0.3 * heur[s.seat];
  }
  return out;
}
