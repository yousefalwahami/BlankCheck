import { config } from "../config";
import { MockReferee } from "./MockReferee";
import type { Referee } from "./Referee";

export type RefereeFactory = () => Referee;

/**
 * Pick the referee at boot. REFEREE_MODE=thru checks the house key and RPC first and falls back to
 * the mock (with a loud warning) if the chain isn't reachable: the game must never be blocked on it.
 */
export async function initReferee(): Promise<RefereeFactory> {
  if (config.refereeMode !== "thru") return () => new MockReferee();
  try {
    const { ThruReferee } = await import("./ThruReferee");
    const who = await ThruReferee.check();
    console.log(`   thru: house key ${who}, referee ${config.refereeProgramAddress}`);
    return () => new ThruReferee();
  } catch (e) {
    console.warn(`⚠️  REFEREE_MODE=thru but the chain isn't usable (${(e as Error).message}). Falling back to MockReferee.`);
    return () => new MockReferee();
  }
}

/** Synchronous default (tests and the mock). */
export function createReferee(): Referee {
  return new MockReferee();
}

export type { Referee };
