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

/** Profit in dollars: green up, red down. */
export function Profit({ cents, className = "" }: { cents: number; className?: string }) {
  return (
    <span className={`tabular-nums ${cents > 0 ? "text-crt" : cents < 0 ? "text-blood" : "text-ash"} ${className}`}>
      {cents > 0 ? "+" : ""}
      {dollars(cents)}
    </span>
  );
}

/** A shotgun shell. `live` red, blank steel-blue, `spent` dim. */
export function Shell({ live, spent = false, size = 26, highlight = false }: { live: boolean; spent?: boolean; size?: number; highlight?: boolean }) {
  const body = live ? "#c42a24" : "#5d7488";
  return (
    <svg width={size * 0.5} height={size} viewBox="0 0 20 40" className={spent ? "opacity-25" : ""} aria-label={live ? "live shell" : "blank shell"}>
      <rect x="2" y="2" width="16" height="28" rx="3" fill={body} stroke={highlight ? "#e8b13a" : "#000"} strokeWidth={highlight ? 2.5 : 1} />
      <rect x="4" y="5" width="3" height="22" rx="1.5" fill="#fff" opacity="0.18" />
      <rect x="1" y="29" width="18" height="9" rx="1.5" fill="#b8912f" stroke="#000" strokeWidth="1" />
      <circle cx="10" cy="33.5" r="2.5" fill="#6b5418" />
    </svg>
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
