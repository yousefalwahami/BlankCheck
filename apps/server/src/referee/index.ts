import { config } from "../config";
import { MockReferee } from "./MockReferee";
import type { Referee } from "./Referee";

export function createReferee(): Referee {
  if (config.refereeMode === "thru") {
    console.warn("[referee] REFEREE_MODE=thru is not wired up yet; falling back to MockReferee");
  }
  return new MockReferee();
}

export type { Referee };
