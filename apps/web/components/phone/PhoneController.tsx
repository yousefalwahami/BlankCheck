"use client";

import { C2S, MONEY, S2C, dollars, type Fx, type PrivateView, type PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { describePasskeyError, loadPasskey, signChallenge } from "@/lib/passkey";
import { emitAck, getSocket, useConnected, useSocketEvent } from "@/lib/socket";
import { sfx, unlockAudio } from "@/lib/sounds";
import { Avatar, Chips, Profit, seatColor } from "../ui/bits";
import { CheatCard } from "./CheatCard";
import { NAME_KEY } from "./JoinForm";

function playerId(room: string): string {
  const k = `bc.player:${room}`;
  try {
    const existing = sessionStorage.getItem(k);
    if (existing) return existing;
    const id = `p-${crypto.randomUUID()}`;
    sessionStorage.setItem(k, id);
    return id;
  } catch {
    return `p-${crypto.randomUUID()}`;
  }
}

/** Phases where the gun is out, so the cheat card and the RIGGED! button matter. */
const ROUND_PHASES = ["ROUND_START", "AWAIT_AIM", "AWAIT_TRIGGER", "RESOLVING", "RIGGED", "LAST_CALL"];

export function PhoneController({ room }: { room: string }) {
  const router = useRouter();
  const connected = useConnected();
  const [state, setState] = useState<PublicState | null>(null);
  const [priv, setPriv] = useState<PrivateView | null>(null);
  const privRef = useRef<PrivateView | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  const [firing, setFiring] = useState(false);
  const [buying, setBuying] = useState<"idle" | "preparing" | "paying">("idle");
  const [riggedOpen, setRiggedOpen] = useState(false);
  const [peekShow, setPeekShow] = useState<{ live: boolean; shell: number; at: number } | null>(null);
  const [hit, setHit] = useState(0);
  const peekKey = useRef("");

  const say = useCallback((text: string) => setToast({ text, at: Date.now() }), []);

  // Join (and re-join after any reconnect), then bind the passkey wallet.
  useEffect(() => {
    let name = "";
    try {
      name = localStorage.getItem(NAME_KEY) ?? "";
    } catch {
      /* ignore */
    }
    if (!name) {
      router.replace(`/join?room=${room}`);
      return;
    }
    const id = playerId(room);
    const s = getSocket();
    const join = async () => {
      // Tell the server a Face ID wallet is coming, so it doesn't open a house wallet first.
      const pk = loadPasskey();
      const r = await emitAck<{ seat: number }>(C2S.roomJoin, { room, name, playerId: id, passkey: !!pk });
      if (!r.ok) return setJoinError(r.error);
      setJoinError(null);
      if (pk) {
        const b = await emitAck<{ wallet: string }>(C2S.walletBind, { credentialId: pk.credentialId, publicKey: pk.publicKey });
        if (!b.ok) say(b.error);
      }
    };
    s.on("connect", join);
    if (s.connected) void join();
    return () => {
      s.off("connect", join);
    };
  }, [room, router, say]);

  useSocketEvent<PublicState>(S2C.state, useCallback((p) => setState(p), []));
  useSocketEvent<PrivateView>(
    S2C.private,
    useCallback((p) => {
      privRef.current = p; // buyIn() reads the challenge the server pushes just before its ack
      setPriv(p);
    }, []),
  );
  useSocketEvent<{ text: string }>(S2C.toast, useCallback((t) => say(t.text), [say]));

  const me = priv ? state?.seats[priv.seat] : undefined;
  useSocketEvent<Fx>(
    S2C.fx,
    useCallback(
      (f: Fx) => {
        if (!priv) return;
        if (f.type === "shot" && f.target === priv.seat && f.live) {
          navigator.vibrate?.([220, 80, 220]);
          setHit(Date.now());
          sfx.bang();
        }
        if (f.type === "verdict" && f.from === priv.seat) navigator.vibrate?.([120, 60, 120]);
        if (f.type === "verdict" && f.to === priv.seat) say(`+${f.chips} chip${f.chips === 1 ? "" : "s"} from ${f.to === f.accuser ? "the cheater" : "your accuser"}`);
        if (f.type === "potAward" && f.winners.includes(priv.seat)) {
          navigator.vibrate?.(80);
          say(`🏦 You take the pot: +${f.chipsEach} chip${f.chipsEach === 1 ? "" : "s"}`);
        }
        if (f.type === "buyIn" && f.seat === priv.seat) say(`💵 ${dollars(f.cents)} paid. +${f.chips} chips.`);
      },
      [priv, say],
    ),
  );

  // PEEK: show it for 2 seconds, once.
  useEffect(() => {
    if (!priv?.peek || !state) return;
    const k = `${state.round}:${priv.peek.shell}`;
    if (peekKey.current === k) return;
    peekKey.current = k;
    setPeekShow({ live: priv.peek.live, shell: priv.peek.shell, at: Date.now() });
    navigator.vibrate?.(40);
    const t = setTimeout(() => setPeekShow(null), 2000);
    return () => clearTimeout(t);
  }, [priv?.peek, state]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3800);
    return () => clearTimeout(t);
  }, [toast]);

  const myTurn = !!state && !!priv && state.currentSeat === priv.seat && (state.phase === "AWAIT_AIM" || state.phase === "AWAIT_TRIGGER");

  // Heartbeat when you're down to your last chip and holding the gun.
  useEffect(() => {
    if (!myTurn || (me?.chips ?? 0) !== 1) return;
    const t = setInterval(() => sfx.heartbeat(), 1100);
    return () => clearInterval(t);
  }, [myTurn, me?.chips]);

  // The table moves on while a sheet is open (a verdict lands, the round ends): never strand a tap.
  useEffect(() => {
    if (priv && priv.challenge?.kind !== "accuse" && !priv.canAccuse) setRiggedOpen(false);
  }, [priv]);
  useEffect(() => {
    if (!priv?.challenge) setFiring(false);
  }, [priv?.challenge]);

  // Tick the buy-back countdown, which nothing else re-renders.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (state?.phase !== "BUY_INS") return;
    const t = setInterval(() => setTick((x) => x + 1), 500);
    return () => clearInterval(t);
  }, [state?.phase]);

  const prevTurn = useRef(false);
  useEffect(() => {
    if (myTurn && !prevTurn.current) navigator.vibrate?.(60);
    prevTurn.current = myTurn;
  }, [myTurn]);

  const aim = async (target: number) => {
    unlockAudio();
    const r = await emitAck(C2S.turnAim, { target });
    if (!r.ok) say(r.error);
  };

  /** Must call WebAuthn before any await: iOS only allows the prompt inside the tap. */
  const signIfNeeded = (requirePasskey: boolean, challenge: string) => {
    const pk = loadPasskey();
    if (requirePasskey && !pk) throw new Error("This phone lost its passkey. Rejoin to make a new one.");
    if (pk && (requirePasskey || state?.config.faceIdOnTrigger)) return signChallenge(pk.credentialId, challenge);
    return Promise.resolve(undefined);
  };

  const fire = async () => {
    const ch = priv?.challenge;
    if (!ch || ch.kind !== "trigger" || firing) return;
    setFiring(true);
    try {
      const assertion = await signIfNeeded(ch.requirePasskey, ch.challenge);
      sfx.rack();
      const r = await emitAck(C2S.turnSigned, { challengeId: ch.id, assertion });
      if (!r.ok) say(r.error);
    } catch (e) {
      say(describePasskeyError(e));
    } finally {
      setFiring(false);
    }
  };

  const accuse = async (accused: number) => {
    const r = await emitAck(C2S.riggedStart, { accused });
    if (!r.ok) say(r.error);
  };

  const swear = async () => {
    const ch = priv?.challenge;
    if (!ch || ch.kind !== "accuse" || firing) return;
    setFiring(true);
    try {
      const assertion = await signIfNeeded(ch.requirePasskey, ch.challenge);
      const r = await emitAck(C2S.riggedSigned, { challengeId: ch.id, assertion });
      if (!r.ok) say(r.error);
      setRiggedOpen(false);
    } catch (e) {
      say(describePasskeyError(e));
    } finally {
      setFiring(false);
    }
  };

  const cancelRigged = () => {
    setRiggedOpen(false);
    void emitAck(C2S.riggedCancel);
  };

  /**
   * Buying in takes two taps on a Face ID wallet: the first asks the bank to prepare the $12
   * transfer, the second signs it (WebAuthn only runs inside a tap). House-held wallets pay on
   * the first tap.
   */
  const buyIn = async () => {
    unlockAudio();
    if (buying !== "idle") return;
    const ch = priv?.challenge?.kind === "buyin" ? priv.challenge : null;
    if (ch?.requirePasskey) {
      setBuying("paying");
      try {
        const assertion = await signChallenge(loadPasskey()!.credentialId, ch.challenge);
        const r = await emitAck(C2S.buyInSigned, { challengeId: ch.id, assertion }, 60_000);
        if (!r.ok) say(r.error);
      } catch (e) {
        say(describePasskeyError(e));
      } finally {
        setBuying("idle");
      }
      return;
    }
    setBuying("preparing");
    try {
      const r = await emitAck(C2S.buyInStart, {}, 30_000);
      if (!r.ok) return say(r.error);
      // The server pushes our private view (with the challenge) before it acks.
      const fresh = privRef.current?.challenge;
      if (fresh?.kind === "buyin" && !fresh.requirePasskey) {
        setBuying("paying");
        const p = await emitAck(C2S.buyInSigned, { challengeId: fresh.id }, 60_000);
        if (!p.ok) say(p.error);
      }
    } finally {
      setBuying("idle");
    }
  };

  if (joinError) {
    return (
      <main className="room-bg flex min-h-dvh flex-col items-center justify-center gap-6 px-6 text-center">
        <p className="font-display text-4xl">Can't sit down</p>
        <p className="font-crt text-xl text-blood">{joinError}</p>
        <Link href={`/join?room=${room}`} className="rounded-xl bg-blood px-6 py-3 font-display text-2xl">
          TRY AGAIN
        </Link>
      </main>
    );
  }

  if (!state || !priv || !me) {
    return (
      <main className="room-bg flex min-h-dvh items-center justify-center font-crt text-2xl text-ash">
        {connected ? `Sitting down at ${room}…` : "Connecting…"}
      </main>
    );
  }

  const funded = me.chips > 0;
  const inGame = !["LOBBY", "OVER", "TAPE"].includes(state.phase);
  const inRound = ROUND_PHASES.includes(state.phase);
  const broke = inGame && !funded;
  const cur = state.seats[state.currentSeat];
  const target = state.aimingAt !== null ? state.seats[state.aimingAt] : null;
  const playing = state.seats.filter((s) => s.chips > 0);
  const accusable = playing.filter((s) => s.seat !== me.seat && !state.busted.includes(s.seat));
  const accuseCh = priv.challenge?.kind === "accuse" ? priv.challenge : null;
  const trigCh = priv.challenge?.kind === "trigger" ? priv.challenge : null;
  const buyCh = priv.challenge?.kind === "buyin" ? priv.challenge : null;
  const result = state.results?.find((r) => r.seat === me.seat);
  const buyInsLeft = state.phase === "BUY_INS" && state.buyInsEndAt ? Math.max(0, Math.ceil((state.buyInsEndAt - Date.now()) / 1000)) : null;

  const buyInPanel = priv.canBuyIn && (
    <div className="w-full rounded-3xl border-2 border-crt/50 bg-black/60 p-4">
      <p className="font-crt text-lg tracking-widest text-ash">YOUR WALLET · {me.bankrollCents !== null ? dollars(me.bankrollCents) : "…"}</p>
      <p className="mt-1 font-display text-3xl">
        {dollars(MONEY.buyInCents)} → <span className="text-brass">{MONEY.buyInChips} chips</span>
      </p>
      <button
        onClick={buyIn}
        disabled={buying !== "idle"}
        className="mt-3 w-full rounded-2xl bg-crt py-5 font-display text-3xl tracking-wide text-ink active:scale-[0.98] disabled:opacity-60"
      >
        {buying === "preparing"
          ? "ASKING THE BANK…"
          : buying === "paying"
            ? "PAYING…"
            : buyCh?.requirePasskey
              ? `🔐 PAY ${dollars(MONEY.buyInCents)} WITH FACE ID`
              : `BUY IN · ${dollars(MONEY.buyInCents)}`}
      </button>
      <p className="mt-2 font-crt text-base leading-tight text-ash">
        {me.walletReady
          ? `Fake dollars (${MONEY.ticker}) move from your Face ID wallet to the cashier.`
          : `The house holds your ${MONEY.ticker} for you (no Face ID on this phone).`}
      </p>
    </div>
  );

  return (
    <main className="room-bg no-select flex min-h-dvh flex-col" style={{ ["--me" as string]: seatColor(me.seat) }}>
      <header className="flex items-center gap-3 border-b border-bone/10 px-4 py-3">
        <Avatar seat={me} size={48} broke={broke} ghost={me.cleanedOut} />
        <div className="min-w-0 flex-1">
          <p className="truncate font-display text-2xl leading-none tracking-wide">{me.name}</p>
          <p className="font-crt text-base text-ash">
            {me.walletReady ? "🔐 Face ID wallet" : "🎩 house wallet"} · {me.bankrollCents !== null ? dollars(me.bankrollCents) : "…"} · {room}
            {connected ? "" : " · reconnecting…"}
          </p>
        </div>
        {funded && <Chips n={me.chips} size={28} color={seatColor(me.seat)} />}
      </header>

      <AnimatePresence>
        {toast && (
          <motion.div
            key={toast.at}
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
            className="mx-4 mt-3 rounded-xl border border-brass/40 bg-black/80 px-4 py-2 text-center font-crt text-lg text-brass"
          >
            {toast.text}
          </motion.div>
        )}
      </AnimatePresence>

      <section className={`flex flex-1 flex-col items-center justify-center gap-5 px-5 py-4 text-center ${Date.now() - hit < 600 ? "animate-shake" : ""}`}>
        {state.phase === "LOBBY" && (
          <>
            {funded ? (
              <>
                <p className="font-display text-4xl">You're in.</p>
                <p className="font-type text-lg text-bone/70">
                  {MONEY.buyInChips} chips on the table. {state.config.rounds} rounds, then everyone cashes out at {dollars(MONEY.chipCents)} a chip. Most profit wins.
                </p>
              </>
            ) : (
              <>
                <p className="font-display text-4xl">Buy in to play.</p>
                <p className="font-type text-lg text-bone/70">Every live shell that hits you knocks a chip into the pot. Run out and you can buy back in.</p>
              </>
            )}
            {buyInPanel}
            <ul className="mt-2 flex flex-wrap justify-center gap-3">
              {state.seats.map((s) => (
                <li key={s.seat} className="flex flex-col items-center gap-1">
                  <Avatar seat={s} size={44} broke={s.chips === 0} />
                  <span className="font-crt text-base">{s.name}</span>
                  <span className={`font-crt text-sm ${s.chips > 0 ? "text-crt" : "text-brass"}`}>{s.chips > 0 ? "✓ in" : "buying in…"}</span>
                </li>
              ))}
            </ul>
          </>
        )}

        {state.phase === "ROUND_START" && funded && (
          <>
            <p className="font-crt text-xl tracking-[0.3em] text-ash">
              ROUND {state.round + 1} OF {state.config.rounds}
            </p>
            <p className="font-display text-5xl">
              <span className="text-blood">{state.announced.live} LIVE</span> · <span className="text-steel">{state.announced.blank} BLANK</span>
            </p>
            <p className="font-type text-lg text-bone/70">You've been dealt a card. Hold it to peek.</p>
          </>
        )}

        {broke && (
          <>
            {me.cleanedOut ? (
              <>
                <p className="text-7xl">👻</p>
                <p className="font-display text-4xl">Cleaned out.</p>
                <p className="font-type text-lg text-bone/70">Not enough in your wallet for another buy-in. Haunt the table.</p>
              </>
            ) : (
              <>
                <p className="text-6xl">💸</p>
                <p className="font-display text-4xl">You're broke.</p>
                <p className="font-type text-lg text-bone/70">
                  {buyInsLeft !== null ? `Buy back in within ${buyInsLeft}s to keep playing.` : "Buy back in any time to rejoin the next shot."}
                </p>
              </>
            )}
            {buyInPanel}
            <button
              onClick={() => {
                unlockAudio();
                void emitAck(C2S.boo);
              }}
              className="rounded-2xl border-2 border-bone/30 px-10 py-3 font-display text-2xl"
            >
              BOO
            </button>
          </>
        )}

        {funded && myTurn && state.phase === "AWAIT_AIM" && (
          <>
            <p className="font-display text-5xl text-blood">YOUR TURN</p>
            <p className="font-crt text-xl text-ash">Who gets the chambered shell?</p>
            <div className="grid w-full grid-cols-2 gap-3">
              <button onClick={() => aim(me.seat)} className="col-span-2 rounded-2xl border-2 border-brass bg-brass/10 py-4 font-display text-3xl tracking-wide">
                🫵 YOU <span className="block font-crt text-base text-ash">blank = shoot again</span>
              </button>
              {playing
                .filter((s) => s.seat !== me.seat)
                .map((s) => (
                  <button key={s.seat} onClick={() => aim(s.seat)} aria-label={`Shoot ${s.name}`} className="flex items-center gap-2 rounded-2xl border-2 border-bone/15 bg-soot p-3 text-left">
                    <Avatar seat={s} size={36} />
                    <span className="min-w-0">
                      <span className="block truncate font-display text-xl">{s.name}</span>
                      <Chips n={s.chips} size={16} max={5} className="font-crt" />
                    </span>
                  </button>
                ))}
            </div>
          </>
        )}

        {funded && myTurn && state.phase === "AWAIT_TRIGGER" && (
          <>
            <p className="font-crt text-xl text-ash">AIMING AT</p>
            <p className="font-display text-5xl">{target?.seat === me.seat ? "YOURSELF" : target?.name}</p>
            <button
              onClick={fire}
              disabled={!trigCh || firing}
              aria-label="Pull trigger"
              className="animate-pulse-red aspect-square w-64 max-w-full rounded-full border-8 border-[#5c0f0c] bg-[radial-gradient(circle_at_40%_35%,#ff5a4e,#b3130e_60%,#6d0906)] font-display text-4xl leading-none tracking-wide shadow-[0_20px_60px_rgb(224_49_43/0.45)] active:scale-95 disabled:animate-none disabled:opacity-60"
            >
              {firing ? "…" : trigCh ? (
                <>
                  PULL
                  <br />
                  TRIGGER
                  {(trigCh.requirePasskey || (state.config.faceIdOnTrigger && loadPasskey())) && <span className="mt-2 block font-crt text-lg">🔐 Face ID</span>}
                </>
              ) : (
                "ARMING…"
              )}
            </button>
            <div className="flex flex-wrap justify-center gap-2 font-crt text-lg">
              <span className="text-ash">change target:</span>
              {playing
                .filter((s) => s.seat !== state.aimingAt)
                .map((s) => (
                  <button key={s.seat} onClick={() => aim(s.seat)} className="rounded-lg border border-bone/20 px-2">
                    {s.seat === me.seat ? "me" : s.name}
                  </button>
                ))}
            </div>
          </>
        )}

        {funded && inGame && !myTurn && state.phase !== "ROUND_START" && (
          <>
            {state.phase === "AWAIT_AIM" && (
              <p className="font-display text-4xl">
                <span style={{ color: seatColor(cur.seat) }}>{cur.name}</span>'s turn
              </p>
            )}
            {state.phase === "AWAIT_TRIGGER" && (
              <p className="font-display text-4xl leading-tight">
                <span style={{ color: seatColor(cur.seat) }}>{cur.name}</span> is aiming at{" "}
                {target?.seat === me.seat ? <span className="text-blood">YOU</span> : target?.seat === cur.seat ? "themselves" : target?.name}
              </p>
            )}
            {state.phase === "RESOLVING" && <p className="animate-pulse font-display text-5xl">💥</p>}
            {state.phase === "RIGGED" && state.rigged && (
              <p className="font-display text-4xl leading-tight">
                <span className="text-blood">RIGGED!</span>
                <br />
                {state.seats[state.rigged.accuser].name} → {state.seats[state.rigged.accused].name}
                <span className="block font-crt text-xl text-ash">{state.rigged.verdict ?? "opening envelopes on-chain…"}</span>
              </p>
            )}
            {state.phase === "LAST_CALL" && (
              <>
                <p className="font-display text-4xl">The gun is empty.</p>
                <p className="font-type text-xl text-blood">Any last accusations?</p>
              </>
            )}
            {state.phase === "ROUND_END" && (
              <>
                <p className="font-crt text-xl tracking-[0.3em] text-ash">
                  ROUND {state.round + 1} OF {state.config.rounds} OVER
                </p>
                <p className="font-display text-4xl">The chip leader takes the pot.</p>
                <p className="font-type text-lg text-bone/70">Look at the TV.</p>
              </>
            )}
            {state.phase === "BUY_INS" && (
              <>
                <p className="font-display text-4xl">Waiting on buy-ins…</p>
                <p className="font-type text-lg text-bone/70">Broke players have {buyInsLeft ?? 0}s to buy back in.</p>
              </>
            )}
            {state.countIsOff && inRound && state.phase !== "RIGGED" && <p className="font-crt text-xl text-brass">⚠ The count is off. Someone cheated.</p>}
          </>
        )}

        {(state.phase === "OVER" || state.phase === "TAPE") && (
          <>
            <p className="font-display text-5xl">{state.winner === me.seat ? "🏆 YOU WIN" : "GAME OVER"}</p>
            {result && (
              <div className="w-full rounded-3xl border-2 border-bone/15 bg-black/60 p-4 font-crt text-xl">
                <p className="text-ash">
                  Bought in {dollars(result.spentCents)} ({result.buyIns}×) · cashed out {result.chips} chips = {dollars(result.cashOutCents)}
                </p>
                <p className="mt-1 font-display text-5xl">
                  <Profit cents={result.profitCents} />
                </p>
                <p className="text-ash">Wallet now {me.bankrollCents !== null ? dollars(me.bankrollCents) : "…"}</p>
              </div>
            )}
            <p className="font-type text-xl text-bone/70">Look at the TV. The tape doesn't lie.</p>
          </>
        )}
      </section>

      {inRound && funded && (
        <footer className="flex flex-col gap-3 px-4 pb-6">
          <button
            onClick={() => {
              unlockAudio();
              setRiggedOpen(true);
            }}
            disabled={!priv.canAccuse}
            className="rounded-2xl border-4 border-blood bg-blood/20 py-4 font-display text-4xl tracking-[0.15em] text-bone disabled:border-bone/10 disabled:bg-transparent disabled:text-ash"
          >
            {state.accuseUsed.includes(me.seat) ? "RIGGED! (used)" : "RIGGED!"}
          </button>
          <CheatCard
            card={priv.card}
            used={priv.cardUsed}
            playedOn={priv.cardPlayedOnShell}
            canCheat={priv.canCheat}
            onPlay={async () => {
              const r = await emitAck(C2S.cheatPlay);
              if (!r.ok) say(r.error);
            }}
          />
        </footer>
      )}

      {/*
       * The full-screen sheets mount and unmount outright, with no exit animation: if the player
       * switches apps mid-round the browser pauses animation frames, an exit never finishes, and
       * the leftover overlay swallows every tap.
       */}
      {peekShow && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/95"
          onClick={() => setPeekShow(null)}
        >
          <p className="font-crt text-xl tracking-[0.3em] text-ash">👁 SHELL #{peekShow.shell + 1} IS</p>
          <p className={`font-display text-8xl ${peekShow.live ? "text-blood" : "text-steel"}`}>{peekShow.live ? "LIVE" : "BLANK"}</p>
        </motion.div>
      )}

      {riggedOpen && (
        <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="fixed inset-0 z-40 flex flex-col justify-end bg-black/80">
          <motion.div initial={{ y: 300 }} animate={{ y: 0 }} className="rounded-t-3xl border-t-4 border-blood bg-soot p-5 pb-8">
            {!accuseCh ? (
              <>
                <p className="font-display text-4xl text-blood">WHO'S CHEATING?</p>
                <p className="font-crt text-lg text-ash">Right: you take ALL their chips. Wrong: you pay them 1.</p>
                <div className="mt-4 grid grid-cols-2 gap-3">
                  {accusable.map((s) => (
                    <button key={s.seat} onClick={() => accuse(s.seat)} aria-label={`Accuse ${s.name}`} className="flex items-center gap-2 rounded-2xl border-2 border-bone/15 bg-smoke p-3 text-left">
                      <Avatar seat={s} size={40} />
                      <span className="min-w-0">
                        <span className="block truncate font-display text-2xl">{s.name}</span>
                        <Chips n={s.chips} size={16} max={5} className="font-crt" />
                      </span>
                    </button>
                  ))}
                </div>
              </>
            ) : (
              <>
                <p className="font-display text-4xl">
                  Accuse <span className="text-blood">{state.seats[accuseCh.accused!]?.name}</span>?
                </p>
                <p className="font-crt text-lg text-ash">Win {state.seats[accuseCh.accused!]?.chips ?? 0} chips or lose 1.</p>
                <button onClick={swear} disabled={firing} className="mt-4 w-full rounded-2xl bg-blood py-5 font-display text-3xl tracking-wide disabled:opacity-50">
                  {firing ? "…" : accuseCh.requirePasskey || (state.config.faceIdOnTrigger && loadPasskey()) ? "🔐 SWEAR ON YOUR FACE" : "SWEAR IT"}
                </button>
              </>
            )}
            <button onClick={cancelRigged} className="mt-4 w-full py-2 font-crt text-xl text-ash">
              never mind
            </button>
          </motion.div>
        </motion.div>
      )}
    </main>
  );
}
