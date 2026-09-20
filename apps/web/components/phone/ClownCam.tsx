"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** Front-camera overlay with a clown filter on the live face. Comedy, not tracking. */
export function ClownCam({ active, onDone }: { active: boolean; onDone: () => void }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const onDoneRef = useRef(onDone);
  const aliveRef = useRef(false);
  const [needTap, setNeedTap] = useState(false);
  const [ready, setReady] = useState(false);
  onDoneRef.current = onDone;

  const stop = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    const v = videoRef.current;
    if (v) v.srcObject = null;
  };

  const start = useCallback(async (retrying = false): Promise<boolean> => {
    if (!navigator.mediaDevices?.getUserMedia) return false;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      if (!aliveRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      streamRef.current?.getTracks().forEach((t) => t.stop());
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        try {
          await v.play();
        } catch {
          if (!aliveRef.current || retrying) return false;
          setNeedTap(true);
          return true;
        }
      }
      if (!aliveRef.current) return false;
      setNeedTap(false);
      setReady(true);
      return true;
    } catch (e) {
      if (!aliveRef.current) return false;
      const name = e instanceof DOMException ? e.name : "";
      if (retrying || name === "NotFoundError" || name === "OverconstrainedError") return false;
      setNeedTap(true);
      return true;
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    aliveRef.current = true;
    setNeedTap(false);
    setReady(false);
    void start().then((ok) => {
      if (!ok && aliveRef.current) onDoneRef.current();
    });
    return () => {
      aliveRef.current = false;
      stop();
    };
  }, [active, start]);

  useEffect(() => {
    if (!active || !ready || needTap) return;
    const t = setTimeout(() => {
      if (aliveRef.current) onDoneRef.current();
    }, 4500);
    return () => clearTimeout(t);
  }, [active, ready, needTap]);

  const retry = async () => {
    const ok = await start(true);
    if (!ok) onDoneRef.current();
  };

  if (!active) return null;

  return (
    <div className="fixed inset-0 z-50 bg-black">
      <video
        ref={videoRef}
        playsInline
        muted
        autoPlay
        className="absolute inset-0 h-full w-full object-cover"
        style={{ transform: "scaleX(-1)", filter: "saturate(1.35) contrast(1.12) brightness(1.05)" }}
      />
      {/* Makeup sits on the live face; wig/nose/smile are overlays, not a mask. */}
      <div className="pointer-events-none absolute inset-0" aria-hidden>
        <div className="absolute left-1/2 top-[8%] h-[28%] w-[92%] -translate-x-1/2 rounded-[50%] bg-[radial-gradient(circle_at_20%_50%,#9b5de5_0_18%,transparent_19%),radial-gradient(circle_at_50%_20%,#f3a712_0_22%,transparent_23%),radial-gradient(circle_at_80%_50%,#4ea8de_0_18%,transparent_19%),radial-gradient(circle_at_35%_70%,#e0312b_0_16%,transparent_17%),radial-gradient(circle_at_65%_70%,#e4572e_0_16%,transparent_17%)] opacity-90" />
        <div className="absolute left-[22%] top-[46%] h-[8%] w-[14%] rounded-full bg-[#ff7a8a]/70 blur-[1px]" />
        <div className="absolute right-[22%] top-[46%] h-[8%] w-[14%] rounded-full bg-[#ff7a8a]/70 blur-[1px]" />
        <div className="absolute left-1/2 top-[48%] h-[11%] w-[18%] -translate-x-1/2 rounded-full bg-[#e0312b] shadow-[0_8px_0_#8a1210] ring-4 ring-[#8a1210]" />
        <div className="absolute left-1/2 top-[58%] h-[10%] w-[42%] -translate-x-1/2 rounded-[50%] border-b-[10px] border-[#1a120c]" />
        <div className="absolute left-1/2 top-[61%] h-[6%] w-[32%] -translate-x-1/2 rounded-[50%] border-b-[6px] border-[#e0312b]" />
      </div>
      <p className="stamp pointer-events-none absolute bottom-[11%] left-1/2 w-[min(92vw,22rem)] -translate-x-1/2 -rotate-2 border-[6px] px-3 py-2 text-center text-3xl text-blood">
        YOU DID THIS TO YOURSELF
      </p>
      {needTap && (
        <button onClick={retry} className="absolute inset-0 z-10 flex items-center justify-center bg-black/40">
          <span className="rounded-2xl border-4 border-brass bg-soot px-6 py-4 font-display text-3xl tracking-wide text-brass">TAP TO FACE THE MUSIC</span>
        </button>
      )}
    </div>
  );
}
