"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";

/** Paper = an ordinary sealed envelope, guilty = a red wax seal, clean = a green one. */
export type EnvelopeTone = "paper" | "guilty" | "clean";

/** One envelope leaving a seat for the evidence jar. */
export type SealFlight = { id: number; from: number; delay?: number };

const SEAL_COLOR: Record<EnvelopeTone, string> = { paper: "#e8b13a", guilty: "#e0312b", clean: "#7dffa8" };
const PAPER = "#efe6d2";
const INK = "#1a120c";

/** A sealed envelope seen flat-on. `w` is the width in px; the height follows. */
export function EnvelopeGlyph({ w = 64, tone = "paper", className = "" }: { w?: number; tone?: EnvelopeTone; className?: string }) {
  return (
    <svg width={w} height={w * 0.66} viewBox="0 0 120 80" className={className} aria-hidden>
      <rect x="2" y="2" width="116" height="76" rx="5" fill={PAPER} stroke={INK} strokeWidth="3" />
      <path d="M2 2 L60 46 L118 2" fill="none" stroke={INK} strokeWidth="3" />
      <path d="M2 78 L44 40 M118 78 L76 40" stroke={INK} strokeWidth="2" opacity="0.4" />
      <circle cx="60" cy="44" r="11" fill={SEAL_COLOR[tone]} stroke={INK} strokeWidth="2" />
      <path d="M60 38 l1.9 3.9 4.3.5-3.2 2.9 1 4.2-4-2.4-4 2.4 1-4.2-3.2-2.9 4.3-.5 Z" fill={INK} opacity="0.65" />
    </svg>
  );
}

/**
 * An envelope that opens: the flap swings back and the letter inside rises out with `children` on it.
 * The flap is a 3D rotation, so this needs real layout — don't shrink it below ~200px wide.
 */
export function EnvelopeReveal({
  w = 320,
  open,
  tone = "paper",
  delay = 0,
  className = "",
  children,
}: {
  w?: number;
  open: boolean;
  tone?: EnvelopeTone;
  delay?: number;
  className?: string;
  children?: ReactNode;
}) {
  const h = w * 0.66;
  const seal = SEAL_COLOR[tone];
  return (
    <div className={`relative ${className}`} style={{ width: w, height: h, perspective: 1200 }}>
      {/* The letter: hidden in the pocket, then lifted clear of the envelope. */}
      <motion.div
        className="absolute inset-x-[4%] bottom-[14%] z-10 origin-bottom"
        initial={{ y: 0, opacity: 0, scale: 0.9 }}
        animate={open ? { y: -h * 0.92, opacity: 1, scale: 1 } : { y: 0, opacity: 0, scale: 0.9 }}
        transition={{ delay: delay + 0.45, type: "spring", stiffness: 90, damping: 16 }}
      >
        <div className="rounded-md border-2 border-black/70 bg-bone px-[4%] py-[3%] text-center font-type text-ink shadow-[0_10px_30px_rgba(0,0,0,0.6)]">
          {children}
        </div>
      </motion.div>

      {/* The pocket: front of the envelope, drawn over the letter so it slides out from behind. */}
      <svg viewBox="0 0 120 80" className="absolute inset-0 z-20 h-full w-full" aria-hidden>
        <rect x="2" y="2" width="116" height="76" rx="5" fill={PAPER} stroke={INK} strokeWidth="3" />
        <path d="M2 78 L60 34 L118 78 Z" fill={PAPER} stroke={INK} strokeWidth="3" />
        <path d="M2 78 L44 44 M118 78 L76 44" stroke={INK} strokeWidth="2" opacity="0.35" />
      </svg>

      {/* The flap, hinged on the top edge. */}
      <motion.div
        className="absolute inset-x-0 top-0 z-30 h-[60%] origin-top"
        style={{ transformStyle: "preserve-3d" }}
        initial={{ rotateX: 0 }}
        animate={{ rotateX: open ? -172 : 0 }}
        transition={{ delay, type: "spring", stiffness: 120, damping: 15 }}
      >
        <svg viewBox="0 0 120 48" preserveAspectRatio="none" className="h-full w-full" aria-hidden>
          <path d="M2 2 L60 46 L118 2 Z" fill="#e2d6bd" stroke={INK} strokeWidth="3" />
        </svg>
        {!open && (
          <span className="absolute left-1/2 top-full -translate-x-1/2 -translate-y-1/2">
            <svg width={w * 0.19} height={w * 0.19} viewBox="0 0 40 40" aria-hidden>
              <circle cx="20" cy="20" r="18" fill={seal} stroke={INK} strokeWidth="2.5" />
              <path d="M20 9 l3.2 6.6 7.3.9-5.4 4.9 1.7 7.1-6.8-4-6.8 4 1.7-7.1-5.4-4.9 7.3-.9 Z" fill={INK} opacity="0.6" />
            </svg>
          </span>
        )}
      </motion.div>
    </div>
  );
}

/**
 * The glass evidence jar in the middle of the felt: every envelope the table seals lands in here,
 * and nobody may look inside until someone slams RIGGED!
 */
export function EvidenceJar({ sealed, w = 120, shake = false }: { sealed: number; w?: number; shake?: boolean }) {
  const h = w * 1.15;
  const stacked = Math.min(sealed, 9);
  return (
    <motion.div className="relative" style={{ width: w, height: h }} animate={shake ? { rotate: [0, -3, 3, -2, 0] } : { rotate: 0 }} transition={{ duration: 0.5 }}>
      {/* Envelopes heaped on the bottom of the jar: three to a layer, jittered so the pile reads as paper. */}
      <div className="absolute inset-0 z-10">
        {Array.from({ length: stacked }, (_, i) => (
          <motion.div
            key={i}
            className="absolute left-1/2"
            initial={{ y: -h * 0.4, opacity: 0, rotate: 0 }}
            animate={{ y: 0, opacity: 1, rotate: ((i * 53) % 28) - 14 }}
            transition={{ type: "spring", stiffness: 140, damping: 14 }}
            style={{
              bottom: h * 0.1 + Math.floor(i / 3) * w * 0.14,
              marginLeft: -w * 0.27 + (((i * 37) % 22) - 11) * (w / 120),
            }}
          >
            <EnvelopeGlyph w={w * 0.54} />
          </motion.div>
        ))}
      </div>
      {/* The glass. */}
      <svg viewBox="0 0 120 138" className="absolute inset-0 z-20 h-full w-full" aria-hidden>
        <defs>
          <linearGradient id="jar-glass" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#dff3ff" stopOpacity="0.30" />
            <stop offset="0.28" stopColor="#ffffff" stopOpacity="0.10" />
            <stop offset="0.55" stopColor="#9fd6ef" stopOpacity="0.16" />
            <stop offset="1" stopColor="#dff3ff" stopOpacity="0.34" />
          </linearGradient>
        </defs>
        <path d="M16 26 L104 26 L98 128 Q60 136 22 128 Z" fill="url(#jar-glass)" stroke="#cfeaf7" strokeOpacity="0.55" strokeWidth="2.5" />
        <path d="M28 34 L34 124" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="4" strokeLinecap="round" />
        <rect x="10" y="14" width="100" height="16" rx="6" fill="#b9892f" stroke="#1a120c" strokeWidth="2.5" />
        <rect x="10" y="14" width="100" height="6" rx="3" fill="#e8b13a" opacity="0.7" />
      </svg>
    </motion.div>
  );
}
