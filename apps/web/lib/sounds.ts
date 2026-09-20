"use client";

/*
 * The game's audio: one-shot effects from /public/sfx and music loops from /public/music, both
 * built by apps/web/scripts/build-audio.mjs (see CREDITS.md for sources and licences).
 *
 * Browsers only start audio after a user gesture, so everything routes through unlockAudio(),
 * which the first pointerdown or keydown calls. Music plays through Web Audio rather than an
 * <audio> element's own volume, because iOS ignores HTMLMediaElement.volume — a GainNode is the
 * only way to fade or duck on a phone.
 *
 * Effects are peak-normalised on disk, so the mix lives here in one table.
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
  | "card"
  | "deal"
  | "chip"
  | "chips"
  | "pot"
  | "stack"
  | "cash"
  | "win";

type Spec = {
  /** Variants: a random one plays each time, so repeats never sound machine-gunned. */
  files: string[];
  /** Relative level, 0–1, against the peak-normalised file. */
  gain: number;
  /** Random playback-rate range, which detunes and shortens or lengthens the sample. */
  pitch?: [number, number];
  /** Duck the music by this much (0–1) while it plays. */
  duck?: number;
};

const v = (name: string, n: number) => Array.from({ length: n }, (_, i) => `/sfx/${name}${i === 0 ? "" : i + 1}.wav`);

const SFX: Record<SfxName, Spec> = {
  // The popper.
  bang: { files: v("bang", 2), gain: 0.95, pitch: [0.96, 1.05], duck: 0.35 },
  blank: { files: ["/sfx/blank.wav"], gain: 0.7, pitch: [0.97, 1.06] },
  rack: { files: ["/sfx/rack.wav"], gain: 0.75, pitch: [0.98, 1.03] },
  heartbeat: { files: ["/sfx/heartbeat.wav"], gain: 0.5 },

  // Money.
  chip: { files: v("chip", 3), gain: 0.65, pitch: [0.94, 1.08] },
  chips: { files: v("chips", 3), gain: 0.7, pitch: [0.96, 1.05] },
  pot: { files: v("pot", 2), gain: 0.75, pitch: [0.95, 1.06] },
  stack: { files: ["/sfx/stack.wav"], gain: 0.6, pitch: [0.94, 1.08] },
  cash: { files: ["/sfx/cash.wav"], gain: 0.55, duck: 0.3 },
  win: { files: ["/sfx/win.wav"], gain: 0.7, duck: 0.5 },

  // Cards.
  card: { files: v("card", 3), gain: 0.6, pitch: [0.95, 1.07] },
  deal: { files: ["/sfx/deal.wav"], gain: 0.5 },

  // Consequences.
  rigged: { files: ["/sfx/rigged.wav"], gain: 0.8, duck: 0.6 },
  gavel: { files: ["/sfx/gavel.wav"], gain: 0.85, duck: 0.4 },
  shatter: { files: ["/sfx/shatter.wav"], gain: 0.6 },
  stamp: { files: ["/sfx/stamp.wav"], gain: 0.6 },
  alarm: { files: ["/sfx/alarm.wav"], gain: 0.5, duck: 0.4 },
  boo: { files: ["/sfx/boo.wav"], gain: 0.55 },
  tick: { files: ["/sfx/tick.wav"], gain: 0.35, pitch: [0.98, 1.04] },
  rewind: { files: ["/sfx/rewind.wav"], gain: 0.5, duck: 0.5 },
};

/** Music beds. The TV plays these; phones stay effects-only so the room has one soundtrack. */
export type Scene = "lobby" | "table" | "tape";
const MUSIC: Record<Scene, { file: string; gain: number }> = {
  lobby: { file: "/music/theme.mp3", gain: 0.55 },
  table: { file: "/music/table.mp3", gain: 0.4 },
  tape: { file: "/music/tape.mp3", gain: 0.45 },
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let muted = false;
let loadStarted = false;
let ready = false;
let scene: Scene | null = null;
let musicOn = false;
const buffers = new Map<string, AudioBuffer>();
const queued: SfxName[] = [];
const players = new Map<Scene, { el: HTMLAudioElement; gain: GainNode }>();
/** Rate-limit identical sounds so a burst of events can't stack into a wall of noise. */
const lastPlayed = new Map<SfxName, number>();

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
  master.gain.value = muted ? 0 : 0.9;
  master.connect(ctx.destination);
  sfxBus = ctx.createGain();
  sfxBus.gain.value = 1;
  sfxBus.connect(master);
  musicBus = ctx.createGain();
  musicBus.gain.value = 1;
  musicBus.connect(master);
  return ctx;
}

async function loadAll(c: AudioContext) {
  if (loadStarted) return;
  loadStarted = true;
  const files = [...new Set(Object.values(SFX).flatMap((s) => s.files))];
  await Promise.all(
    files.map(async (file) => {
      try {
        const res = await fetch(file);
        if (!res.ok) return;
        buffers.set(file, await c.decodeAudioData(await res.arrayBuffer()));
      } catch {
        /* a missing file just falls back to the synth blip below */
      }
    }),
  );
  ready = true;
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
  // A scene asked for before the first tap starts here instead.
  if (scene && musicOn) applyScene(scene);
}

export function setMuted(m: boolean) {
  muted = m;
  if (master && ctx) master.gain.setTargetAtTime(m ? 0 : 0.9, ctx.currentTime, 0.02);
}

/* ───────────── music ───────────── */

function applyScene(next: Scene) {
  const c = ensureCtx();
  if (!c || !musicBus) return;
  for (const [key, p] of players) {
    if (key === next) continue;
    p.gain.gain.cancelScheduledValues(c.currentTime);
    p.gain.gain.setTargetAtTime(0, c.currentTime, 0.4);
    // Pause once faded, but keep the element so coming back is instant.
    window.setTimeout(() => {
      if (scene !== key) p.el.pause();
    }, 1600);
  }

  let p = players.get(next);
  if (!p) {
    const el = new Audio(MUSIC[next].file);
    el.loop = true;
    el.preload = "auto";
    el.crossOrigin = "anonymous";
    const gain = c.createGain();
    gain.gain.value = 0;
    try {
      c.createMediaElementSource(el).connect(gain);
      gain.connect(musicBus);
    } catch {
      return; // an old browser without MediaElementSource: skip the music, keep the effects
    }
    p = { el, gain };
    players.set(next, p);
  }
  p.el.play().catch(() => {
    /* still waiting on a gesture; unlockAudio() will retry */
  });
  p.gain.gain.cancelScheduledValues(c.currentTime);
  p.gain.gain.setTargetAtTime(MUSIC[next].gain, c.currentTime, 0.6);
}

/**
 * Pick the bed for what's on screen. `null` fades everything out. Only the TV calls this: phones
 * would play the same loops a beat apart, which sounds like a broken radio.
 */
export function setScene(next: Scene | null) {
  if (next === scene) return;
  scene = next;
  if (!musicOn) return;
  if (!next) return stopMusic();
  applyScene(next);
}

export function setMusicEnabled(on: boolean) {
  musicOn = on;
  if (!on) return stopMusic();
  const c = ensureCtx();
  if (c?.state === "suspended") void c.resume();
  if (scene) applyScene(scene);
}

function stopMusic() {
  if (!ctx) return;
  for (const p of players.values()) {
    p.gain.gain.cancelScheduledValues(ctx.currentTime);
    p.gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    window.setTimeout(() => p.el.pause(), 1200);
  }
}

/** Dip the music under a loud moment, then bring it back. */
function duck(amount: number, holdMs = 700) {
  if (!ctx || !musicBus || !musicOn) return;
  const now = ctx.currentTime;
  musicBus.gain.cancelScheduledValues(now);
  musicBus.gain.setTargetAtTime(1 - amount, now, 0.05);
  window.setTimeout(() => {
    if (ctx && musicBus) musicBus.gain.setTargetAtTime(1, ctx.currentTime, 0.4);
  }, holdMs);
}

/* ───────────── effects ───────────── */

/** Last resort so a shot is never silent: a short noise burst shaped like the real thing. */
function fallback(name: SfxName) {
  const c = ctx;
  if (!c || muted) return;
  const t = c.currentTime;
  const loud = name === "bang";
  const dur = loud ? 0.32 : 0.14;
  const buf = c.createBuffer(1, Math.floor(c.sampleRate * dur), c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * Math.exp((-i / c.sampleRate) * (loud ? 12 : 26)) * (loud ? 0.7 : 0.25);
  }
  const src = c.createBufferSource();
  const hp = c.createBiquadFilter();
  hp.type = "highpass";
  hp.frequency.value = loud ? 600 : 1400;
  src.buffer = buf;
  src.connect(hp).connect(sfxBus ?? c.destination);
  src.start(t);
}

function play(name: SfxName) {
  if (muted) return;
  const c = ctx;
  if (!c || c.state === "suspended") {
    queued.push(name);
    return;
  }
  const spec = SFX[name];
  const now = performance.now();
  if (now - (lastPlayed.get(name) ?? 0) < 45) return;
  lastPlayed.set(name, now);

  const file = spec.files[Math.floor(Math.random() * spec.files.length)];
  const buf = buffers.get(file) ?? buffers.get(spec.files[0]);
  if (!buf) {
    if (!ready) queued.push(name);
    else fallback(name);
    return;
  }
  const src = c.createBufferSource();
  src.buffer = buf;
  if (spec.pitch) src.playbackRate.value = spec.pitch[0] + Math.random() * (spec.pitch[1] - spec.pitch[0]);
  const g = c.createGain();
  g.gain.value = spec.gain;
  src.connect(g).connect(sfxBus ?? c.destination);
  src.start();
  if (spec.duck) duck(spec.duck, Math.min(2000, buf.duration * 1000 + 400));
}

export const sfx = Object.fromEntries((Object.keys(SFX) as SfxName[]).map((n) => [n, () => play(n)])) as Record<SfxName, () => void>;

if (typeof window !== "undefined") {
  const arm = () => unlockAudio();
  window.addEventListener("pointerdown", arm, { once: true, capture: true });
  window.addEventListener("keydown", arm, { once: true, capture: true });
}
