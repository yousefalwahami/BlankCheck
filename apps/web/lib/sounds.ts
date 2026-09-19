"use client";

/*
 * All sounds are synthesized with Web Audio: no asset files, nothing borrowed.
 * Browsers only start audio after a user gesture, so call unlockAudio() from a click.
 */

let ctx: AudioContext | null = null;
let muted = false;

function ac(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const C = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!C) return null;
    ctx = new C();
  }
  return ctx;
}

export function unlockAudio() {
  const c = ac();
  if (c && c.state === "suspended") void c.resume();
}

export function setMuted(m: boolean) {
  muted = m;
}

function noise(c: AudioContext, seconds: number): AudioBuffer {
  const buf = c.createBuffer(1, Math.ceil(c.sampleRate * seconds), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return buf;
}

function env(c: AudioContext, g: GainNode, t: number, peak: number, attack: number, decay: number) {
  g.gain.cancelScheduledValues(t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function burst(opts: { at?: number; dur: number; peak: number; filter: BiquadFilterType; freq: number; q?: number; attack?: number }) {
  const c = ac();
  if (!c || muted) return;
  const t = c.currentTime + (opts.at ?? 0);
  const src = c.createBufferSource();
  src.buffer = noise(c, opts.dur + 0.05);
  const f = c.createBiquadFilter();
  f.type = opts.filter;
  f.frequency.value = opts.freq;
  f.Q.value = opts.q ?? 0.8;
  const g = c.createGain();
  env(c, g, t, opts.peak, opts.attack ?? 0.004, opts.dur);
  src.connect(f).connect(g).connect(c.destination);
  src.start(t);
  src.stop(t + opts.dur + 0.1);
}

function tone(opts: { at?: number; freq: number; to?: number; dur: number; peak: number; type?: OscillatorType }) {
  const c = ac();
  if (!c || muted) return;
  const t = c.currentTime + (opts.at ?? 0);
  const o = c.createOscillator();
  o.type = opts.type ?? "sine";
  o.frequency.setValueAtTime(opts.freq, t);
  if (opts.to) o.frequency.exponentialRampToValueAtTime(opts.to, t + opts.dur);
  const g = c.createGain();
  env(c, g, t, opts.peak, 0.005, opts.dur);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + opts.dur + 0.1);
}

export const sfx = {
  /** Shotgun racking: two metallic clacks. */
  rack() {
    burst({ dur: 0.07, peak: 0.5, filter: "bandpass", freq: 2400, q: 3 });
    tone({ freq: 380, to: 240, dur: 0.06, peak: 0.15, type: "square" });
    burst({ at: 0.16, dur: 0.09, peak: 0.6, filter: "bandpass", freq: 1700, q: 3 });
    tone({ at: 0.16, freq: 300, to: 180, dur: 0.08, peak: 0.18, type: "square" });
  },
  /** Live shell. */
  bang() {
    burst({ dur: 0.9, peak: 1.0, filter: "lowpass", freq: 1800, attack: 0.002 });
    tone({ freq: 140, to: 38, dur: 0.5, peak: 0.9 });
    burst({ at: 0.05, dur: 1.4, peak: 0.25, filter: "lowpass", freq: 500 });
  },
  /** Blank: a dull click and thump. */
  blank() {
    burst({ dur: 0.05, peak: 0.5, filter: "highpass", freq: 3000 });
    tone({ at: 0.02, freq: 90, to: 50, dur: 0.18, peak: 0.35 });
  },
  heartbeat() {
    tone({ freq: 60, to: 42, dur: 0.14, peak: 0.6 });
    tone({ at: 0.22, freq: 55, to: 40, dur: 0.16, peak: 0.45 });
  },
  gavel() {
    burst({ dur: 0.12, peak: 0.8, filter: "bandpass", freq: 900, q: 2 });
    tone({ freq: 220, to: 110, dur: 0.2, peak: 0.5, type: "triangle" });
    burst({ at: 0.28, dur: 0.12, peak: 0.9, filter: "bandpass", freq: 850, q: 2 });
    tone({ at: 0.28, freq: 200, to: 100, dur: 0.25, peak: 0.55, type: "triangle" });
  },
  rigged() {
    tone({ freq: 880, to: 660, dur: 0.25, peak: 0.25, type: "sawtooth" });
    tone({ at: 0.25, freq: 880, to: 660, dur: 0.25, peak: 0.25, type: "sawtooth" });
    burst({ dur: 0.4, peak: 0.5, filter: "lowpass", freq: 700 });
  },
  shatter() {
    for (let i = 0; i < 6; i++) tone({ at: i * 0.03, freq: 1800 + Math.random() * 2400, dur: 0.12, peak: 0.12, type: "triangle" });
    burst({ dur: 0.3, peak: 0.4, filter: "highpass", freq: 4000 });
  },
  tick() {
    tone({ freq: 1200, dur: 0.03, peak: 0.12, type: "square" });
  },
  alarm() {
    tone({ freq: 620, dur: 0.18, peak: 0.2, type: "square" });
    tone({ at: 0.2, freq: 520, dur: 0.18, peak: 0.2, type: "square" });
  },
  /** VHS rewind: a pitched whine with tape hiss. */
  rewind() {
    tone({ freq: 300, to: 2400, dur: 1.4, peak: 0.12, type: "sawtooth" });
    burst({ dur: 1.5, peak: 0.12, filter: "highpass", freq: 2500 });
  },
  stamp() {
    burst({ dur: 0.08, peak: 0.7, filter: "lowpass", freq: 1200 });
    tone({ freq: 120, to: 70, dur: 0.12, peak: 0.5 });
  },
  boo() {
    tone({ freq: 180, to: 140, dur: 0.6, peak: 0.25, type: "sine" });
  },
};
