"use client";

import { BOTS, SEAT_COLORS, dollars, type Seat } from "@blankcheck/shared";
import { AnimatePresence, motion } from "motion/react";

/** One poker chip, seen from above: a coloured disc with an edge-spot ring. */
export function ChipIcon({ size = 24, color = "#e0312b", className = "" }: { size?: number; color?: string; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" className={className} aria-hidden>
      <circle cx="20" cy="20" r="19" fill={color} stroke="#000" strokeWidth="1.5" />
      <circle cx="20" cy="20" r="15.5" fill="none" stroke="#efe6d2" strokeWidth="5" strokeDasharray="6.1 6.1" />
      <circle cx="20" cy="20" r="11" fill={color} stroke="#000" strokeOpacity="0.35" strokeWidth="1" />
      <circle cx="20" cy="20" r="8" fill="none" stroke="#efe6d2" strokeOpacity="0.55" strokeWidth="1" strokeDasharray="2 2" />
    </svg>
  );
}

/** A small overlapping stack of chips with the count beside it. */
export function Chips({ n, size = 22, max = 8, color, className = "" }: { n: number; size?: number; max?: number; color?: string; className?: string }) {
  const shown = Math.min(n, max);
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`} aria-label={`${n} chip${n === 1 ? "" : "s"}`}>
      <span className="inline-flex items-center" style={{ minWidth: size }}>
        <AnimatePresence initial={false}>
          {Array.from({ length: shown }, (_, i) => (
            <motion.span
              key={i}
              initial={{ y: -size, opacity: 0, scale: 1.3 }}
              animate={{ y: 0, opacity: 1, scale: 1 }}
              exit={{ y: -size * 0.8, opacity: 0, scale: 0.7 }}
              transition={{ type: "spring", stiffness: 420, damping: 22 }}
              style={{ marginLeft: i === 0 ? 0 : -size * 0.62 }}
            >
              <ChipIcon size={size} color={color} />
            </motion.span>
          ))}
        </AnimatePresence>
        {n === 0 && <ChipIcon size={size} color="#3a3531" className="opacity-40" />}
      </span>
      <motion.span key={n} initial={{ scale: 1.5 }} animate={{ scale: 1 }} className="font-display tabular-nums leading-none" style={{ fontSize: size * 0.95 }}>
        {n}
      </motion.span>
    </span>
  );
}

export function GameTitle({ className = "" }: { className?: string }) {
  return (
    <span className={`vhs-title ${className}`}>
      GAMBIT <span className="text-blood">RODEO</span>
    </span>
  );
}

const CONFETTI_COLORS = ["#e0312b", "#e8b13a", "#7dffa8", "#4ea8de", "#9b5de5", "#efe6d2", "#e4572e"];

function bits(seed: number, n: number, spread: number) {
  const out: { color: string; w: number; h: number; dx: number; dy: number; rot: number; delay: number }[] = [];
  let s = Math.abs(seed % 2147483646) + 1;
  for (let i = 0; i < n; i++) {
    s = (s * 16807 + i * 97) % 2147483647;
    const u = s / 2147483647;
    s = (s * 48271) % 2147483647;
    const v = s / 2147483647;
    out.push({
      color: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
      w: 5 + (i % 5) * 2,
      h: 9 + (i % 4) * 3,
      dx: (u - 0.5) * spread,
      dy: -20 - v * spread * 0.65,
      rot: (u - 0.5) * 540,
      delay: (i % 7) * 0.03,
    });
  }
  return out;
}

export function ConfettiBurst({ n = 18, seed = 1, spread = 220, className = "" }: { n?: number; seed?: number; spread?: number; className?: string }) {
  return (
    <div className={`pointer-events-none absolute inset-0 overflow-visible ${className}`} aria-hidden>
      {bits(seed, n, spread).map((b, i) => (
        <motion.span
          key={i}
          className="absolute left-1/2 top-1/2 rounded-[1px]"
          style={{ width: b.w, height: b.h, background: b.color, marginLeft: -b.w / 2, marginTop: -b.h / 2 }}
          initial={{ x: 0, y: 0, opacity: 1, rotate: 0, scale: 1 }}
          animate={{ x: b.dx, y: b.dy, opacity: 0, rotate: b.rot, scale: 0.35 }}
          transition={{ duration: 0.85, delay: b.delay, ease: "easeOut" }}
        />
      ))}
    </div>
  );
}

/** Profit in dollars: green up, red down. */
export function Profit({ cents, className = "" }: { cents: number; className?: string }) {
  return (
    <span className={`tabular-nums ${cents > 0 ? "text-crt" : cents < 0 ? "text-blood" : "text-ash"} ${className}`}>
      {cents > 0 ? "+" : ""}
      {dollars(cents)}
    </span>
  );
}

/**
 * A live (red) or blank (steel-blue) charge. `spent` greys it out and tips it over.
 * `mystery` keeps the silhouette but hides which it is — nothing about the body may hint at `live`.
 */
export function Shell({
  live,
  spent = false,
  size = 26,
  highlight = false,
  mystery = false,
}: {
  live: boolean;
  spent?: boolean;
  size?: number;
  highlight?: boolean;
  mystery?: boolean;
}) {
  const body = mystery ? "#3a2f20" : live ? "#c42a24" : "#5d7488";
  return (
    <span className={`inline-block origin-bottom ${spent ? "rotate-[22deg] opacity-40 grayscale" : ""}`}>
      <svg width={size * 0.5} height={size} viewBox="0 0 20 40" aria-label={mystery ? "face-down shell" : live ? "live shell" : "blank shell"}>
        <rect x="2" y="2" width="16" height="28" rx="3" fill={body} stroke={highlight ? "#e8b13a" : "#000"} strokeWidth={highlight ? 2.5 : 1} />
        {mystery ? (
          <text x="10" y="16.5" textAnchor="middle" dominantBaseline="central" fontSize="17" fill="#e8b13a" className="font-display">
            ?
          </text>
        ) : (
          <rect x="4" y="5" width="3" height="22" rx="1.5" fill="#fff" opacity="0.18" />
        )}
        <rect x="1" y="29" width="18" height="9" rx="1.5" fill="#b8912f" stroke="#000" strokeWidth="1" />
        <circle cx="10" cy="33.5" r="2.5" fill="#6b5418" />
      </svg>
    </span>
  );
}

/** `broke`: out of chips (greyed). `ghost`: cleaned out for good. */
export function Avatar({
  seat,
  size = 64,
  broke = false,
  ghost = false,
}: {
  seat: Pick<Seat, "seat" | "name" | "kind" | "personality">;
  size?: number;
  broke?: boolean;
  ghost?: boolean;
}) {
  const color = SEAT_COLORS[seat.seat % SEAT_COLORS.length];
  const dim = broke || ghost;
  const label = seat.kind === "bot" && seat.personality ? BOTS[seat.personality].emoji : seat.name.slice(0, 1).toUpperCase();
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-display ${dim ? "grayscale" : ""} ${broke && !ghost ? "opacity-60" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.48,
        background: `radial-gradient(circle at 35% 30%, ${color}, ${color}55 70%)`,
        border: `3px solid ${color}`,
        boxShadow: dim ? "none" : `0 0 ${size / 3}px ${color}55`,
      }}
    >
      {ghost ? "👻" : label}
    </div>
  );
}

export function shortAddr(a: string | null | undefined, n = 6): string {
  if (!a) return "";
  return a.length > 2 * n + 1 ? `${a.slice(0, n)}…${a.slice(-4)}` : a;
}

export function seatColor(seat: number): string {
  return SEAT_COLORS[seat % SEAT_COLORS.length];
}
