"use client";

import { BOTS, SEAT_COLORS, type Seat } from "@blankcheck/shared";
import { motion } from "motion/react";

export function Hearts({ n, max, size = "text-2xl" }: { n: number; max: number; size?: string }) {
  return (
    <span className={`inline-flex gap-0.5 ${size}`} aria-label={`${n} of ${max} hearts`}>
      {Array.from({ length: max }, (_, i) => (
        <motion.span
          key={i}
          initial={false}
          animate={i < n ? { scale: 1, opacity: 1, filter: "grayscale(0)" } : { scale: 0.8, opacity: 0.25, filter: "grayscale(1)" }}
          transition={{ type: "spring", stiffness: 400, damping: 18 }}
        >
          ❤️
        </motion.span>
      ))}
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

export function Avatar({ seat, size = 64 }: { seat: Pick<Seat, "seat" | "name" | "kind" | "personality" | "hearts">; size?: number }) {
  const color = SEAT_COLORS[seat.seat % SEAT_COLORS.length];
  const dead = seat.hearts <= 0;
  const label = seat.kind === "bot" && seat.personality ? BOTS[seat.personality].emoji : seat.name.slice(0, 1).toUpperCase();
  return (
    <div
      className={`flex shrink-0 items-center justify-center rounded-full font-display ${dead ? "grayscale" : ""}`}
      style={{
        width: size,
        height: size,
        fontSize: size * 0.48,
        background: `radial-gradient(circle at 35% 30%, ${color}, ${color}55 70%)`,
        border: `3px solid ${color}`,
        boxShadow: dead ? "none" : `0 0 ${size / 3}px ${color}55`,
      }}
    >
      {dead ? "👻" : label}
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
