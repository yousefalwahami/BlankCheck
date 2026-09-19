import { experimental_evaluate as evaluate } from "ai";
import { TypeSafeClient, type Questions, type SystemOneResult } from "@typesafe-ai/sdk";
import { config } from "../config";

/*
 * Thin wrapper around Jev. Server-only: the API key never reaches a browser.
 * Prefers Vercel AI Gateway (`AI_GATEWAY_API_KEY`); otherwise the TypeSafe API.
 * Every call has a short timeout and returns null on any failure so bots and the Pit Boss
 * fall back to code-only heuristics behind the same interface (spec §12).
 */

let client: TypeSafeClient | null = null;
let lastErrorLog = 0;

export function jevEnabled(): boolean {
  return !!config.aiGatewayApiKey || !!config.typesafeApiKey;
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

function toGatewayQuestions(questions: Questions) {
  const out: Record<string, { type: "boolean" | "choice" | "score"; instructions?: unknown; criteria?: unknown }> = {};
  for (const [name, q] of Object.entries(questions)) {
    if (q.type === "noul") {
      out[name] = { type: "boolean", instructions: q.instructions, criteria: q.criteria ?? undefined };
    } else {
      out[name] = { type: q.type, instructions: q.instructions, criteria: q.criteria };
    }
  }
  return out;
}

function fromGatewayAnswers(answers: Record<string, { type?: string; probability?: number; choice?: string }>) {
  const out: Record<string, { type: string; noul?: number; choice?: string }> = {};
  for (const [name, a] of Object.entries(answers)) {
    if (a.type === "boolean" && typeof a.probability === "number") {
      out[name] = { type: "noul", noul: a.probability };
    } else {
      out[name] = { type: a.type ?? "choice", choice: a.choice };
    }
  }
  return out;
}

export async function askJev<const Q extends Questions>(state: unknown, questions: Q): Promise<SystemOneResult<Q>["answers"] | null> {
  const t0 = performance.now();
  jevStats.calls++;
  try {
    const payload = JSON.parse(JSON.stringify(state));
    if (config.aiGatewayApiKey) {
      process.env.AI_GATEWAY_API_KEY ??= config.aiGatewayApiKey;
      const res = await evaluate({
        model: config.jevModel || "typesafe-ai/jev",
        state: payload,
        questions: toGatewayQuestions(questions) as never,
        abortSignal: AbortSignal.timeout(2500),
      });
      jevStats.lastMs = Math.round(performance.now() - t0);
      return fromGatewayAnswers(res.answers as Record<string, { type?: string; probability?: number; choice?: string }>) as SystemOneResult<Q>["answers"];
    }
    const c = getClient();
    if (!c) return null;
    const res = await c.systemOne({ state: payload, questions });
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
