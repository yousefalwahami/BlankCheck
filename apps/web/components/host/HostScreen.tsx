"use client";

import { C2S, S2C, type BotId, type ChainTx, type Fx, type PitBossReading, type PublicState, type TapeData } from "@blankcheck/shared";
import { useCallback, useEffect, useMemo, useState } from "react";
import { emitAck, getSocket, useConnected, useSocketEvent } from "@/lib/socket";
import { resolveServerUrl } from "@/lib/serverUrl";
import { sfx, setMuted, unlockAudio } from "@/lib/sounds";
import { Lobby } from "./Lobby";
import { Overlays, type OverlayFx } from "./Overlays";
import { ShellBoard, Table, type SeatFx } from "./Table";
import { TapeView } from "./Tape";
import { Ticker } from "./Ticker";

const HOST_KEY = "bc.host";

function loadHost(): { room: string; hostToken: string } | null {
  try {
    const raw = sessionStorage.getItem(HOST_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveHost(v: { room: string; hostToken: string } | null) {
  try {
    if (v) sessionStorage.setItem(HOST_KEY, JSON.stringify(v));
    else sessionStorage.removeItem(HOST_KEY);
  } catch {
    /* ignore */
  }
}

export function HostScreen() {
  const connected = useConnected();
  const [state, setState] = useState<PublicState | null>(null);
  const [txs, setTxs] = useState<ChainTx[]>([]);
  const [pit, setPit] = useState<PitBossReading>({});
  const [tape, setTape] = useState<TapeData | null>(null);
  const [fx, setFx] = useState<OverlayFx>({ round: null, shot: null, mismatch: null, verdict: null, gameOver: null });
  const [taunts, setTaunts] = useState<Record<number, { text: string; at: number }>>({});
  const [seatFx, setSeatFx] = useState<Record<number, SeatFx>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sound, setSound] = useState(false);
  const [origin, setOrigin] = useState("");

  useEffect(() => setOrigin(window.location.origin), []);

  // Create a room, or re-attach to ours after a refresh / reconnect.
  useEffect(() => {
    const s = getSocket();
    const attach = async () => {
      const saved = loadHost();
      if (saved) {
        const r = await emitAck(C2S.hostAttach, saved);
        if (r.ok) return;
        saveHost(null);
      }
      const hearts = Number(new URLSearchParams(window.location.search).get("hearts")) || 3;
      const r = await emitAck<{ room: string; hostToken: string }>(C2S.roomCreate, { hearts, faceIdOnTrigger: true });
      if (r.ok) saveHost({ room: r.room, hostToken: r.hostToken });
      else setError(r.error);
    };
    s.on("connect", attach);
    if (s.connected) void attach();
    return () => {
      s.off("connect", attach);
    };
  }, []);

  useSocketEvent<PublicState>(S2C.state, useCallback((p) => setState(p), []));
  useSocketEvent<ChainTx>(S2C.chainTx, useCallback((t) => setTxs((prev) => (prev.some((x) => x.id === t.id) ? prev : [...prev.slice(-40), t])), []));
  useSocketEvent<PitBossReading>(S2C.pitboss, useCallback((p) => setPit({ ...p }), []));
  useSocketEvent<Fx>(
    S2C.fx,
    useCallback((f: Fx) => {
      const at = Date.now();
      switch (f.type) {
        case "round":
          setFx((x) => ({ ...x, round: { ...f, at }, mismatch: null }));
          setPit({});
          setTape(null);
          sfx.rack();
          break;
        case "shot":
          setFx((x) => ({ ...x, shot: { ...f, at } }));
          setSeatFx((x) => ({ ...x, [f.target]: { kind: f.live ? "hit" : "miss", at } }));
          if (f.live) sfx.bang();
          else sfx.blank();
          break;
        case "mismatch":
          setFx((x) => ({ ...x, mismatch: { ...f, at } }));
          setTimeout(() => sfx.alarm(), 900);
          break;
        case "rigged":
          sfx.rigged();
          break;
        case "verdict":
          setFx((x) => ({ ...x, verdict: { ...f, at } }));
          sfx.gavel();
          setTimeout(() => sfx.shatter(), 700);
          break;
        case "lastCall":
          sfx.tick();
          break;
        case "taunt":
          setTaunts((x) => ({ ...x, [f.seat]: { text: f.text, at } }));
          break;
        case "gameOver":
          setFx((x) => ({ ...x, gameOver: { ...f, at } }));
          break;
        case "tape":
          setTape(f.tape);
          sfx.rewind();
          break;
        case "boo":
          setSeatFx((x) => ({ ...x, [f.seat]: { kind: "boo", at } }));
          sfx.boo();
          break;
      }
    }, []),
  );

  const serverUrl = useMemo(() => (origin ? resolveServerUrl() : ""), [origin]);
  const joinUrl = state && origin ? `${origin}/join?room=${state.room}&server=${encodeURIComponent(serverUrl)}` : "";

  const act = async (event: string, payload: unknown = {}) => {
    setError(null);
    const r = await emitAck(event, payload, 30_000);
    if (!r.ok) setError(r.error);
    return r.ok;
  };

  const start = async () => {
    unlockAudio();
    setSound(true);
    setBusy(true);
    setTxs([]);
    await act(C2S.gameStart);
    setBusy(false);
  };

  const restart = async () => {
    setTape(null);
    setTxs([]);
    setFx({ round: null, shot: null, mismatch: null, verdict: null, gameOver: null });
    await act(C2S.gameRestart);
  };

  const newRoom = () => {
    saveHost(null);
    window.location.reload();
  };

  if (!state) {
    return (
      <main className="room-bg crt flex h-dvh flex-col items-center justify-center gap-4 text-center">
        <div className="grain" />
        <p className="animate-flicker font-display text-[10vh]">BLANK CHECK</p>
        <p className="font-crt text-[3vh] text-ash">{connected ? "Setting the table…" : `Connecting to the game server at ${serverUrl || "…"}`}</p>
        {error && <p className="font-crt text-[2.5vh] text-blood">{error}</p>}
      </main>
    );
  }

  const cur = state.seats[state.currentSeat];
  const target = state.aimingAt !== null ? state.seats[state.aimingAt] : null;
  const caption = (() => {
    switch (state.phase) {
      case "ROUND_START":
        return "The dealer is loading the gun…";
      case "AWAIT_AIM":
        return `${cur?.name}'s turn. Pick a target.`;
      case "AWAIT_TRIGGER":
        return `${cur?.name} is aiming at ${target?.seat === cur?.seat ? "THEMSELVES" : target?.name}…${state.config.faceIdOnTrigger && cur?.walletReady && cur.kind === "human" ? " (Face ID to fire)" : ""}`;
      case "RESOLVING":
        return "⛓ Pulling the trigger on-chain…";
      case "RIGGED":
        return "RIGGED!";
      case "LAST_CALL":
        return "The gun is empty.";
      case "OVER":
      case "TAPE":
        return "Game over.";
      default:
        return "";
    }
  })();

  const localhostWarning = origin.includes("localhost") || origin.includes("127.0.0.1");

  return (
    <main
      className="room-bg crt relative flex h-dvh flex-col overflow-hidden"
      onClick={() => {
        if (!sound) {
          unlockAudio();
          setSound(true);
        }
      }}
    >
      <div className="grain" />
      {!connected && <div className="fixed inset-x-0 top-0 z-50 bg-blood py-1 text-center font-crt text-[2.2vh]">Reconnecting to the game server…</div>}

      {state.phase === "LOBBY" ? (
        <>
          <Lobby
            state={state}
            joinUrl={joinUrl}
            error={error ?? (localhostWarning ? "Phones can't open localhost. Use your LAN IP, a tunnel, or the Vercel URL (Face ID needs HTTPS)." : null)}
            busy={busy}
            onAddBot={(p: BotId) => act(C2S.botAdd, { personality: p })}
            onKick={(seat) => act(C2S.seatKick, { seat })}
            onConfig={(c) => act(C2S.hostConfig, c)}
            onStart={start}
          />
          <button onClick={newRoom} className="absolute right-4 top-3 font-crt text-[1.9vh] text-ash hover:text-bone">
            new room
          </button>
        </>
      ) : tape ? (
        <TapeView tape={tape} state={state} onRestart={restart} />
      ) : (
        <>
          <header className="flex flex-col items-center gap-[1vh] px-4 pt-[2vh]">
            <ShellBoard state={state} />
            <p className="font-display text-[4vh] tracking-wide">{caption}</p>
          </header>
          <section className="relative min-h-0 flex-1">
            <Table state={state} pit={pit} taunts={taunts} seatFx={seatFx} />
            <aside className="absolute right-[1.5vw] top-0 hidden max-h-[16vh] w-[22vw] flex-col justify-end gap-0.5 overflow-hidden text-right font-crt text-[1.8vh] leading-tight text-ash xl:flex">
              {state.log.slice(-4).map((e) => (
                <p key={e.id} className={e.kind === "verdict" || e.kind === "rigged" ? "text-blood" : e.kind === "mismatch" ? "text-brass" : ""}>
                  {e.text}
                </p>
              ))}
            </aside>
            <div className="absolute left-[1.5vw] top-[1vh] font-crt text-[2vh] text-ash">
              ROOM <span className="text-brass">{state.room}</span>
              {Object.keys(pit).length > 0 && <p className="text-[1.8vh]">🕵️ Pit Boss suspicion meters</p>}
              {!sound && <p className="text-[1.8vh]">🔈 click for sound</p>}
            </div>
          </section>
          <Ticker txs={txs} state={state} />
        </>
      )}

      <Overlays state={state} fx={fx} txs={txs} />
      <button
        onClick={(e) => {
          e.stopPropagation();
          const next = !sound;
          setSound(next);
          setMuted(!next);
          if (next) unlockAudio();
        }}
        className="fixed bottom-[8vh] right-3 z-50 font-crt text-[2.4vh] text-ash hover:text-bone"
        aria-label={sound ? "Mute" : "Unmute"}
      >
        {sound ? "🔊" : "🔈"}
      </button>
    </main>
  );
}
