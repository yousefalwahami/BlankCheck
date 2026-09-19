"use client";

/*
 * File-backed SFX in /public/sfx, decoded into Web Audio.
 * Browsers only start audio after a user gesture — call unlockAudio() from a click/tap.
 * If a file hasn't loaded yet, we fall back to a short synthesized burst so a shot is never silent.
 */

export type SfxName =
  | "rack"
  | "bang"
  | "blank"
  | "heartbeat"
  | "gavel"
  | "rigged"
  | "shatter"
  | "tick"
  | "alarm"
  | "rewind"
  | "stamp"
  | "boo"
  | "card";

const FILES: Record<SfxName, string> = {
  rack: "/sfx/rack.wav",
  bang: "/sfx/bang.wav",
  blank: "/sfx/blank.wav",
  heartbeat: "/sfx/heartbeat.wav",
  gavel: "/sfx/gavel.wav",
  rigged: "/sfx/rigged.wav",
  shatter: "/sfx/shatter.wav",
  tick: "/sfx/tick.wav",
  alarm: "/sfx/alarm.wav",
  rewind: "/sfx/rewind.wav",
  stamp: "/sfx/stamp.wav",
  boo: "/sfx/boo.wav",
  card: "/sfx/card.wav",
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let muted = false;
let loadStarted = false;
let ready = false;
const buffers = new Map<SfxName, AudioBuffer>();
const queued: SfxName[] = [];

function Ctor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext ?? null;
}

function ensureCtx(): AudioContext | null {
  if (ctx) return ctx;
  const C = Ctor();
  if (!C) return null;
  ctx = new C();
  master = ctx.createGain();
  master.gain.value = 0.85;
  master.connect(ctx.destination);
  return ctx;
}

async function loadAll(c: AudioContext) {
  if (loadStarted) return;
  loadStarted = true;
  await Promise.all(
    (Object.keys(FILES) as SfxName[]).map(async (name) => {
      try {
        const res = await fetch(FILES[name]);
        if (!res.ok) return;
        const raw = await res.arrayBuffer();
        const buf = await c.decodeAudioData(raw.slice(0));
        buffers.set(name, buf);
      } catch {
        /* keep synth fallback */
      }
    }),
  );
  ready = true;
  flushQueue();
}

function flushQueue() {
  while (queued.length) {
    const name = queued.shift();
    if (name) play(name);
  }
}

export function unlockAudio() {
  const c = ensureCtx();
  if (!c) return;
  if (c.state === "suspended") void c.resume();
  void loadAll(c);
  flushQueue();
}

export function setMuted(m: boolean) {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.85, ctx.currentTime, 0.02);
}

function fallback(name: SfxName) {
  const c = ctx;
  if (!c || muted) return;
  const t = c.currentTime;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = name === "bang" || name === "blank" ? "sine" : "square";
  const freq = name === "bang" ? 90 : name === "heartbeat" ? 60 : 420;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(Math.max(40, freq * 0.4), t + 0.18);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(name === "tick" ? 0.12 : 0.45, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
  o.connect(g).connect(master ?? c.destination);
  o.start(t);
  o.stop(t + 0.25);
}

function play(name: SfxName) {
  if (muted) return;
  const c = ctx;
  if (!c || c.state === "suspended") {
    queued.push(name);
    return;
  }
  const buf = buffers.get(name);
  if (!buf) {
    if (!ready) queued.push(name);
    else fallback(name);
    return;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  src.connect(master ?? c.destination);
  src.start();
}

export const sfx = {
  rack: () => play("rack"),
  bang: () => play("bang"),
  blank: () => play("blank"),
  heartbeat: () => play("heartbeat"),
  gavel: () => play("gavel"),
  rigged: () => play("rigged"),
  shatter: () => play("shatter"),
  tick: () => play("tick"),
  alarm: () => play("alarm"),
  rewind: () => play("rewind"),
  stamp: () => play("stamp"),
  boo: () => play("boo"),
  card: () => play("card"),
};

if (typeof window !== "undefined") {
  const arm = () => unlockAudio();
  window.addEventListener("pointerdown", arm, { once: true, capture: true });
  window.addEventListener("keydown", arm, { once: true, capture: true });
}
