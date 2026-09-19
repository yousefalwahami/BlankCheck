import { TAUNTS, type TauntId } from "@blankcheck/shared";
import type { Rng } from "../engine/rng";

export const TAUNT_CHOICES = Object.fromEntries(Object.entries(TAUNTS).map(([k, v]) => [k, `"${v}"`])) as Record<TauntId, string>;

export type TauntMoment = "selfShotSurvived" | "hitSomeone" | "countOff" | "accusing" | "wasInnocent" | "gotCaught" | "idle";

const BY_MOMENT: Record<TauntMoment, TauntId[]> = {
  selfShotSurvived: ["odds", "lucky", "quiet"],
  hitSomeone: ["sweat", "deal", "chain"],
  countOff: ["count", "tape", "sweat"],
  accusing: ["face", "tape", "chain"],
  wasInnocent: ["honest", "chain"],
  gotCaught: ["honest", "deal"],
  idle: ["quiet", "sweat", "deal"],
};

export function pickTaunt(moment: TauntMoment, rng: Rng): TauntId {
  return rng.pick(BY_MOMENT[moment]);
}
