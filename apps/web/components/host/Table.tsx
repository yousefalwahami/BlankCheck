"use client";

import { MONEY, dollars, type PitBossReading, type PublicState } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";
import { Avatar, ChipIcon, Chips, ConfettiBurst, Shell, seatColor } from "../ui/bits";

export type SeatFx = { kind: "hit" | "miss" | "boo" | "buyIn"; at: number };

/** Chips sliding across the felt: a seat into the pot, the pot to a winner, a cheater to their accuser. */
export type Flight = { id: number; from: number | "pot"; to: number | "pot"; n: number; delay?: number };

const POT = { x: 50, y: 50 };

function seatPos(i: number, n: number) {
  const theta = Math.PI / 2 + (i * 2 * Math.PI) / n; // seat 0 at the bottom, clockwise
  return { x: 50 + 41 * Math.cos(theta), y: 50 + 37 * Math.sin(theta), theta };
}

export function ShellBoard({ state }: { state: PublicState }) {
  const { announced, fired, countIsOff } = state;
  const liveOver = fired.live > announced.live;
  const blankOver = fired.blank > announced.blank;
  const shells = [...Array(announced.live).fill(1), ...Array(announced.blank).fill(0)] as (0 | 1)[];
  return (
    <div className="flex items-center gap-[2vw] rounded-2xl border border-bone/10 bg-black/50 px-[2vw] py-[1vh] font-crt text-[2.6vh]">
      <div className="text-center">
        <p className="text-[1.8vh] tracking-[0.3em] text-ash">ROUND</p>
        <p className="font-display text-[4vh] leading-none">
          {state.round + 1}
          <span className="text-[2.4vh] text-ash">/{state.config.rounds}</span>
        </p>
      </div>
      <div className="h-[6vh] w-px bg-bone/15" />
      <div>
        <p className="text-[1.8vh] tracking-[0.3em] text-ash">ANNOUNCED</p>
        <p>
          <span className="text-blood">{announced.live} LIVE</span> · <span className="text-steel">{announced.blank} BLANK</span>
        </p>
      </div>
      <div className="flex items-end gap-1">
        {shells.map((s, i) => (
          <Shell key={i} live={s === 1} size={34} />
        ))}
      </div>
      <div className="h-[6vh] w-px bg-bone/15" />
      <div>
        <p className="text-[1.8vh] tracking-[0.3em] text-ash">FIRED</p>
        <p>
          <span className={liveOver ? "animate-pulse font-bold text-brass" : "text-blood"}>
            LIVE {fired.live}/{announced.live}
            {liveOver ? " ⚠" : ""}
          </span>{" "}
          ·{" "}
          <span className={blankOver ? "animate-pulse font-bold text-brass" : "text-steel"}>
            BLANK {fired.blank}/{announced.blank}
            {blankOver ? " ⚠" : ""}
          </span>
        </p>
      </div>
      <div className="h-[6vh] w-px bg-bone/15" />
      <div className="text-center">
        <p className="text-[1.8vh] tracking-[0.3em] text-ash">IN THE TUBE</p>
        <p className="font-display text-[4vh] leading-none">{state.shellsLeft}</p>
      </div>
      <div className="h-[6vh] w-px bg-bone/15" />
      <div className="text-center">
        <p className="text-[1.8vh] tracking-[0.3em] text-ash">POT</p>
        <Chips n={state.pot} size={30} max={5} color="#e8b13a" className="text-brass" />
      </div>
      <AnimatePresence>
        {countIsOff && (
          <motion.div
            initial={{ scale: 1.6, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            className="rounded-lg border-2 border-brass px-3 py-1 font-display text-[2.6vh] tracking-wider text-brass"
          >
            ⚠ THE COUNT IS OFF
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

const POP_STREAM = [
  { color: "#e0312b", y: -14, rot: 80, delay: 0 },
  { color: "#e8b13a", y: 8, rot: -50, delay: 0.08 },
  { color: "#7dffa8", y: -4, rot: 140, delay: 0.16 },
  { color: "#4ea8de", y: 16, rot: -110, delay: 0.04 },
  { color: "#9b5de5", y: -18, rot: 40, delay: 0.22 },
  { color: "#efe6d2", y: 2, rot: -20, delay: 0.12 },
  { color: "#e4572e", y: 12, rot: 200, delay: 0.28 },
  { color: "#e8b13a", y: -10, rot: -160, delay: 0.18 },
];

function ConfettiPopper({ angle, raised }: { angle: number; raised: boolean }) {
  return (
    <motion.div
      className="absolute left-1/2 top-1/2 z-10"
      style={{ width: 0, height: 0 }}
      animate={{ rotate: angle, scale: raised ? 1.1 : 1 }}
      transition={{ type: "spring", stiffness: 70, damping: 14 }}
    >
      <svg width="300" height="90" viewBox="0 0 300 90" style={{ transform: "translate(-92px, -45px)" }} aria-hidden>
        <defs>
          <linearGradient id="pop-wood" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#c9843a" />
            <stop offset="1" stopColor="#6b3a14" />
          </linearGradient>
          <linearGradient id="pop-body" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#e8b13a" />
            <stop offset="0.35" stopColor="#e0312b" />
            <stop offset="0.7" stopColor="#29a19c" />
            <stop offset="1" stopColor="#e8b13a" />
          </linearGradient>
          <linearGradient id="pop-cone" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#c42a24" />
            <stop offset="1" stopColor="#f3a712" />
          </linearGradient>
          <pattern id="pop-stripes" width="18" height="18" patternUnits="userSpaceOnUse" patternTransform="rotate(28)">
            <rect width="18" height="18" fill="#c42a24" />
            <rect width="9" height="18" fill="#e8b13a" />
          </pattern>
        </defs>
        <path d="M8 38 L54 32 L70 36 L70 56 L50 62 L14 68 L8 58 Z" fill="url(#pop-wood)" stroke="#000" strokeWidth="2" />
        <circle cx="22" cy="72" r="7" fill="none" stroke="#e8b13a" strokeWidth="3" />
        <path d="M22 65 v-8" stroke="#e8b13a" strokeWidth="2" />
        <rect x="66" y="30" width="78" height="32" rx="8" fill="url(#pop-stripes)" stroke="#000" strokeWidth="2" />
        <rect x="66" y="30" width="78" height="32" rx="8" fill="url(#pop-body)" opacity="0.35" />
        <rect x="72" y="34" width="10" height="24" rx="2" fill="#efe6d2" opacity="0.25" />
        <path d="M142 24 L248 10 L248 82 L142 68 Z" fill="url(#pop-cone)" stroke="#000" strokeWidth="2" />
        <path d="M142 24 L248 10 L248 82 L142 68 Z" fill="url(#pop-stripes)" opacity="0.35" />
        <ellipse cx="248" cy="46" rx="10" ry="36" fill="#e8b13a" stroke="#000" strokeWidth="2" />
        <ellipse cx="252" cy="46" rx="5" ry="28" fill="#1a120c" />
        <path d="M248 14 q18 -10 28 2" fill="none" stroke="#efe6d2" strokeWidth="3" />
        <path d="M248 78 q16 10 26 -4" fill="none" stroke="#7dffa8" strokeWidth="3" />
        <circle cx="108" cy="46" r="7" fill="#efe6d2" stroke="#000" strokeWidth="1.5" />
        <path d="M108 41 l1.5 3.2 3.5.3-2.7 2.3.8 3.4-3.1-1.9-3.1 1.9.8-3.4-2.7-2.3 3.5-.3 Z" fill="#e0312b" />
      </svg>
      {raised &&
        POP_STREAM.map((p, i) => (
          <motion.span
            key={i}
            className="absolute rounded-[1px]"
            style={{ left: 168, top: 0, width: 7 + (i % 3), height: 11 + (i % 4) * 2, background: p.color, marginTop: -6 }}
            initial={{ x: 0, y: 0, opacity: 0, rotate: 0 }}
            animate={{ x: [0, 70, 130], y: [0, p.y, p.y * 1.6], opacity: [0, 1, 0], rotate: [0, p.rot] }}
            transition={{ duration: 0.55, delay: p.delay, repeat: Infinity, ease: "easeOut" }}
          />
        ))}
    </motion.div>
  );
}

/** The pot: a messy pile of chips in the middle of the felt, under the popper. */
function PotPile({ n }: { n: number }) {
  const pile = Array.from({ length: Math.min(n, 14) }, (_, i) => ({
    x: Math.sin(i * 2.4) * (10 + i * 3.2),
    y: Math.cos(i * 2.4) * (6 + i * 2),
    r: (i * 47) % 360,
  }));
  return (
    <div className="absolute z-0" style={{ left: `${POT.x}%`, top: `${POT.y}%` }}>
      <AnimatePresence>
        {pile.map((c, i) => (
          <motion.div
            key={i}
            className="absolute"
            initial={{ scale: 0, opacity: 0 }}
            animate={{ scale: 1, opacity: 1, rotate: c.r }}
            exit={{ scale: 0, opacity: 0 }}
            style={{ left: c.x - 17, top: c.y - 17 }}
          >
            <ChipIcon size={34} color={i % 3 === 0 ? "#e8b13a" : i % 3 === 1 ? "#e0312b" : "#1f5f8b"} />
          </motion.div>
        ))}
      </AnimatePresence>
      {n > 0 && (
        <div className="absolute left-0 top-[6vh] -translate-x-1/2 whitespace-nowrap rounded-full bg-black/70 px-3 py-0.5 font-crt text-[2.2vh] text-brass">
          POT {n} · {dollars(n * MONEY.chipCents)}
        </div>
      )}
    </div>
  );
}

function FlightView({ f, n }: { f: Flight; n: number }) {
  const at = (p: number | "pot") => (p === "pot" ? POT : seatPos(p, n));
  const a = at(f.from);
  const b = at(f.to);
  return (
    <>
      {Array.from({ length: Math.min(f.n, 6) }, (_, i) => (
        <motion.div
          key={i}
          className="pointer-events-none absolute z-30 -translate-x-1/2 -translate-y-1/2"
          initial={{ left: `${a.x}%`, top: `${a.y}%`, scale: 0.6, opacity: 0 }}
          animate={{ left: `${b.x}%`, top: `${b.y}%`, scale: [0.6, 1.5, 1], opacity: [0, 1, 1, 0] }}
          transition={{ duration: 0.9, delay: (f.delay ?? 0) + i * 0.09, ease: "easeInOut" }}
        >
          <ChipIcon size={38} color="#e8b13a" />
        </motion.div>
      ))}
    </>
  );
}

export function Table(props: {
  state: PublicState;
  pit: PitBossReading;
  taunts: Record<number, { text: string; at: number }>;
  seatFx: Record<number, SeatFx>;
  flights: Flight[];
}) {
  const { state } = props;
  const n = state.seats.length;
  const target = state.aimingAt;
  const cur = state.currentSeat;
  const pointAt = target ?? cur;
  const popAngle = n ? (seatPos(pointAt, n).theta * 180) / Math.PI : 90;
  const aiming = target !== null && (state.phase === "AWAIT_TRIGGER" || state.phase === "RESOLVING");
  const showPit = Object.keys(props.pit).length > 0;
  const betweenRounds = ["LAST_CALL", "ROUND_END", "BUY_INS", "OVER", "TAPE", "ROUND_START"].includes(state.phase);

  return (
    <div className="relative h-full w-full">
      <div className="felt absolute left-[14%] right-[14%] top-[16%] bottom-[16%] rounded-[50%] border-[10px] border-[#2a1a0e]" />
      <PotPile n={state.pot} />
      <ConfettiPopper angle={popAngle} raised={aiming} />
      {props.flights.map((f) => (
        <FlightView key={f.id} f={f} n={n} />
      ))}

      {state.seats.map((s) => {
        const p = seatPos(s.seat, n);
        const isCur = s.seat === cur && !betweenRounds;
        const isTarget = aiming && s.seat === target;
        const broke = s.chips <= 0;
        const busted = state.busted.includes(s.seat);
        const fx = props.seatFx[s.seat];
        const recentFx = fx && Date.now() - fx.at < 1500 ? fx : null;
        const taunt = props.taunts[s.seat];
        const sus = props.pit[s.seat];
        return (
          <motion.div
            key={s.seat}
            className="absolute z-20 flex w-[18vw] -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-[0.6vh] text-center"
            style={{ left: `${p.x}%`, top: `${p.y}%` }}
            animate={recentFx?.kind === "hit" || recentFx?.kind === "boo" ? { x: [0, -14, 14, -10, 10, 0] } : { x: 0 }}
            transition={{ duration: 0.5 }}
          >
            <AnimatePresence>
              {taunt && Date.now() - taunt.at < 3500 && (
                <motion.div
                  key={taunt.at}
                  initial={{ opacity: 0, y: 10, scale: 0.9 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0 }}
                  className="absolute -top-[7vh] z-30 max-w-[20vw] rounded-xl bg-bone px-3 py-1.5 font-type text-[1.9vh] leading-tight text-ink shadow-lg"
                >
                  “{taunt.text}”
                </motion.div>
              )}
            </AnimatePresence>
            <div className="relative">
              {isCur && (
                <motion.div
                  layoutId="spotlight"
                  className="absolute -inset-[1.6vh] rounded-full"
                  style={{ background: `radial-gradient(circle, ${seatColor(s.seat)}55, transparent 70%)` }}
                  transition={{ type: "spring", stiffness: 120, damping: 18 }}
                />
              )}
              {isTarget && <div className="absolute -inset-[1vh] animate-ping rounded-full border-4 border-blood" />}
              <div className="relative">
                <Avatar seat={s} size={88} broke={broke} ghost={s.cleanedOut} />
              </div>
              {recentFx?.kind === "hit" && <ConfettiBurst n={22} seed={s.seat + 3} />}
              {recentFx?.kind === "miss" && (
                <motion.div initial={{ scale: 0.7, opacity: 0.9 }} animate={{ scale: 1.4, opacity: 0 }} transition={{ duration: 0.7 }} className="absolute inset-0 text-center text-[4vh]">
                  💨
                </motion.div>
              )}
              {recentFx?.kind === "buyIn" && (
                <motion.div
                  initial={{ y: 0, opacity: 1, scale: 1 }}
                  animate={{ y: -60, opacity: 0, scale: 1.4 }}
                  transition={{ duration: 1.4 }}
                  className="absolute inset-x-0 top-0 whitespace-nowrap text-center font-display text-[3.4vh] text-crt"
                >
                  +3 🪙
                </motion.div>
              )}
            </div>
            <p className={`font-display text-[3vh] leading-none tracking-wide ${s.cleanedOut ? "text-ash line-through" : ""}`}>{s.name}</p>
            {s.cleanedOut ? (
              <span className="stamp -rotate-3 border-[3px] px-1 text-[2vh] text-ash">CLEANED OUT</span>
            ) : broke ? (
              <span className="animate-pulse rounded-md border-2 border-brass px-2 font-display text-[2.2vh] tracking-wider text-brass">BROKE · BUY IN?</span>
            ) : (
              <Chips n={s.chips} size={26} color={seatColor(s.seat)} />
            )}
            <div className="flex h-[3vh] items-center gap-2 font-crt text-[1.8vh]">
              {busted && <span className="stamp -rotate-6 border-[3px] px-1 text-[2vh] text-blood">BUSTED</span>}
              {!s.connected && s.kind === "human" && <span className="text-ash">📵</span>}
              {s.walletReady && s.kind === "human" && <span title="Face ID wallet">🔐</span>}
              {s.bankrollCents !== null && <span className="text-ash" title="Left in their wallet">{dollars(s.bankrollCents)}</span>}
              {state.accuseUsed.includes(s.seat) && !busted && <span className="text-ash">called it</span>}
            </div>
            {showPit && !broke && (
              <div className="w-[9vw]" title="Pit Boss suspicion">
                <div className="h-[0.9vh] overflow-hidden rounded-full bg-bone/10">
                  <motion.div
                    className="h-full rounded-full"
                    animate={{ width: `${Math.round((sus ?? 0.1) * 100)}%`, backgroundColor: (sus ?? 0) > 0.6 ? "#e0312b" : (sus ?? 0) > 0.35 ? "#e8b13a" : "#7dffa8" }}
                    transition={{ type: "spring", stiffness: 60, damping: 16 }}
                  />
                </div>
              </div>
            )}
          </motion.div>
        );
      })}
    </div>
  );
}
