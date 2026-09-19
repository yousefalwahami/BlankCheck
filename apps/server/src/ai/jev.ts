import { TypeSafeClient, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { config } from "../config";

/*
 * Thin wrapper around Jev (TypeSafe). Server-only: the API key never reaches a browser.
 * Every call has a short timeout and returns null on any failure so bots and the Pit Boss
 * fall back to code-only heuristics behind the same interface (spec §12).
 */

let client: TypeSafeClient | null = null;
let lastErrorLog = 0;

export function jevEnabled(): boolean {
  return !!config.typesafeApiKey;
}

function getClient(): TypeSafeClient | null {
  if (!config.typesafeApiKey) return null;
  client ??= new TypeSafeClient({
    apiKey: config.typesafeApiKey,
    defaultModel: config.jevModel || undefined,
    timeout: 2500,
    retry: { maxRetries: 0 },
    logLevel: "off",
  });
  return client;
}

export type JevStats = { calls: number; failures: number; lastMs: number };
export const jevStats: JevStats = { calls: 0, failures: 0, lastMs: 0 };

export async function askJev<const Q extends Questions>(state: unknown, questions: Q): Promise<SystemOneResult<Q>["answers"] | null> {
  const c = getClient();
  if (!c) return null;
  const t0 = performance.now();
  jevStats.calls++;
  try {
    const res = await c.systemOne({ state: JSON.parse(JSON.stringify(state)), questions });
    jevStats.lastMs = Math.round(performance.now() - t0);
    return res.answers;
  } catch (e) {
    jevStats.failures++;
    if (Date.now() - lastErrorLog > 30_000) {
      lastErrorLog = Date.now();
      console.warn(`[jev] call failed, using heuristics: ${(e as Error).message}`);
    }
    return null;
  }
}
