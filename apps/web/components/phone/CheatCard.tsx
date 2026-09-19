"use client";

import { CHEAT_INFO, type CheatCode } from "@blankcheck/shared";
import { motion } from "motion/react";
import { useRef, useState } from "react";

/**
 * The secret card: face down. Press and hold to peek (so your neighbour can't see), swipe up while
 * holding to play it. No Face ID here: raising your phone to your face would give you away.
 */
export function CheatCard(props: { card: CheatCode | null; used: boolean; playedOn: number | null; canCheat: boolean; onPlay: () => void }) {
  const [holding, setHolding] = useState(false);
  const [dy, setDy] = useState(0);
  const startY = useRef<number | null>(null);
  const played = useRef(false);

  if (props.card === null) {
    return <div className="h-40 rounded-2xl border border-dashed border-bone/10 p-4 text-center font-crt text-lg text-ash/60">No card this round.</div>;
  }
  const info = CHEAT_INFO[props.card];

  if (props.used) {
    return (
      <div className="flex h-40 items-center gap-4 rounded-2xl border border-bone/10 bg-soot/60 p-4 opacity-70">
        <span className="text-5xl grayscale">{info.emoji}</span>
        <div>
          <p className="font-display text-2xl tracking-wide">{info.name} · PLAYED</p>
          <p className="font-crt text-lg text-ash">on shell #{(props.playedOn ?? 0) + 1}. Keep a straight face.</p>
        </div>
      </div>
    );
  }

  const end = () => {
    setHolding(false);
    setDy(0);
    startY.current = null;
  };

  return (
    <div
      className="no-select relative h-40 touch-none"
      onContextMenu={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        startY.current = e.clientY;
        played.current = false;
        setHolding(true);
      }}
      onPointerMove={(e) => {
        if (startY.current === null) return;
        const d = Math.min(0, e.clientY - startY.current);
        setDy(d);
        if (d < -90 && props.canCheat && !played.current) {
          played.current = true;
          navigator.vibrate?.(30);
          props.onPlay();
          end();
        }
      }}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <motion.div
        className="absolute inset-0"
        style={{ perspective: 800 }}
        animate={{ y: dy, scale: holding ? 1.03 : 1 }}
        transition={{ type: "spring", stiffness: 500, damping: 30 }}
      >
        <motion.div
          className="relative h-full w-full"
          style={{ transformStyle: "preserve-3d" }}
          animate={{ rotateX: holding ? 180 : 0 }}
          transition={{ duration: 0.25 }}
        >
          <div
            className="absolute inset-0 flex items-center justify-center rounded-2xl border-2 border-bone/20 bg-[repeating-linear-gradient(45deg,#2a1414_0_10px,#1a0c0c_10px_20px)]"
            style={{ backfaceVisibility: "hidden" }}
          >
            <p className="font-display text-2xl tracking-[0.2em] text-bone/60">HOLD TO PEEK</p>
          </div>
          <div
            className="absolute inset-0 flex items-center gap-4 rounded-2xl border-2 border-brass bg-bone p-4 text-ink"
            style={{ backfaceVisibility: "hidden", transform: "rotateX(180deg)" }}
          >
            <span className="text-6xl">{info.emoji}</span>
            <div className="min-w-0">
              <p className="font-display text-3xl tracking-wide">{info.name}</p>
              <p className="font-type text-base leading-tight">{info.blurb}</p>
              <p className={`mt-1 font-crt text-lg ${props.canCheat ? "text-blood" : "text-ink/50"}`}>{props.canCheat ? "↑ swipe up to play" : "can't play right now"}</p>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
