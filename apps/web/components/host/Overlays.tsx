"use client";

import { CHEAT_INFO, MONEY, TIMING, dollars, type ChainTx, type Fx, type PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Avatar, ChipIcon, Profit, Shell } from "../ui/bits";

type Timed<T> = (T & { at: number }) | null;
export type OverlayFx = {
  round: Timed<Extract<Fx, { type: "round" }>>;
  shot: Timed<Extract<Fx, { type: "shot" }>>;
  mismatch: Timed<Extract<Fx, { type: "mismatch" }>>;
  verdict: Timed<Extract<Fx, { type: "verdict" }>>;
  potAward: Timed<Extract<Fx, { type: "potAward" }>>;
  gameOver: Timed<Extract<Fx, { type: "gameOver" }>>;
  /** Small news along the top: buy-ins and players going broke. The name is filled in at render. */
  banner: Timed<{ seat: number; label: string; tone: "money" | "bad" }>;
};

export const emptyOverlayFx: OverlayFx = { round: null, shot: null, mismatch: null, verdict: null, potAward: null, gameOver: null, banner: null };

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
  const showPot = state.phase === "ROUND_END" && fx.potAward && now - fx.potAward.at < TIMING.potAward + 500;
  const showGameOver = state.phase === "OVER" && fx.gameOver;
  const showBanner = fx.banner && now - fx.banner.at < 3200 && !showRound && !showGameOver;
  const lastCall = state.phase === "LAST_CALL" && state.lastCallEndsAt ? Math.max(0, Math.ceil((state.lastCallEndsAt - now) / 1000)) : null;
  const buyIns = state.phase === "BUY_INS" && state.buyInsEndAt ? Math.max(0, Math.ceil((state.buyInsEndAt - now) / 1000)) : null;

  return (
    <>
      {/*
       * The overlays that black out the table mount and unmount outright. A background tab pauses
       * animation frames, an exit animation never finishes, and the table stays hidden for good.
       */}
      {showRound && fx.round && (
        <motion.div key={`round-${fx.round.at}`} className={`${full} bg-black/80`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
          <motion.p initial={{ y: -30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} className="font-crt text-[3vh] tracking-[0.5em] text-ash">
            THE DEALER LOADS THE GUN
          </motion.p>
          <motion.h2 initial={{ scale: 2.4, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ type: "spring", stiffness: 160, damping: 14 }} className="font-display text-[18vh] leading-none">
            ROUND {fx.round.round + 1}
          </motion.h2>
          <p className="font-crt text-[3vh] tracking-[0.5em] text-ash">OF {fx.round.rounds}</p>
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
          <p className="mt-[1vh] font-type text-[2.6vh] text-bone/70">Order sealed on-chain. Cheat cards dealt. Every live shell costs a chip.</p>
        </motion.div>
      )}

      <AnimatePresence>
        {showShot && fx.shot && (
          <motion.div key={`shot-${fx.shot.at}`} className={full} initial={{ opacity: 1 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            {fx.shot.live && <motion.div className="absolute inset-0 bg-bone" initial={{ opacity: 0.95 }} animate={{ opacity: 0 }} transition={{ duration: 0.45 }} />}
            <motion.h2
              initial={{ scale: fx.shot.live ? 3 : 0.6, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 16 }}
              className={`font-display leading-none ${fx.shot.live ? "text-[26vh] text-blood drop-shadow-[0_0_40px_rgba(224,49,43,0.7)]" : "text-[16vh] text-steel"}`}
            >
              {fx.shot.live ? "BANG" : "click."}
            </motion.h2>
            <p className="rounded-xl bg-black/70 px-6 py-2 font-display text-[4.5vh] tracking-wide">
              {name(fx.shot.shooter)} → {fx.shot.target === fx.shot.shooter ? "themselves" : name(fx.shot.target)}
              {fx.shot.live && <span className="text-brass"> · 1 chip into the pot</span>}
              {fx.shot.again && <span className="text-brass"> · GOES AGAIN</span>}
              {fx.shot.broke && <span className="text-blood"> · 💸 BROKE</span>}
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

      {rigged && <RiggedScene key={`${rigged.accuser}-${rigged.accused}-${state.round}`} state={state} txs={txs} />}

      <AnimatePresence>
        {showBanner && fx.banner && (
          <motion.div
            key={`banner-${fx.banner.at}`}
            className="pointer-events-none fixed inset-x-0 top-[13vh] z-30 flex justify-center"
            initial={{ y: -30, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <p
              className={`rounded-xl border-2 bg-black/85 px-[2vw] py-[0.8vh] font-display text-[3.6vh] tracking-wide ${fx.banner.tone === "money" ? "border-crt text-crt" : "border-brass text-brass"}`}
            >
              {name(fx.banner.seat)} {fx.banner.label}
            </p>
          </motion.div>
        )}
      </AnimatePresence>

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
        {showPot && fx.potAward && (
          <motion.div
            key={`pot-${fx.potAward.at}`}
            className="pointer-events-none fixed inset-x-0 top-[13vh] z-30 flex flex-col items-center"
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="rounded-2xl border-4 border-brass bg-black/85 px-[3vw] py-[1.5vh] text-center">
              <p className="font-crt text-[2.4vh] tracking-[0.4em] text-ash">END OF ROUND {fx.potAward.round + 1}</p>
              {fx.potAward.winners.length ? (
                <p className="font-display text-[6vh] leading-none tracking-wide">
                  🏦 THE POT GOES TO <span className="text-brass">{fx.potAward.winners.map(name).join(" & ")}</span>
                  <span className="block text-[4vh] text-crt">
                    +{fx.potAward.chipsEach} chip{fx.potAward.chipsEach === 1 ? "" : "s"}
                    {fx.potAward.winners.length > 1 ? " each" : ""} ({dollars(fx.potAward.chipsEach * MONEY.chipCents)})
                  </span>
                </p>
              ) : (
                <p className="font-display text-[6vh] leading-none tracking-wide">NOBODY BLED. THE POT IS EMPTY.</p>
              )}
              {fx.potAward.carried > 0 && <p className="font-crt text-[2.4vh] text-ash">{fx.potAward.carried} chip(s) left over roll into the next pot</p>}
              <p className="mt-[0.5vh] font-crt text-[2.2vh] text-ash">The chip leader takes the pot. Settled by the referee on-chain.</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {buyIns !== null && (
          <motion.div
            key="buyins"
            className="pointer-events-none fixed inset-x-0 top-[13vh] z-30 flex flex-col items-center"
            initial={{ y: -40, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <div className="rounded-2xl border-4 border-crt bg-black/90 px-[3vw] py-[1.5vh] text-center">
              <p className="font-display text-[6vh] leading-none tracking-wider">💸 BUY BACK IN?</p>
              <p className="font-type text-[2.8vh] text-bone/80">
                Not enough chips on the table. {dollars(MONEY.buyInCents)} gets you {MONEY.buyInChips} chips. Tap BUY IN on your phone.
              </p>
              <div className="mt-[1vh] flex flex-wrap justify-center gap-[1.5vw] font-crt text-[2.4vh]">
                {state.seats
                  .filter((s) => s.chips === 0)
                  .map((s) => (
                    <span key={s.seat} className={s.cleanedOut ? "text-ash line-through" : "text-brass"}>
                      {s.name} {s.bankrollCents !== null ? `(${dollars(s.bankrollCents)})` : ""}
                    </span>
                  ))}
              </div>
              <p className="font-crt text-[8vh] leading-none text-crt">{buyIns}</p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {showGameOver && fx.gameOver && <GameOver key="gameover" state={state} over={fx.gameOver} />}
    </>
  );
}

function GameOver({ state, over }: { state: PublicState; over: NonNullable<OverlayFx["gameOver"]> }) {
  const name = (i: number) => state.seats[i]?.name ?? `Seat ${i + 1}`;
  const ranked = [...over.results].sort((a, b) => b.profitCents - a.profitCents || a.seat - b.seat);
  const top = over.results.find((r) => r.seat === over.winner);
  return (
    <motion.div className={`${full} bg-black/90`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
      <p className="font-crt text-[3vh] tracking-[0.5em] text-ash">CASHING OUT · {dollars(MONEY.chipCents)} A CHIP</p>
      <div className="my-[2vh] flex items-center gap-[2vw]">
        <motion.div initial={{ scale: 0.4 }} animate={{ scale: 1 }} transition={{ type: "spring" }}>
          <Avatar seat={state.seats[over.winner] ?? { seat: 0, name: "?", kind: "human" }} size={150} />
        </motion.div>
        <div className="text-left">
          <h2 className="font-display text-[11vh] leading-none text-brass">🏆 {name(over.winner)}</h2>
          {top && (
            <p className="font-display text-[5vh] leading-none">
              <Profit cents={top.profitCents} /> <span className="text-ash">profit</span>
            </p>
          )}
        </div>
      </div>
      <table className="font-crt text-[2.8vh]">
        <thead className="text-[2vh] tracking-widest text-ash">
          <tr>
            <th className="px-[1.5vw] text-left">PLAYER</th>
            <th className="px-[1.5vw]">CHIPS</th>
            <th className="px-[1.5vw]">BOUGHT IN</th>
            <th className="px-[1.5vw]">CASHED OUT</th>
            <th className="px-[1.5vw] text-right">PROFIT</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((r, i) => (
            <motion.tr key={r.seat} initial={{ opacity: 0, x: -30 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: 0.3 + i * 0.12 }} className={r.seat === over.winner ? "text-brass" : ""}>
              <td className="px-[1.5vw] text-left font-display tracking-wide">{name(r.seat)}</td>
              <td className="px-[1.5vw]">{r.chips}</td>
              <td className="px-[1.5vw]">
                {dollars(r.spentCents)} <span className="text-ash">×{r.buyIns}</span>
              </td>
              <td className="px-[1.5vw]">{dollars(r.cashOutCents)}</td>
              <td className="px-[1.5vw] text-right">
                <Profit cents={r.profitCents} />
              </td>
            </motion.tr>
          ))}
        </tbody>
      </table>
      <p className="mt-[3vh] animate-pulse font-crt text-[3.5vh] tracking-[0.3em]">◀◀ REWINDING THE TAPE…</p>
    </motion.div>
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
  const moved = r.chipsMoved ?? 0;
  // Accuser on the left, accused on the right. Guilty: the cheater's chips slide left. Innocent: the accuser pays 1, sliding right.
  const payer = r.verdict ? (guilty ? r.accused : r.accuser) : null;

  return (
    <motion.div className={`${full} bg-black/90`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
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
            <div className="relative flex items-center gap-[4vw]">
              <div className="flex flex-col items-center gap-2">
                <Avatar seat={state.seats[r.accuser]} size={140} broke={payer === r.accuser && state.seats[r.accuser]?.chips === 0} />
                <p className="font-display text-[4vh]">{name(r.accuser)}</p>
                <p className="font-crt text-[2.2vh] text-ash">{state.seats[r.accuser]?.chips ?? 0} chips</p>
              </div>
              <div className="relative flex h-[14vh] w-[22vw] items-center justify-center">
                {r.verdict && moved > 0 ? (
                  <ChipSlide n={moved} leftward={guilty} />
                ) : (
                  <motion.p initial={{ x: -30 }} animate={{ x: [0, 20, 0] }} transition={{ repeat: Infinity, duration: 1 }} className="text-[12vh]">
                    👉
                  </motion.p>
                )}
              </div>
              <div className="flex flex-col items-center gap-2">
                <Avatar seat={state.seats[r.accused]} size={140} broke={payer === r.accused && state.seats[r.accused]?.chips === 0} />
                <p className="font-display text-[4vh]">{name(r.accused)}</p>
                <p className="font-crt text-[2.2vh] text-ash">{state.seats[r.accused]?.chips ?? 0} chips</p>
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
                <p className="font-display text-[4.5vh] tracking-wide">
                  {guilty ? (
                    <>
                      {name(r.accused)} hands over <span className="text-brass">all {moved} chip{moved === 1 ? "" : "s"}</span> to {name(r.accuser)}
                    </>
                  ) : (
                    <>
                      {name(r.accuser)} pays {name(r.accused)} <span className="text-brass">1 chip</span> for the slander
                    </>
                  )}
                </p>
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
                    <p className="rounded-lg bg-bone px-5 py-3 font-type text-[3.2vh] text-ink">Every envelope said “nothing.”</p>
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

/** Chips sliding between the two avatars in the RIGGED! scene. */
function ChipSlide({ n, leftward }: { n: number; leftward: boolean }) {
  const from = leftward ? "90%" : "10%";
  const to = leftward ? "10%" : "90%";
  return (
    <>
      {Array.from({ length: Math.min(n, 8) }, (_, i) => (
        <motion.div
          key={i}
          className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2"
          initial={{ left: from, opacity: 0, y: 0 }}
          animate={{ left: to, opacity: [0, 1, 1, 1], y: [0, -40 - i * 4, 0] }}
          transition={{ duration: 0.8, delay: 0.4 + i * 0.14, ease: "easeInOut" }}
        >
          <ChipIcon size={56} color="#e8b13a" />
        </motion.div>
      ))}
      <motion.p
        initial={{ opacity: 0, scale: 0.6 }}
        animate={{ opacity: 1, scale: 1 }}
        transition={{ delay: 0.5 + Math.min(n, 8) * 0.14 }}
        className="absolute -bottom-[3vh] font-display text-[4vh] text-brass"
      >
        {leftward ? "◀" : ""} {n} chip{n === 1 ? "" : "s"} · {dollars(n * MONEY.chipCents)} {leftward ? "" : "▶"}
      </motion.p>
    </>
  );
}
