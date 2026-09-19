/**
 * Bake original SFX as 16-bit mono WAVs. Nothing is sampled from another game —
 * these are synthesized here so the party TV has punchy, file-backed sounds.
 *
 *   node apps/web/scripts/gen-sfx.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const SR = 44100;
const outDir = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "sfx");

function alloc(seconds) {
  return new Float64Array(Math.max(1, Math.ceil(SR * seconds)));
}

function clamp(x) {
  return Math.max(-1, Math.min(1, x));
}

function mix(dst, src, at = 0, gain = 1) {
  const start = Math.floor(at * SR);
  for (let i = 0; i < src.length && start + i < dst.length; i++) dst[start + i] += src[i] * gain;
}

function env(n, attack, decay, sustain = 0) {
  const a = Math.max(1, Math.floor(attack * SR));
  const d = Math.max(1, Math.floor(decay * SR));
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    if (i < a) out[i] = i / a;
    else if (i < a + d) out[i] = 1 - (1 - sustain) * ((i - a) / d);
    else out[i] = sustain * Math.exp(-(i - a - d) / (0.08 * SR));
  }
  return out;
}

function applyEnv(samples, attack, decay) {
  const e = env(samples.length, attack, decay);
  for (let i = 0; i < samples.length; i++) samples[i] *= e[i];
  return samples;
}

function osc(seconds, freq, type = "sine", freqTo) {
  const n = Math.ceil(SR * seconds);
  const out = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / n;
    const f = freqTo ? freq * Math.pow(freqTo / freq, t) : freq;
    phase += (2 * Math.PI * f) / SR;
    if (type === "sine") out[i] = Math.sin(phase);
    else if (type === "square") out[i] = Math.sin(phase) > 0 ? 1 : -1;
    else if (type === "saw") out[i] = ((phase / (2 * Math.PI)) % 1) * 2 - 1;
    else if (type === "tri") {
      const x = (phase / (2 * Math.PI)) % 1;
      out[i] = x < 0.5 ? x * 4 - 1 : 3 - x * 4;
    }
  }
  return out;
}

function noise(seconds) {
  const n = Math.ceil(SR * seconds);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.random() * 2 - 1;
  return out;
}

function lowpass(samples, cutoff) {
  const out = new Float64Array(samples.length);
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SR;
  const a = dt / (rc + dt);
  let y = 0;
  for (let i = 0; i < samples.length; i++) {
    y += a * (samples[i] - y);
    out[i] = y;
  }
  return out;
}

function highpass(samples, cutoff) {
  const out = new Float64Array(samples.length);
  const rc = 1 / (2 * Math.PI * cutoff);
  const dt = 1 / SR;
  const a = rc / (rc + dt);
  let prevX = 0;
  let prevY = 0;
  for (let i = 0; i < samples.length; i++) {
    const y = a * (prevY + samples[i] - prevX);
    prevX = samples[i];
    prevY = y;
    out[i] = y;
  }
  return out;
}

function normalize(samples, peak = 0.92) {
  let m = 0;
  for (const x of samples) m = Math.max(m, Math.abs(x));
  if (m < 1e-6) return samples;
  const g = peak / m;
  for (let i = 0; i < samples.length; i++) samples[i] *= g;
  return samples;
}

function wav(samples) {
  normalize(samples);
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + n * 2, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24);
  buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    buf.writeInt16LE((clamp(samples[i]) * 32767) | 0, 44 + i * 2);
  }
  return buf;
}

const sounds = {
  rack() {
    // Twist the popper wrapper: dry paper rustle, no metal clack.
    const n = alloc(0.32);
    mix(n, applyEnv(highpass(noise(0.22), 1600), 0.02, 0.2), 0, 0.7);
    mix(n, applyEnv(osc(0.18, 420, "tri", 180), 0.01, 0.16), 0.04, 0.18);
    mix(n, applyEnv(highpass(noise(0.08), 3200), 0.001, 0.07), 0.16, 0.45);
    return n;
  },
  bang() {
    // Live charge: party-popper crack, no boom.
    const n = alloc(0.55);
    mix(n, applyEnv(highpass(noise(0.08), 900), 0.0006, 0.06), 0, 1);
    mix(n, applyEnv(osc(0.16, 980, "sine", 280), 0.001, 0.14), 0, 0.45);
    mix(n, applyEnv(osc(0.1, 2400, "tri", 900), 0.001, 0.09), 0, 0.28);
    mix(n, applyEnv(highpass(noise(0.28), 1800), 0.004, 0.24), 0.02, 0.35);
    mix(n, applyEnv(osc(0.22, 520, "sine", 180), 0.004, 0.2), 0.01, 0.22);
    return n;
  },
  blank() {
    // Dud: a little air and a paper puff.
    const n = alloc(0.28);
    mix(n, applyEnv(highpass(noise(0.05), 2800), 0.0008, 0.04), 0, 0.7);
    mix(n, applyEnv(osc(0.08, 620, "tri", 220), 0.002, 0.07), 0, 0.22);
    mix(n, applyEnv(lowpass(noise(0.16), 700), 0.008, 0.14), 0.02, 0.28);
    return n;
  },
  heartbeat() {
    const n = alloc(0.7);
    const thump = (freq, dur) => applyEnv(osc(dur, freq, "sine", freq * 0.7), 0.008, dur - 0.01);
    mix(n, thump(62, 0.14), 0, 1);
    mix(n, thump(52, 0.16), 0.22, 0.82);
    return n;
  },
  gavel() {
    const knock = () => {
      const k = alloc(0.22);
      mix(k, applyEnv(lowpass(noise(0.08), 1400), 0.001, 0.07), 0, 0.9);
      mix(k, applyEnv(osc(0.16, 210, "tri", 90), 0.002, 0.14), 0, 0.7);
      mix(k, applyEnv(osc(0.05, 900, "sine"), 0.001, 0.04), 0, 0.25);
      return k;
    };
    const n = alloc(0.55);
    mix(n, knock(), 0, 1);
    mix(n, knock(), 0.26, 1.05);
    return n;
  },
  rigged() {
    const n = alloc(0.85);
    mix(n, applyEnv(osc(0.22, 880, "saw", 640), 0.01, 0.2), 0, 0.45);
    mix(n, applyEnv(osc(0.22, 880, "saw", 640), 0.01, 0.2), 0.28, 0.45);
    mix(n, applyEnv(lowpass(noise(0.7), 500), 0.02, 0.65), 0, 0.55);
    mix(n, applyEnv(osc(0.5, 70, "sine", 40), 0.02, 0.48), 0, 0.5);
    return n;
  },
  shatter() {
    const n = alloc(0.55);
    mix(n, applyEnv(highpass(noise(0.35), 3500), 0.001, 0.32), 0, 0.9);
    for (let i = 0; i < 8; i++) {
      const f = 1600 + ((i * 9973) % 2800);
      mix(n, applyEnv(osc(0.12 + (i % 3) * 0.03, f, "tri", f * 0.7), 0.001, 0.1), i * 0.028, 0.22);
    }
    return n;
  },
  tick() {
    const n = alloc(0.08);
    mix(n, applyEnv(osc(0.04, 1400, "square"), 0.001, 0.03), 0, 0.55);
    mix(n, applyEnv(highpass(noise(0.03), 4000), 0.001, 0.02), 0, 0.35);
    return n;
  },
  alarm() {
    const n = alloc(0.55);
    mix(n, applyEnv(osc(0.2, 640, "square"), 0.005, 0.18), 0, 0.4);
    mix(n, applyEnv(osc(0.2, 510, "square"), 0.005, 0.18), 0.24, 0.4);
    return n;
  },
  rewind() {
    const n = alloc(1.6);
    mix(n, applyEnv(osc(1.45, 280, "saw", 2600), 0.04, 1.35), 0, 0.28);
    mix(n, applyEnv(highpass(noise(1.5), 2200), 0.02, 1.4), 0, 0.35);
    mix(n, applyEnv(osc(0.2, 1800, "square", 400), 0.01, 0.18), 1.25, 0.2);
    return n;
  },
  stamp() {
    const n = alloc(0.28);
    mix(n, applyEnv(lowpass(noise(0.1), 900), 0.001, 0.09), 0, 1);
    mix(n, applyEnv(osc(0.16, 130, "sine", 55), 0.002, 0.14), 0, 0.85);
    mix(n, applyEnv(osc(0.04, 700, "square"), 0.001, 0.03), 0, 0.2);
    return n;
  },
  boo() {
    const n = alloc(0.75);
    mix(n, applyEnv(osc(0.65, 190, "sine", 120), 0.04, 0.55), 0, 0.7);
    mix(n, applyEnv(osc(0.55, 95, "tri", 70), 0.05, 0.48), 0.04, 0.35);
    mix(n, applyEnv(lowpass(noise(0.5), 300), 0.05, 0.45), 0, 0.2);
    return n;
  },
  card() {
    const n = alloc(0.32);
    mix(n, applyEnv(highpass(noise(0.08), 1200), 0.002, 0.07), 0, 0.45);
    mix(n, applyEnv(osc(0.12, 520, "tri", 280), 0.004, 0.1), 0.04, 0.35);
    mix(n, applyEnv(lowpass(noise(0.1), 800), 0.01, 0.08), 0.08, 0.3);
    return n;
  },
};

mkdirSync(outDir, { recursive: true });
for (const [name, fn] of Object.entries(sounds)) {
  const file = join(outDir, `${name}.wav`);
  writeFileSync(file, wav(fn()));
  console.log("wrote", file);
}
