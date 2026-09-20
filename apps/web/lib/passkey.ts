"use client";

import type { PasskeyAssertion } from "@blankcheck/shared";
import { isWebAuthnSupported, registerPasskey, signWithPasskey } from "@thru/passkey/web";

/*
 * Passkey = the player's wallet (spec §7.3). The phone creates a P-256 passkey once per domain,
 * then signs Thru passkey-manager challenges with it. Passkeys only work on HTTPS with a real
 * domain (or localhost), so on plain-HTTP LAN dev we fall back to a tap.
 */

export type StoredPasskey = { credentialId: string; publicKey: string; name: string };

const key = () => `bc.passkey:${location.hostname}`;

export function passkeysAvailable(): boolean {
  try {
    return typeof window !== "undefined" && window.isSecureContext && isWebAuthnSupported();
  } catch {
    return false;
  }
}

export function loadPasskey(): StoredPasskey | null {
  try {
    const raw = localStorage.getItem(key());
    return raw ? (JSON.parse(raw) as StoredPasskey) : null;
  } catch {
    return null;
  }
}

function savePasskey(p: StoredPasskey) {
  try {
    localStorage.setItem(key(), JSON.stringify(p));
  } catch {
    /* private mode: the passkey still works for this session */
  }
}

export function forgetPasskey() {
  try {
    localStorage.removeItem(key());
  } catch {
    /* ignore */
  }
}

/** First sit-down: a passkey creates the credential (and, server-side, the on-chain wallet). */
export async function createPasskey(name: string): Promise<StoredPasskey> {
  const userId = `bc-${crypto.randomUUID()}`;
  const r = await registerPasskey(`${name} · Gambit Rodeo`, userId, location.hostname);
  const stored = { credentialId: r.credentialId, publicKey: (r.publicKeyX + r.publicKeyY).toLowerCase(), name };
  savePasskey(stored);
  return stored;
}

const b64urlToBytes = (s: string) => {
  const b = atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "="));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const bytesToB64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const bytesToHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/**
 * Sign a server challenge with a passkey. Call this DIRECTLY from the tap handler, with no awaits
 * before it: iOS Safari rejects WebAuthn prompts that aren't tied to a user gesture.
 */
export async function signChallenge(credentialId: string, challengeB64Url: string): Promise<PasskeyAssertion> {
  const r = await signWithPasskey(credentialId, b64urlToBytes(challengeB64Url), location.hostname);
  return {
    signatureR: bytesToHex(r.signatureR),
    signatureS: bytesToHex(r.signatureS),
    authenticatorData: bytesToB64(r.authenticatorData),
    clientDataJSON: bytesToB64(r.clientDataJSON),
  };
}

export function describePasskeyError(e: unknown): string {
  const name = e instanceof Error ? e.name : "";
  if (name === "NotAllowedError") return "Passkey was cancelled (or timed out).";
  if (name === "SecurityError") return "Passkeys need HTTPS on a real domain.";
  if (name === "InvalidStateError") return "This passkey already exists on this device.";
  return e instanceof Error ? e.message : "Passkey failed.";
}
