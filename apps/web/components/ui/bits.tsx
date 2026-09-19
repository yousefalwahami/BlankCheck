"use client";

import { BOTS, SEAT_COLORS, type Seat } from "@blankcheck/shared";
import { motion } from "motion/react";

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

/** A live (red) or blank (steel-blue) charge. `spent` dims it. */
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
