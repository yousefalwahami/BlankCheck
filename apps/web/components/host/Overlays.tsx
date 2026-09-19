"use client";

import { CHEAT_INFO, TIMING, type ChainTx, type Fx, type PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Avatar, ConfettiBurst, Shell } from "../ui/bits";

type Timed<T> = (T & { at: number }) | null;
export type OverlayFx = {
  round: Timed<Extract<Fx, { type: "round" }>>;
  shot: Timed<Extract<Fx, { type: "shot" }>>;
  mismatch: Timed<Extract<Fx, { type: "mismatch" }>>;
  verdict: Timed<Extract<Fx, { type: "verdict" }>>;
  gameOver: Timed<Extract<Fx, { type: "gameOver" }>>;
};

function useNow(interval = 200) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(t);
  }, [interval]);
  return now;
}

const full = "pointer-events-none fixed inset-0 z-40 flex flex-col items-center justify-center text-center";

export function Overlays({ state, fx, txs }: { state: PublicState; fx: OverlayFx; txs: ChainTx[] }) {
  const now = useNow(150);
  const name = (i: number) => state.seats[i]?.name ?? `Seat ${i + 1}`;
  const showRound = fx.round && now - fx.round.at < TIMING.roundIntro;
  const showShot = fx.shot && now - fx.shot.at < TIMING.shotAnim - 150;
  const showMismatch = fx.mismatch && now - fx.mismatch.at < 2200 && !showShot;
  const rigged = state.phase === "RIGGED" ? state.rigged : null;
  const showGameOver = state.phase === "OVER" && fx.gameOver;
  const lastCall = state.phase === "LAST_CALL" && state.lastCallEndsAt ? Math.max(0, Math.ceil((state.lastCallEndsAt - now) / 1000)) : null;

  return (
    <>
      <AnimatePresence>
        {showRound && fx.round && (
          <motion.div key={`round-${fx.round.at}`} className={`${full} bg-black/80`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.p initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="font-crt text-[3vh] tracking-[0.5em] text-ash">
              THE DEALER LOADS THE POPPER
            </motion.p>
            <motion.h2 initial={{ scale: 2.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 14 }} className="font-display text-[18vh] leading-none">
              ROUND {fx.round.round + 1}
            </motion.h2>
            <div className="mt-[3vh] flex items-end gap-[1vw]">
              {[...Array(fx.round.live).fill(1), ...Array(fx.round.blank).fill(0)].map((s, i) => (
                <motion.div key={i} initial={{ y: 60, opacity: 0, rotate: -20 }} animate={{ y: 0, opacity: 1, rotate: 0 }} transition={{ delay: 0.4 + i * 0.12 }}>
                  <Shell live={s === 1} size={96} />
                </motion.div>
              ))}
            </div>
            <p className="mt-[3vh] font-display text-[7vh] tracking-wide">
              <span className="text-blood">{fx.round.live} LIVE</span> · <span className="text-steel">{fx.round.blank} BLANK</span>
            </p>
            <p className="mt-[1vh] font-type text-[2.6vh] text-bone/70">Order sealed on-chain. Cheat cards dealt. Good luck.</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showShot && fx.shot && (
          <motion.div key={`shot-${fx.shot.at}`} className={full} initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {fx.shot.live && (
              <>
                <motion.div className="absolute inset-0 bg-[#e8b13a]" initial={{ opacity: 0.55 }} animate={{ opacity: 0 }} transition={{ duration: 0.5 }} />
                <div className="absolute inset-0">
                  <ConfettiBurst n={48} seed={fx.shot.at} spread={900} className="h-full w-full" />
                </div>
              </>
            )}
            <motion.h2
              initial={{ scale: fx.shot.live ? 3 : 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 16 }}
              className={`font-display leading-none ${fx.shot.live ? "text-[26vh] text-blood drop-shadow-[0_0_40px_rgba(224,49,43,0.7)]" : "text-[16vh] text-steel"}`}
            >
              {fx.shot.live ? "POP!" : "pfft."}
            </motion.h2>
            <p className="rounded-xl bg-black/70 px-6 py-2 font-display text-[4.5vh] tracking-wide">
              {name(fx.shot.shooter)} → {fx.shot.target === fx.shot.shooter ? "themselves" : name(fx.shot.target)}
              {fx.shot.live && <span className="text-blood"> · −1 ❤️</span>}
              {fx.shot.again && <span className="text-brass"> · GOES AGAIN</span>}
              {fx.shot.eliminated && <span className="text-ash"> · 👻 OUT</span>}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showMismatch && (
          <motion.div key="mismatch" className={full} initial={{ opacity: 0 }} animate={{ opacity: [0, 1, 0.6, 1] }} exit={{ opacity: 0 }}>
            <p className="rounded-2xl border-8 border-brass bg-black/85 px-[4vw] py-[2vh] font-display text-[12vh] leading-none text-brass">⚠ THE COUNT IS OFF</p>
            <p className="mt-[2vh] font-type text-[3vh] text-bone">Someone at this table cheated. The chain knows who.</p>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>{rigged && <RiggedScene key={`${rigged.accuser}-${rigged.accused}-${state.round}`} state={state} txs={txs} />}</AnimatePresence>

      <AnimatePresence>
        {lastCall !== null && (
          <motion.div
            key="lastcall"
            className="pointer-events-none fixed inset-x-0 top-[14vh] z-30 flex flex-col items-center"
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="rounded-2xl border-4 border-blood bg-black/85 px-[3vw] py-[1.5vh] text-center">
              <p className="font-display text-[6vh] leading-none tracking-wider">ANY LAST ACCUSATIONS?</p>
              <p className="font-crt text-[8vh] leading-none text-blood">{lastCall}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {showGameOver && fx.gameOver && (
          <motion.div key="gameover" className={`${full} bg-black/85`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <p className="font-crt text-[3vh] tracking-[0.5em] text-ash">LAST ONE STANDING</p>
            <motion.div initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring" }} className="my-[2vh]">
              <Avatar seat={state.seats[fx.gameOver.winner] ?? { seat: 0, name: "?", kind: "human", hearts: 1 }} size={180} />
            </motion.div>
            <h2 className="font-display text-[14vh] leading-none text-brass">🏆 {name(fx.gameOver.winner)}</h2>
            <p className="mt-[3vh] animate-pulse font-crt text-[3.5vh] tracking-[0.3em]">◀◀ REWINDING THE TAPE…</p>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function RiggedScene({ state, txs }: { state: PublicState; txs: ChainTx[] }) {
  const r = state.rigged!;
  const [stage, setStage] = useState<"slam" | "open">("slam");
  useEffect(() => {
    const t = setTimeout(() => setStage("open"), 1300);
    return () => clearTimeout(t);
  }, []);
  const name = (i: number) => state.seats[i]?.name ?? `Seat ${i + 1}`;
  const revealTx = [...txs].reverse().find((t) => t.kind === "REVEAL");
  const guilty = r.verdict === "GUILTY";
  const loser = r.verdict ? (guilty ? r.accused : r.accuser) : null;

  return (
    <motion.div className={`${full} bg-black/90`} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <AnimatePresence mode="wait">
        {stage === "slam" ? (
          <motion.h2
            key="slam"
            initial={{ scale: 4, rotate: -12, opacity: 0 }}
            animate={{ scale: 1, rotate: -4, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            transition={{ type: "spring", stiffness: 260, damping: 12 }}
            className="font-display text-[30vh] leading-none text-blood drop-shadow-[0_0_60px_rgba(224,49,43,0.8)]"
          >
            RIGGED!
          </motion.h2>
        ) : (
          <motion.div key="open" initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center gap-[3vh]">
            <div className="flex items-center gap-[4vw]">
              <div className="flex flex-col items-center gap-2">
                <Avatar seat={state.seats[r.accuser]} size={140} />
                <p className="font-display text-[4vh]">{name(r.accuser)}</p>
                {loser === r.accuser && <HeartBreak />}
              </div>
              <motion.p initial={{ x: -30 }} animate={{ x: [0, 20, 0] }} transition={{ repeat: Infinity, duration: 1 }} className="text-[12vh]">
                👉
              </motion.p>
              <div className="flex flex-col items-center gap-2">
                <Avatar seat={state.seats[r.accused]} size={140} />
                <p className="font-display text-[4vh]">{name(r.accused)}</p>
                {loser === r.accused && <HeartBreak />}
              </div>
            </div>

            {!r.verdict ? (
              <div className="flex flex-col items-center gap-[2vh]">
                <div className="flex gap-3">
                  {[0, 1, 2, 3].map((i) => (
                    <motion.div
                      key={i}
                      initial={{ y: 200, rotate: (i - 1.5) * 30, opacity: 0 }}
                      animate={{ y: 0, rotate: (i - 1.5) * 8, opacity: 1 }}
                      transition={{ delay: i * 0.15, type: "spring" }}
                      className="text-[9vh]"
                    >
                      ✉️
                    </motion.div>
                  ))}
                </div>
                <p className="animate-pulse font-crt text-[4vh] tracking-[0.3em] text-crt">OPENING {name(r.accused).toUpperCase()}'S ENVELOPES ON-CHAIN…</p>
              </div>
            ) : (
              <div className="flex flex-col items-center gap-[2vh]">
                <motion.p
                  initial={{ scale: 1.8, rotate: -20, opacity: 0 }}
                  animate={{ scale: 1, rotate: -8, opacity: 1 }}
                  transition={{ type: "spring", stiffness: 300, damping: 14 }}
                  className={`stamp text-[14vh] leading-none ${guilty ? "text-blood" : "text-crt"}`}
                >
                  {r.verdict}
                </motion.p>
                <div className="flex flex-wrap justify-center gap-3">
                  {guilty ? (
                    r.evidence?.map((e, i) => (
                      <motion.div
                        key={i}
                        initial={{ y: 30, opacity: 0 }}
                        animate={{ y: 0, opacity: 1 }}
                        transition={{ delay: 0.3 + i * 0.2 }}
                        className="rounded-lg bg-bone px-5 py-3 font-type text-[3.2vh] text-ink shadow-xl"
                      >
                        {CHEAT_INFO[e.cheat].emoji} {CHEAT_INFO[e.cheat].name} on shell #{e.shell + 1}
                      </motion.div>
                    ))
                  ) : (
                    <p className="rounded-lg bg-bone px-5 py-3 font-type text-[3.2vh] text-ink">Every envelope said “nothing.” {name(r.accuser)} pays.</p>
                  )}
                </div>
                {revealTx && (
                  <p className="font-crt text-[2.4vh] text-crt">
                    ⛓ verified by the referee program · {revealTx.ms} ms {revealTx.explorerUrl ? "· scan.thru.org" : revealTx.mock ? "· mock chain" : ""}
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function HeartBreak() {
  return (
    <motion.span initial={{ scale: 1.6 }} animate={{ scale: [1.6, 1, 1.2], rotate: [0, -10, 10, 0], opacity: [1, 1, 0.2] }} transition={{ duration: 1.4 }} className="text-[6vh]">
      💔
    </motion.span>
  );
}
