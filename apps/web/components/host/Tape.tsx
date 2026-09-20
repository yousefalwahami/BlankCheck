"use client";

import {
  CHEAT_INFO,
  Cheat,
  MONEY,
  dollars,
  computeAwards,
  flattenTapeEvents,
  replayRound,
  verifyTapeEnvelope,
  verifyTapeShells,
  type PublicState,
  type TapeData,
  type TapeEnvelope,
  type TapeLedgerEvent,
  type TapeLedgerKind,
  type TapeRound,
  type TapeShot,
} from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { sfx } from "@/lib/sounds";
import { Avatar, ChipIcon, Profit, Shell, shortAddr } from "../ui/bits";
import { useChainCheck } from "./useChainCheck";

type Slide =
  | { kind: "intro" }
  | { kind: "round"; round: TapeRound }
  | { kind: "shot"; round: TapeRound; shot: TapeShot }
  | { kind: "cheat"; round: TapeRound; env: TapeEnvelope }
  | { kind: "money" }
  | { kind: "awards" }
  | { kind: "final" };

const DURATION: Record<Slide["kind"], number> = { intro: 4000, round: 5500, shot: 4000, cheat: 4500, money: 8000, awards: 12000, final: 0 };

type LedgerChip = "all" | "lies" | "gotaway" | "caught" | "shots" | "rigged";

export function TapeView({ tape, state, onRestart }: { tape: TapeData; state: PublicState; onRestart: () => void }) {
  const chain = useChainCheck(tape);

  const verified = useMemo(() => {
    const env = new Map<string, boolean>();
    const shells = new Map<number, boolean>();
    const replay = new Map<number, boolean>();
    for (const r of tape.rounds) {
      shells.set(r.round, verifyTapeShells(tape.tableKey, r));
      replay.set(r.round, replayRound(r).every((x) => x.ok));
      for (const e of r.envelopes) env.set(`${r.round}:${e.window}:${e.seat}`, verifyTapeEnvelope(tape.tableKey, r.round, e));
    }
    const all = [...env.values()];
    return { env, shells, replay, ok: all.filter(Boolean).length, total: all.length };
  }, [tape]);

  const slides = useMemo<Slide[]>(() => {
    const out: Slide[] = [{ kind: "intro" }];
    for (const r of tape.rounds) {
      out.push({ kind: "round", round: r });
      for (const s of r.shots) out.push({ kind: "shot", round: r, shot: s });
      for (const e of r.envelopes) if (e.cheat !== Cheat.NONE) out.push({ kind: "cheat", round: r, env: e });
    }
    out.push({ kind: "money" }, { kind: "awards" }, { kind: "final" });
    return out;
  }, [tape]);

  const events = useMemo(
    () => flattenTapeEvents(tape, (n) => tape.seats.find((s) => s.seat === n)?.name ?? `Seat ${n + 1}`),
    [tape],
  );

  const [i, setI] = useState(0);
  const [dir, setDir] = useState<1 | -1>(1);
  const [paused, setPaused] = useState(false);
  const [mode, setMode] = useState<"play" | "ledger">("play");
  const [query, setQuery] = useState("");
  const [chip, setChip] = useState<LedgerChip>("all");
  const slide = slides[Math.min(i, slides.length - 1)];
  const last = slides.length - 1;

  const go = (delta: number) => {
    setI((x) => {
      const n = Math.max(0, Math.min(x + delta, last));
      if (n !== x) setDir(delta < 0 ? -1 : 1);
      return n;
    });
  };

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return events.filter((e) => matchLedgerChip(e, chip) && (!q || e.search.includes(q)));
  }, [events, query, chip]);

  useEffect(() => {
    const d = DURATION[slide.kind];
    if (!d || paused || mode === "ledger") return;
    const t = setTimeout(() => go(1), d);
    return () => clearTimeout(t);
  }, [slide, paused, slides.length, mode]);

  useEffect(() => {
    if (slide.kind === "cheat") setTimeout(() => sfx.stamp(), 900);
    if (slide.kind === "shot" && slide.shot.cheats.length) setTimeout(() => sfx.stamp(), 900);
  }, [slide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = e.target instanceof HTMLElement && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA");
      if (typing) return;
      if (e.key === "ArrowRight") go(1);
      if (e.key === "ArrowLeft") go(-1);
      if (e.key === " ") {
        e.preventDefault();
        setPaused((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length]);

  const seat = (n: number) => tape.seats.find((s) => s.seat === n);
  const name = (n: number) => seat(n)?.name ?? `Seat ${n + 1}`;
  const tx = (sig?: string) => (sig && tape.refereeMode === "thru" ? `${tape.explorerUrl}/tx/${sig}` : undefined);
  const totalCheats = tape.rounds.flatMap((r) => r.envelopes).filter((e) => e.cheat !== Cheat.NONE);
  const escaped = totalCheats.filter((e) => !e.caught).length;

  const jumpTo = (e: TapeLedgerEvent) => {
    const idx = slideIndexForEvent(slides, e);
    if (idx >= 0) {
      setDir(idx < i ? -1 : 1);
      setI(idx);
    }
    setMode("play");
    setPaused(true);
  };

  return (
    <div className="vhs relative flex h-full flex-col overflow-hidden">
      <div className="absolute left-[2vw] top-[2vh] z-20 flex items-center gap-4" onClick={(e) => e.stopPropagation()}>
        <div className="flex overflow-hidden rounded border border-bone/30 font-crt text-[2.2vh] tracking-widest">
          <button
            type="button"
            className={`px-3 py-1 ${mode === "play" ? "bg-bone text-ink" : "text-bone/70"}`}
            onClick={() => {
              setMode("play");
              setPaused(false);
            }}
          >
            PLAY
          </button>
          <button
            type="button"
            className={`px-3 py-1 ${mode === "ledger" ? "bg-bone text-ink" : "text-bone/70"}`}
            onClick={() => {
              setMode("ledger");
              setPaused(true);
            }}
          >
            LEDGER
          </button>
        </div>
        <span className="font-crt text-[4vh] text-bone vhs-text">
          {mode === "ledger" ? "☰ LEDGER" : i === 0 ? "◀◀ REW" : paused ? "❚❚ PAUSE" : "▶ PLAY"}
        </span>
      </div>
      <div className="absolute right-[2vw] top-[2vh] z-10 text-right font-crt text-[2.6vh] text-bone/80 vhs-text">
        TAPE #{tape.room}
        <br />
        {chain ? <span className={chain.ok ? "text-crt" : "text-blood"}>{chain.label}</span> : `✓ ${verified.ok}/${verified.total} envelopes re-hashed`}
      </div>
      {mode === "play" && <VhsClock />}

      {mode === "ledger" ? (
        <TapeLedger events={filtered} query={query} onQuery={setQuery} chip={chip} onChip={setChip} tx={tx} onJump={jumpTo} />
      ) : (
      <div className="relative z-0 flex flex-1 items-center justify-center px-[5vw]" onClick={() => go(1)}>
        <AnimatePresence mode="wait" custom={dir}>
          <motion.div
            key={i}
            custom={dir}
            variants={{
              enter: (d: 1 | -1) => ({ opacity: 0, x: 48 * d }),
              show: { opacity: 1, x: 0 },
              leave: (d: 1 | -1) => ({ opacity: 0, x: -48 * d }),
            }}
            initial="enter"
            animate="show"
            exit="leave"
            transition={{ duration: 0.35 }}
            className="w-full"
          >
            {slide.kind === "intro" && (
              <div className="text-center">
                <p className="font-crt text-[3.5vh] tracking-[0.5em] text-ash">WHAT REALLY HAPPENED</p>
                <h2 className="font-display text-[16vh] leading-none vhs-text">REVIEW THE TAPE</h2>
                <p className="mt-[3vh] font-type text-[3.4vh]">
                  {totalCheats.length} cheat{totalCheats.length === 1 ? "" : "s"} played. <span className="text-blood">{escaped} got away with it.</span>
                </p>
                <p className="mt-[1vh] font-crt text-[2.6vh] text-crt">
                  Every envelope and shell order is being re-hashed in this browser and checked against what was sealed on-chain.
                </p>
              </div>
            )}

            {slide.kind === "round" && (
              <RoundSlide r={slide.round} name={name} verified={verified.shells.get(slide.round.round)!} replayOk={verified.replay.get(slide.round.round)!} link={tx(slide.round.revealShellsTx)} tx={tx} />
            )}

            {slide.kind === "shot" && (
              <ShotSlide
                r={slide.round}
                shot={slide.shot}
                name={name}
                envOk={verified.env}
                replayOk={verified.replay.get(slide.round.round)!}
                tx={tx}
              />
            )}

            {slide.kind === "money" && <MoneySlide tape={tape} name={name} seat={seat} />}

            {slide.kind === "cheat" && (
              <div className="flex items-center justify-center gap-[5vw]">
                <div className="flex flex-col items-center gap-3">
                  <Avatar seat={{ seat: slide.env.seat, name: name(slide.env.seat), kind: seat(slide.env.seat)?.kind ?? "human", personality: seat(slide.env.seat)?.personality }} size={200} />
                  <p className="font-display text-[6vh]">{name(slide.env.seat)}</p>
                </div>
                <div className="flex flex-col items-start gap-[2vh]">
                  <p className="font-crt text-[3vh] tracking-[0.3em] text-ash">
                    ROUND {slide.round.round + 1} · ENVELOPE #{slide.env.window + 1}
                  </p>
                  <div className="rounded-xl bg-bone px-8 py-5 font-type text-[5vh] text-ink shadow-2xl">
                    {CHEAT_INFO[slide.env.cheat].emoji} {CHEAT_INFO[slide.env.cheat].name} on shell #{slide.env.shell + 1}
                  </div>
                  <motion.p
                    initial={{ scale: 1.8, opacity: 0, rotate: -18 }}
                    animate={{ scale: 1, opacity: 1, rotate: -6 }}
                    transition={{ delay: 0.8, type: "spring", stiffness: 280, damping: 14 }}
                    className={`stamp whitespace-nowrap text-[8vh] leading-none ${slide.env.caught ? "text-crt" : "text-blood"}`}
                  >
                    {slide.env.caught ? "CAUGHT" : "GOT AWAY WITH IT"}
                  </motion.p>
                  <Verified
                    ok={verified.env.get(`${slide.round.round}:${slide.env.window}:${slide.env.seat}`)! && slide.env.revealOk !== false}
                    detail={`sha256 → ${slide.env.hash.slice(0, 16)}…`}
                    links={[
                      ["sealed", tx(slide.env.sealTx)],
                      ["revealed", tx(slide.env.revealTx)],
                    ]}
                  />
                </div>
              </div>
            )}

            {slide.kind === "awards" && <Awards tape={tape} name={name} seat={seat} />}

            {slide.kind === "final" && (
              <div className="flex items-center justify-center gap-[5vw]">
                <div className="text-center">
                  <p className="font-display text-[12vh] leading-none vhs-text">{tape.onChainActions} ON-CHAIN ACTIONS</p>
                  <p className="font-display text-[7vh] leading-none text-crt">0 EDITS · EVERY ONE VERIFIABLE</p>
                  <p className="mt-[2vh] font-crt text-[2.8vh] text-ash">
                    {tape.refereeMode === "thru" ? `Table ${shortAddr(tape.tableAddress, 8)} on Thru alphanet` : "Played on the mock chain (same program rules, in memory)"}
                    {tape.failedTxs > 0 && <span className="block text-blood">{tape.failedTxs} transaction(s) failed and were flagged during the game.</span>}
                  </p>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onRestart();
                    }}
                    className="mt-[4vh] rounded-2xl bg-blood px-10 py-4 font-display text-[5vh] tracking-widest"
                  >
                    PLAY AGAIN
                  </button>
                </div>
                {tape.refereeMode === "thru" && tape.tableAddress && (
                  <div className="flex flex-col items-center gap-2">
                    <div className="rounded-xl bg-bone p-3">
                      <QRCodeSVG value={`${tape.explorerUrl}/address/${tape.tableAddress}`} size={260} bgColor="#efe6d2" fgColor="#0a0807" />
                    </div>
                    <p className="font-crt text-[2.4vh] text-ash">Check it yourself on scan.thru.org</p>
                  </div>
                )}
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </div>
      )}

      <div className="z-10 flex items-center justify-between px-[2vw] pb-[2vh] font-crt text-[2.2vh] text-ash">
        <span>
          {mode === "ledger"
            ? `LEDGER · ${events.length} events${filtered.length !== events.length ? ` · ${filtered.length} match` : ""}`
            : `${i + 1}/${slides.length} · ← → to scrub · space to pause`}
        </span>
        <span>{state.seats.length} players · winner {name(tape.winner)}</span>
      </div>
    </div>
  );
}

function RoundSlide({
  r,
  name,
  verified,
  replayOk,
  link,
  tx,
}: {
  r: TapeRound;
  name: (n: number) => string;
  verified: boolean;
  replayOk: boolean;
  link?: string;
  tx: (sig?: string) => string | undefined;
}) {
  const firedAt = new Map(r.shots.map((s) => [s.shellIndex, s]));
  const cheated = r.envelopes.filter((e) => e.cheat !== Cheat.NONE);
  return (
    <div className="flex flex-col items-center gap-[3vh]">
      <h3 className="font-display text-[10vh] leading-none vhs-text">ROUND {r.round + 1}</h3>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-[2vw] gap-y-[2vh]">
        <p className="text-right font-crt text-[3vh] text-ash">SEALED ORDER</p>
        <div className="flex items-end gap-[1vw]">
          {r.shells.map((s, i) => (
            <Shell key={i} live={s === 1} size={80} />
          ))}
        </div>
        <p className="text-right font-crt text-[3vh] text-ash">WHAT FIRED</p>
        <div className="flex items-end gap-[1vw]">
          {r.shells.map((_, i) => {
            const shot = firedAt.get(i);
            const tampered = shot && (shot.cheats.length > 0 || shot.fired !== shot.committed);
            return (
              <div key={i} className="relative flex flex-col items-center">
                {shot ? <Shell live={shot.fired === 1} size={80} highlight={!!tampered} /> : <Shell live={false} spent size={80} />}
                <span className="h-[3vh] font-crt text-[2.2vh]">{shot?.cheats.map((c) => CHEAT_INFO[c.cheat].emoji).join("")}</span>
              </div>
            );
          })}
        </div>
      </div>
      <p className="font-type text-[3vh]">
        {cheated.length === 0 ? "Nobody cheated this round. Allegedly." : `${cheated.length} cheat${cheated.length > 1 ? "s" : ""}: ${cheated.map((e) => `${name(e.seat)} (${CHEAT_INFO[e.cheat].name})`).join(", ")}`}
      </p>
      <div className="flex flex-wrap items-center justify-center gap-x-[2vw] gap-y-1 font-crt text-[2.6vh]">
        {r.pot && (
          <span className="text-brass">
            🏦 pot {r.pot.winners.length ? `${r.pot.chipsEach * r.pot.winners.length} → ${r.pot.winners.map(name).join(" & ")}` : "empty"}
            {r.pot.carried > 0 ? ` · ${r.pot.carried} carried` : ""}
            {tx(r.pot.tx) && (
              <a href={tx(r.pot.tx)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-2 underline">
                settled ↗
              </a>
            )}
          </span>
        )}
        {r.accusations.map((a, i) => (
          <span key={i} className={a.verdict === "GUILTY" ? "text-blood" : "text-crt"}>
            🚨 {name(a.accuser)} → {name(a.accused)}: {a.verdict} ({a.chipsMoved} chip{a.chipsMoved === 1 ? "" : "s"})
          </span>
        ))}
        {r.buyIns.map((b, i) => (
          <span key={`b${i}`} className="text-crt">
            💵 {name(b.seat)} bought back in
            {tx(b.tx) && (
              <a href={tx(b.tx)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-2 underline">
                ↗
              </a>
            )}
          </span>
        ))}
      </div>
      <Verified ok={verified && replayOk && r.shellsOk !== false} detail={replayOk ? "sealed order + revealed cheats reproduce every shot" : "shots don't match the sealed order!"} links={[["revealed", link]]} />
    </div>
  );
}

function envelopesForShot(r: TapeRound, shot: TapeShot): TapeEnvelope[] {
  return shot.cheats
    .map((c) => r.envelopes.find((e) => e.seat === c.seat && e.cheat === c.cheat && (e.shell === shot.shellIndex || e.window === shot.window)))
    .filter((e): e is TapeEnvelope => !!e);
}

function ShotSlide({
  r,
  shot,
  name,
  envOk,
  replayOk,
  tx,
}: {
  r: TapeRound;
  shot: TapeShot;
  name: (n: number) => string;
  envOk: Map<string, boolean>;
  replayOk: boolean;
  tx: (sig?: string) => string | undefined;
}) {
  const tampered = shot.committed !== shot.fired || shot.cheats.length > 0;
  const targetLabel = shot.shooter === shot.target ? "THEMSELVES" : name(shot.target);
  const matching = envelopesForShot(r, shot);
  const thisShot = replayRound(r).find((x) => x.shot === shot.shot);
  const hashesOk = matching.every((e) => envOk.get(`${r.round}:${e.window}:${e.seat}`) !== false);
  return (
    <div className="flex flex-col items-center gap-[2.5vh]">
      <p className="font-crt text-[3vh] tracking-[0.3em] text-ash">
        ROUND {r.round + 1} · SHOT {shot.shot + 1}
      </p>
      <h3 className="font-display text-[8vh] leading-none vhs-text">
        {name(shot.shooter)} → {targetLabel}
      </h3>
      <div className="flex items-end gap-[4vw]">
        <div className="flex flex-col items-center gap-2">
          <p className="font-crt text-[2.4vh] text-ash">SEALED</p>
          <Shell live={shot.committed === 1} size={110} highlight={tampered} />
        </div>
        <p className="mb-[4vh] font-display text-[6vh] text-ash">→</p>
        <div className="flex flex-col items-center gap-2">
          <p className="font-crt text-[2.4vh] text-ash">FIRED</p>
          <Shell live={shot.fired === 1} size={110} highlight={tampered} />
        </div>
      </div>
      {shot.cheats.map((c, i) => (
        <p key={i} className="font-type text-[3.4vh]">
          LIE: {name(c.seat)} played {CHEAT_INFO[c.cheat].emoji} {CHEAT_INFO[c.cheat].name}
        </p>
      ))}
      {matching.map((e, i) => (
        <motion.p
          key={`${e.window}-${e.seat}-${i}`}
          initial={{ scale: 1.8, opacity: 0, rotate: -18 }}
          animate={{ scale: 1, opacity: 1, rotate: -6 }}
          transition={{ delay: 0.8, type: "spring", stiffness: 280, damping: 14 }}
          className={`stamp whitespace-nowrap text-[7vh] leading-none ${e.caught ? "text-crt" : "text-blood"}`}
        >
          {e.caught ? "CAUGHT" : "GOT AWAY WITH IT"}
        </motion.p>
      ))}
      <Verified
        ok={replayOk && (thisShot?.ok ?? true) && hashesOk && r.shellsOk !== false}
        detail={tampered ? "sealed shell ≠ what fired — a lie touched this chamber" : "sealed shell matches what fired"}
        links={[
          ["trigger", tx(shot.triggerTx)],
          ["resolve", tx(shot.resolveTx)],
        ]}
      />
    </div>
  );
}

function matchLedgerChip(e: TapeLedgerEvent, chip: LedgerChip): boolean {
  if (chip === "all") return true;
  if (chip === "lies") return e.kind === "lie";
  if (chip === "gotaway") return e.kind === "lie" && e.caught === false;
  if (chip === "caught") return e.kind === "lie" && e.caught === true;
  if (chip === "shots") return e.kind === "shot";
  if (chip === "rigged") return e.kind === "rigged";
  return true;
}

function slideIndexForEvent(slides: Slide[], e: TapeLedgerEvent): number {
  return slides.findIndex((s) => {
    if (e.kind === "round" || e.kind === "rigged" || e.kind === "buyin" || e.kind === "pot") {
      return s.kind === "round" && s.round.round === e.round;
    }
    if (e.kind === "shot") return s.kind === "shot" && s.round.round === e.round && s.shot.shot === e.shot;
    if (e.kind === "lie") {
      return s.kind === "cheat" && s.round.round === e.round && s.env.window === e.window && e.seats.includes(s.env.seat);
    }
    return false;
  });
}

const KIND_GLYPH: Record<TapeLedgerKind, string> = {
  round: "⏺",
  shot: "💥",
  lie: "🤥",
  rigged: "🚨",
  buyin: "💵",
  pot: "🏦",
};

const LEDGER_CHIPS: { id: LedgerChip; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "lies", label: "LIES" },
  { id: "gotaway", label: "GOT AWAY" },
  { id: "caught", label: "CAUGHT" },
  { id: "shots", label: "SHOTS" },
  { id: "rigged", label: "RIGGED" },
];

function TapeLedger({
  events,
  query,
  onQuery,
  chip,
  onChip,
  tx,
  onJump,
}: {
  events: TapeLedgerEvent[];
  query: string;
  onQuery: (q: string) => void;
  chip: LedgerChip;
  onChip: (c: LedgerChip) => void;
  tx: (sig?: string) => string | undefined;
  onJump: (e: TapeLedgerEvent) => void;
}) {
  return (
    <div className="relative z-0 flex min-h-0 flex-1 flex-col px-[4vw] pt-[11vh]" onClick={(e) => e.stopPropagation()}>
      <input
        value={query}
        onChange={(e) => onQuery(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        placeholder="SEARCH THE TAPE — names, cheats, got away, guilty, live, hash…"
        autoFocus
        className="w-full rounded-lg border border-bone/20 bg-black/50 px-4 py-2 font-crt text-[2.4vh] text-bone outline-none placeholder:text-ash"
      />
      <div className="mt-3 flex flex-wrap gap-2">
        {LEDGER_CHIPS.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChip(c.id);
            }}
            className={`rounded-full border px-3 py-1 font-crt text-[2vh] tracking-widest ${
              chip === c.id ? "border-bone bg-bone text-ink" : "border-bone/30 text-bone/70"
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="mt-3 min-h-0 flex-1 overflow-y-auto pb-[4vh]">
        {events.length === 0 && <p className="py-8 text-center font-crt text-[2.6vh] text-ash">NO HITS ON THIS TAPE</p>}
        {events.map((e) => {
          const href = tx(e.tx);
          return (
            <div
              key={e.id}
              role="button"
              tabIndex={0}
              onClick={(ev) => {
                ev.stopPropagation();
                onJump(e);
              }}
              onKeyDown={(ev) => {
                if (ev.key === "Enter") {
                  ev.stopPropagation();
                  onJump(e);
                }
              }}
              className="flex w-full cursor-pointer items-baseline gap-[1.5vw] border-b border-bone/10 py-[1.2vh] text-left hover:bg-bone/5"
            >
              <span className="w-[3vw] shrink-0 text-center text-[2.6vh]">{KIND_GLYPH[e.kind]}</span>
              <span className="w-[6vw] shrink-0 font-crt text-[2.2vh] text-ash">R{e.round + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block font-display text-[3.2vh] leading-tight">{e.title}</span>
                <span className="block font-type text-[2vh] text-bone/70">{e.detail}</span>
              </span>
              {e.kind === "lie" && (
                <span className={`shrink-0 font-crt text-[2.2vh] tracking-widest ${e.caught ? "text-crt" : "text-blood"}`}>
                  {e.caught ? "CAUGHT" : "GOT AWAY"}
                </span>
              )}
              {e.verdict && (
                <span className={`shrink-0 font-crt text-[2.2vh] tracking-widest ${e.verdict === "GUILTY" ? "text-blood" : "text-crt"}`}>
                  {e.verdict}
                </span>
              )}
              {href && (
                <a
                  href={href}
                  target="_blank"
                  rel="noreferrer"
                  onClick={(ev) => ev.stopPropagation()}
                  className="shrink-0 font-crt text-[2vh] text-crt underline"
                >
                  tx ↗
                </a>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MoneySlide({ tape, name, seat }: { tape: TapeData; name: (n: number) => string; seat: (n: number) => TapeData["seats"][number] | undefined }) {
  const m = tape.money;
  const ranked = [...m.results].sort((a, b) => b.profitCents - a.profitCents || a.seat - b.seat);
  const moneyTx = (sig?: string) => (sig && m.bankMode === "thru" ? `${tape.explorerUrl}/tx/${sig}` : undefined);
  const spent = m.results.reduce((a, r) => a + r.spentCents, 0);
  const paid = m.results.reduce((a, r) => a + r.cashOutCents, 0);
  return (
    <div className="flex flex-col items-center gap-[2.5vh]">
      <h3 className="font-display text-[9vh] leading-none vhs-text">THE BOOKS</h3>
      <p className="font-crt text-[2.6vh] text-ash">
        {dollars(spent)} bought in · {dollars(paid)} cashed out · every dollar is a {m.ticker} {m.bankMode === "thru" ? "token transfer on Thru" : "transfer in the mock bank"}
      </p>
      <div className="grid w-full max-w-[80vw] gap-[1.2vh]">
        {ranked.map((r, i) => {
          const s = seat(r.seat);
          const mine = m.transfers.filter((t) => t.seat === r.seat);
          return (
            <motion.div
              key={r.seat}
              initial={{ opacity: 0, x: -40 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ delay: 0.2 + i * 0.2 }}
              className="flex items-center gap-[1.5vw] rounded-2xl border border-bone/15 bg-black/60 px-[1.5vw] py-[1vh]"
            >
              {s && <Avatar seat={s} size={56} />}
              <p className="w-[16vw] truncate font-display text-[4vh]">{name(r.seat)}</p>
              <p className="flex items-center gap-2 font-crt text-[3vh]">
                <ChipIcon size={28} color="#e8b13a" /> {r.chips}
              </p>
              <p className="font-crt text-[2.6vh] text-ash">
                in {dollars(r.spentCents)} ({r.buyIns}× {dollars(MONEY.buyInCents)}) · out {dollars(r.cashOutCents)}
              </p>
              <div className="ml-auto flex items-center gap-3">
                <div className="flex gap-2 font-crt text-[2vh]">
                  {mine.map((t, j) =>
                    moneyTx(t.tx) ? (
                      <a key={j} href={moneyTx(t.tx)} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className={`underline ${t.ok ? "text-crt" : "text-blood"}`}>
                        {t.kind === "buyIn" ? "in" : "out"}↗
                      </a>
                    ) : (
                      <span key={j} className={t.ok ? "text-crt/60" : "text-blood"}>
                        {t.kind === "buyIn" ? "in" : "out"}
                        {t.ok ? "✓" : "✖"}
                      </span>
                    ),
                  )}
                </div>
                <Profit cents={r.profitCents} className="font-display text-[4.5vh]" />
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
}

function Verified({ ok, detail, links }: { ok: boolean; detail: string; links: [string, string | undefined][] }) {
  return (
    <div className={`flex flex-wrap items-center gap-3 font-crt text-[2.6vh] ${ok ? "text-crt" : "text-blood"}`}>
      <span className="rounded-md border-2 border-current px-2">{ok ? "✓ VERIFIED" : "✖ MISMATCH"}</span>
      <span className="text-bone/70">{detail}</span>
      {links.map(([label, href]) =>
        href ? (
          <a key={label} href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="underline">
            {label} ↗
          </a>
        ) : null,
      )}
    </div>
  );
}

function Awards({ tape, name, seat }: { tape: TapeData; name: (n: number) => string; seat: (n: number) => TapeData["seats"][number] | undefined }) {
  const awards = computeAwards(tape);
  return (
    <div className="flex flex-col items-center gap-[3vh]">
      <h3 className="font-display text-[9vh] leading-none vhs-text">THE AWARDS</h3>
      <div className="grid w-full max-w-[85vw] grid-cols-3 gap-[2vh]">
        {awards.map((a, i) => (
          <motion.div
            key={a.id}
            initial={{ opacity: 0, y: 30 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.3 + i * 0.35 }}
            className="flex items-center gap-4 rounded-2xl border border-bone/15 bg-black/60 p-[2vh]"
          >
            <span className="text-[7vh]">{a.emoji}</span>
            <div className="min-w-0">
              <p className="font-crt text-[2.4vh] tracking-widest text-ash">{a.title.toUpperCase()}</p>
              <p className="truncate font-display text-[4.2vh] leading-tight">{a.seats.length ? a.seats.map(name).join(" & ") : "Nobody"}</p>
              <p className="font-type text-[2.1vh] text-bone/70">{a.detail}</p>
            </div>
            {a.seats.length === 1 && seat(a.seats[0]) && (
              <div className="ml-auto">
                <Avatar seat={seat(a.seats[0])!} size={64} />
              </div>
            )}
          </motion.div>
        ))}
      </div>
    </div>
  );
}

function VhsClock() {
  const [t, setT] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setT(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = t.toLocaleString("en-US", { month: "short", day: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).toUpperCase();
  return <div className="absolute bottom-[6vh] right-[2vw] z-10 font-crt text-[3.4vh] text-bone vhs-text">{s}</div>;
}
