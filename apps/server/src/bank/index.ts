import { config } from "../config";
import { hostKey } from "../thru/chain";
import type { Bank } from "./Bank";
import { MockBank } from "./MockBank";

/**
 * One bank per server, so a player's wallet survives across games. BANK_MODE=thru (the default when
 * REFEREE_MODE=thru) creates the BCUSD mint and cashier on first boot, and falls back to the in-memory
 * bank with a warning if the chain isn't usable.
 */
export async function initBank(): Promise<Bank> {
  if (config.bankMode !== "thru") return new MockBank();
  try {
    await hostKey();
    const { setupBank, ThruBank } = await import("./ThruBank");
    const { mint, cashier } = await setupBank((s) => console.log(s));
    console.log(`   bank: ${await ThruBank.check()} · cashier ${cashier}`);
    void mint;
    return new ThruBank();
  } catch (e) {
    console.warn(`⚠️  BANK_MODE=thru but the bank isn't usable (${(e as Error).message}). Falling back to the in-memory bank.`);
    return new MockBank();
  }
}

export type { Bank };
