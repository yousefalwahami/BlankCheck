"use client";

import {
  CHEAT_INFO,
  Cheat,
  computeAwards,
  replayRound,
  verifyTapeEnvelope,
  verifyTapeShells,
  type PublicState,
  type TapeData,
  type TapeEnvelope,
  type TapeRound,
} from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useMemo, useState } from "react";
import { sfx } from "@/lib/sounds";
import { Avatar, Shell, shortAddr } from "../ui/bits";
import { useChainCheck } from "./useChainCheck";

type Slide =
  | { kind: "intro" }
  | { kind: "round"; round: TapeRound }
  | { kind: "cheat"; round: TapeRound; env: TapeEnvelope }
  | { kind: "awards" }
  | { kind: "final" };

const DURATION: Record<Slide["kind"], number> = { intro: 4000, round: 5000, cheat: 4500, awards: 11000, final: 0 };

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
      for (const e of r.envelopes) if (e.cheat !== Cheat.NONE) out.push({ kind: "cheat", round: r, env: e });
    }
    out.push({ kind: "awards" }, { kind: "final" });
    return out;
  }, [tape]);

  const [i, setI] = useState(0);
  const [paused, setPaused] = useState(false);
  const slide = slides[Math.min(i, slides.length - 1)];

  useEffect(() => {
    const d = DURATION[slide.kind];
    if (!d || paused) return;
    const t = setTimeout(() => setI((x) => Math.min(x + 1, slides.length - 1)), d);
    return () => clearTimeout(t);
  }, [slide, paused, slides.length]);

  useEffect(() => {
    if (slide.kind === "cheat") setTimeout(() => sfx.stamp(), 900);
  }, [slide]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setI((x) => Math.min(x + 1, slides.length - 1));
      if (e.key === "ArrowLeft") setI((x) => Math.max(0, x - 1));
      if (e.key === " ") setPaused((p) => !p);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [slides.length]);

  const seat = (n: number) => tape.seats.find((s) => s.seat === n);
  const name = (n: number) => seat(n)?.name ?? `Seat ${n + 1}`;
  const tx = (sig?: string) => (sig && tape.refereeMode === "thru" ? `${tape.explorerUrl}/tx/${sig}` : undefined);
  const totalCheats = tape.rounds.flatMap((r) => r.envelopes).filter((e) => e.cheat !== Cheat.NONE);
  const escaped = totalCheats.filter((e) => !e.caught).length;

  return (
    <div className="vhs relative flex h-full flex-col overflow-hidden">
      <div className="absolute left-[2vw] top-[2vh] z-10 font-crt text-[4vh] text-bone vhs-text">
        {i === 0 ? "◀◀ REW" : paused ? "❚❚ PAUSE" : "▶ PLAY"}
      </div>
      <div className="absolute right-[2vw] top-[2vh] z-10 text-right font-crt text-[2.6vh] text-bone/80 vhs-text">
        TAPE #{tape.room}
        <br />
        {chain ? <span className={chain.ok ? "text-crt" : "text-blood"}>{chain.label}</span> : `✓ ${verified.ok}/${verified.total} envelopes re-hashed`}
      </div>
      <VhsClock />

      <div className="relative z-0 flex flex-1 items-center justify-center px-[5vw]" onClick={() => setI((x) => Math.min(x + 1, slides.length - 1))}>
        <AnimatePresence mode="wait">
          <motion.div
            key={i}
            initial={{ opacity: 0, x: 40 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -40 }}
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

            {slide.kind === "round" && <RoundSlide r={slide.round} name={name} verified={verified.shells.get(slide.round.round)!} replayOk={verified.replay.get(slide.round.round)!} link={tx(slide.round.revealShellsTx)} />}

            {slide.kind === "cheat" && (
              <div className="flex items-center justify-center gap-[5vw]">
                <div className="flex flex-col items-center gap-3">
                  <Avatar seat={{ seat: slide.env.seat, name: name(slide.env.seat), kind: seat(slide.env.seat)?.kind ?? "human", personality: seat(slide.env.seat)?.personality, hearts: 1 }} size={200} />
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

      <div className="z-10 flex items-center justify-between px-[2vw] pb-[2vh] font-crt text-[2.2vh] text-ash">
        <span>
          {i + 1}/{slides.length} · ← → to scrub · space to pause
        </span>
        <span>{state.seats.length} players · winner {name(tape.winner)}</span>
      </div>
    </div>
  );
}

function RoundSlide({ r, name, verified, replayOk, link }: { r: TapeRound; name: (n: number) => string; verified: boolean; replayOk: boolean; link?: string }) {
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
      <Verified ok={verified && replayOk && r.shellsOk !== false} detail={replayOk ? "sealed order + revealed cheats reproduce every shot" : "shots don't match the sealed order!"} links={[["revealed", link]]} />
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
                <Avatar seat={{ ...seat(a.seats[0])!, hearts: 1 }} size={64} />
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
