"use client";

const KEY = "bc.server";

function safeGet(k: string): string | null {
  try {
    return sessionStorage.getItem(k);
  } catch {
    return null;
  }
}

function safeSet(k: string, v: string) {
  try {
    sessionStorage.setItem(k, v);
  } catch {
    /* private mode */
  }
}

/**
 * Game server URL: ?server= (kept for this tab) → NEXT_PUBLIC_GAME_SERVER_URL → same host, port 4000.
 * The TV puts its server into the QR link, so switching between a laptop tunnel and a cloud host
 * never needs a redeploy (spec §5.3).
 */
export function resolveServerUrl(): string {
  if (typeof window === "undefined") return process.env.NEXT_PUBLIC_GAME_SERVER_URL ?? "";
  const q = new URLSearchParams(window.location.search).get("server");
  if (q) {
    safeSet(KEY, q);
    return q.replace(/\/$/, "");
  }
  const stored = safeGet(KEY);
  if (stored) return stored;
  const env = process.env.NEXT_PUBLIC_GAME_SERVER_URL;
  if (env) return env.replace(/\/$/, "");
  return `${window.location.protocol}//${window.location.hostname}:4000`;
}

/** True when the server URL was chosen explicitly (so it should ride along in join links). */
export function serverIsExplicit(): boolean {
  if (typeof window === "undefined") return false;
  return !!new URLSearchParams(window.location.search).get("server") || !!safeGet(KEY);
}
