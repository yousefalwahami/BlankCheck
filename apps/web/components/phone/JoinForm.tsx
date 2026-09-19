"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { createPasskey, describePasskeyError, forgetPasskey, loadPasskey, passkeysAvailable, signChallenge, type StoredPasskey } from "@/lib/passkey";
import { resolveServerUrl } from "@/lib/serverUrl";
import { unlockAudio } from "@/lib/sounds";

export const NAME_KEY = "bc.name";

function randomChallenge(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function JoinForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [room, setRoom] = useState((params.get("room") ?? "").toUpperCase().slice(0, 4));
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [passkey, setPasskey] = useState<StoredPasskey | null>(null);
  const [canPasskey, setCanPasskey] = useState(false);

  useEffect(() => {
    resolveServerUrl(); // remember ?server= for this tab
    setCanPasskey(passkeysAvailable());
    setPasskey(loadPasskey());
    try {
      setName(localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      /* ignore */
    }
  }, []);

  const valid = /^[A-Z]{4}$/.test(room) && name.trim().length > 0;

  const go = () => {
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* ignore */
    }
    router.push(`/play/${room}`);
  };

  // The WebAuthn call must be the first thing in the tap handler (iOS gesture rules).
  const sitDown = async () => {
    if (!valid || busy) return;
    unlockAudio();
    setError(null);
    if (!canPasskey) return go();
    setBusy(true);
    try {
      if (passkey) {
        await signChallenge(passkey.credentialId, randomChallenge()); // Face ID unlocks your wallet
      } else {
        setPasskey(await createPasskey(name.trim())); // Face ID creates your wallet
      }
      go();
    } catch (e) {
      setError(describePasskeyError(e));
      setBusy(false);
    }
  };

  return (
    <main className="room-bg crt flex min-h-dvh flex-col items-center justify-center px-5 py-10">
      <div className="grain" />
      <div className="w-full max-w-sm">
        <h1 className="text-center font-display text-6xl leading-none">
          BLANK <span className="text-blood">CHECK</span>
        </h1>
        <p className="mt-2 text-center font-type text-bone/70">Take a seat. Everyone cheats.</p>

        <label className="mt-10 block font-crt text-lg tracking-widest text-ash" htmlFor="room">
          ROOM CODE
        </label>
        <input
          id="room"
          value={room}
          onChange={(e) => setRoom(e.target.value.toUpperCase().replace(/[^A-Z]/g, "").slice(0, 4))}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          placeholder="ABCD"
          className="mt-1 w-full rounded-xl border-2 border-bone/20 bg-soot px-4 py-3 text-center font-display text-5xl tracking-[0.3em] text-brass placeholder:text-bone/15"
        />

        <label className="mt-6 block font-crt text-lg tracking-widest text-ash" htmlFor="name">
          YOUR NAME
        </label>
        <input
          id="name"
          value={name}
          onChange={(e) => setName(e.target.value.slice(0, 16))}
          autoComplete="nickname"
          placeholder="Maya"
          className="mt-1 w-full rounded-xl border-2 border-bone/20 bg-soot px-4 py-3 font-display text-3xl tracking-wide placeholder:text-bone/15"
          onKeyDown={(e) => e.key === "Enter" && sitDown()}
        />

        <button
          onClick={sitDown}
          disabled={!valid || busy}
          className="mt-8 w-full rounded-2xl bg-blood py-5 font-display text-4xl tracking-widest disabled:opacity-40"
        >
          {busy ? "LOOK AT YOUR PHONE…" : canPasskey ? "🔐 SIT DOWN" : "SIT DOWN"}
        </button>

        <p className="mt-4 text-center font-crt text-lg leading-tight text-ash">
          {canPasskey
            ? passkey
              ? "Face ID unlocks your wallet. Same face, same wallet."
              : "Face ID creates your wallet. No app, no seed phrase."
            : "Face ID needs HTTPS. On this connection you'll tap to fire instead."}
        </p>
        {error && (
          <div className="mt-4 rounded-xl border border-blood bg-blood/10 p-3 text-center font-crt text-lg text-blood">
            {error}
            {passkey && (
              <button
                className="mt-2 block w-full underline"
                onClick={() => {
                  forgetPasskey();
                  setPasskey(null);
                  setError(null);
                }}
              >
                Make a new passkey instead
              </button>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
