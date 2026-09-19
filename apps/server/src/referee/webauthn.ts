import { fromHex } from "@blankcheck/shared";
import type { PasskeyAssertion } from "@blankcheck/shared";

/*
 * Verifies a WebAuthn (passkey) assertion against a P-256 public key.
 * The signed message is authenticatorData || SHA-256(clientDataJSON), and clientDataJSON.challenge
 * must equal the challenge we issued. Used by MockReferee so "Face ID" is really checked offline too.
 */

const b64 = (s: string) => new Uint8Array(Buffer.from(s, "base64"));
const pad32 = (hex: string) => fromHex(hex.padStart(64, "0"));

export async function verifyPasskeyAssertion(publicKeyHex: string, challengeB64Url: string, a: PasskeyAssertion): Promise<boolean> {
  try {
    const clientData = b64(a.clientDataJSON);
    const parsed = JSON.parse(new TextDecoder().decode(clientData)) as { type?: string; challenge?: string };
    if (parsed.type !== "webauthn.get" || parsed.challenge !== challengeB64Url) return false;

    const authData = b64(a.authenticatorData);
    const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientData));
    const message = new Uint8Array(authData.length + 32);
    message.set(authData, 0);
    message.set(clientHash, authData.length);

    const raw = new Uint8Array(65);
    raw[0] = 0x04;
    raw.set(fromHex(publicKeyHex), 1);
    const key = await crypto.subtle.importKey("raw", raw, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const sig = new Uint8Array(64);
    sig.set(pad32(a.signatureR), 0);
    sig.set(pad32(a.signatureS), 32);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, sig, message);
  } catch {
    return false;
  }
}
