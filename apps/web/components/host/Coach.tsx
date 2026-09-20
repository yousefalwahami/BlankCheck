"use client";

import { sfx } from "@/lib/sounds";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { EnvelopeGlyph } from "../ui/envelope";

const BEAT_ONE = 3000;
const BEAT_TWO = 4500;

const card = "pointer-events-none rounded-2xl border-4 bg-black/85 px-[3vw] py-[2vh]";

/**
 * The one-time teaching moment: envelopes, then the accusation. It rides under the table as a
 * lower-third so the shot playing above it is never hidden, and it never comes back.
 */
export function Coach({ onDone }: { onDone: () => void }) {
  const [beat, setBeat] = useState<1 | 2>(1);
  const done = useRef(onDone);
  done.current = onDone;
  const fired = useRef(false);

  useEffect(() => {
    sfx.card();
    const timers = [
      setTimeout(() => {
        setBeat(2);
        sfx.rigged();
      }, BEAT_ONE),
      setTimeout(() => {
        if (fired.current) return;
        fired.current = true;
        done.current();
      }, BEAT_ONE + BEAT_TWO),
    ];
    return () => timers.forEach(clearTimeout);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-[10vh] z-[45] flex justify-center">
      <AnimatePresence mode="wait">
        {beat === 1 ? (
          <motion.div
            key="beat1"
            className={`${card} border-brass flex items-center gap-[2.5vw]`}
            initial={{ y: 60, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            transition={{ type: "spring", stiffness: 190, damping: 18 }}
          >
            <motion.div
              initial={{ x: -320, rotate: -26, opacity: 0 }}
              animate={{ x: 0, rotate: -8, opacity: 1 }}
              transition={{ type: "spring", stiffness: 140, damping: 13, delay: 0.15 }}
            >
              <EnvelopeGlyph w={170} tone="paper" className="drop-shadow-[0_10px_24px_rgba(0,0,0,0.7)]" />
            </motion.div>
            <div className="text-left">
              <h2 className="font-display text-[5.5vh] leading-none tracking-wide">ENVELOPES RECORD THE TRUTH</h2>
              <p className="mt-[1vh] font-type text-[2.8vh] text-bone/75">One per player, sealed after every shot. Nobody can see inside.</p>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="beat2"
            className={`${card} border-blood text-center`}
            initial={{ y: 60, scale: 0.9, opacity: 0 }}
            animate={{ y: 0, scale: 1, opacity: 1 }}
            exit={{ y: 30, opacity: 0 }}
            transition={{ type: "spring", stiffness: 230, damping: 16 }}
          >
            <motion.h2
              initial={{ scale: 1.6, rotate: -9, opacity: 0 }}
              animate={{ scale: 1, rotate: -2, opacity: 1 }}
              transition={{ type: "spring", stiffness: 300, damping: 13 }}
              className="font-display text-[6vh] leading-none tracking-wide text-blood drop-shadow-[0_0_30px_rgba(224,49,43,0.6)]"
            >
              ANYONE CAN SLAM RIGGED!
            </motion.h2>
            <div className="mt-[1.6vh] flex flex-col items-start gap-[0.8vh]">
              <Verdict tone="guilty" delay={0.3}>
                GUILTY <span className="text-bone/60">→</span> they lose their WHOLE stack
              </Verdict>
              <Verdict tone="clean" delay={0.55}>
                INNOCENT <span className="text-bone/60">→</span> you pay
              </Verdict>
            </div>
            <motion.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9 }} className="mt-[1.4vh] font-type text-[2.6vh] text-bone/75">
              The envelopes get opened on-chain. No takebacks.
            </motion.p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function Verdict({ tone, delay, children }: { tone: "guilty" | "clean"; delay: number; children: ReactNode }) {
  return (
    <motion.p
      initial={{ x: tone === "guilty" ? -70 : 70, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      transition={{ type: "spring", stiffness: 420, damping: 18, delay }}
      className={`flex items-center gap-[1vw] font-display text-[3vh] tracking-wide ${tone === "guilty" ? "text-blood" : "text-crt"}`}
    >
      <EnvelopeGlyph w={56} tone={tone} />
      {children}
    </motion.p>
  );
}
