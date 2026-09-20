/**
 * Build every sound and music loop in the game from royalty-free sources.
 *
 *   node apps/web/scripts/build-audio.mjs          # needs ffmpeg on PATH (or FFMPEG=/path/to/ffmpeg)
 *
 * Sources are downloaded once into .audio-cache/ (gitignored) and rendered into public/sfx and
 * public/music. Nothing here is sampled from another game: the sound effects are CC0 packs and the
 * music is Kevin MacLeod's CC-BY 4.0 library. Re-running this rewrites the committed assets
 * byte-identically, so the provenance of every file is this script plus SOURCES.
 *
 * Every effect is peak-normalised to the same headroom; the relative mix lives in lib/sounds.ts.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inflateRawSync } from "node:zlib";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const cache = join(web, ".audio-cache");
const sfxDir = join(web, "public", "sfx");
const musicDir = join(web, "public", "music");
const FFMPEG = process.env.FFMPEG || "ffmpeg";

/* ───────────── where everything came from ───────────── */

const SOURCES = {
  casino: {
    file: "kenney_casino.zip",
    url: "https://opengameart.org/sites/default/files/kenney_casino-audio.zip",
    page: "https://opengameart.org/content/54-casino-sound-effects-cards-dice-chips",
    author: "Kenney",
    license: "CC0",
    what: "chips, cards and dice",
  },
  jingles: {
    file: "kenney_jingles.zip",
    url: "https://opengameart.org/sites/default/files/jingleSounds_Kenney.zip",
    page: "https://opengameart.org/content/85-short-music-jingles",
    author: "Kenney",
    license: "CC0",
    what: "saxophone stings",
  },
  bangs: {
    file: "25-CC0-bang-sfx.zip",
    url: "https://opengameart.org/sites/default/files/25-CC0-bang-sfx.zip",
    page: "https://opengameart.org/content/25-cc0-bang-firework-sfx",
    author: "rubberduck",
    license: "CC0",
    what: "fireworks and cannons under the pop",
  },
  balloonPop: {
    file: "balloon_pop.flac",
    url: "https://opengameart.org/sites/default/files/balloon_pop.flac",
    page: "https://opengameart.org/content/balloon-sounds",
    author: "AntumDeluge",
    license: "CC0",
    what: "the crack of the popper",
  },
  balloonStretch: {
    file: "balloon_inflate.flac",
    url: "https://opengameart.org/sites/default/files/balloon_inflate.flac",
    page: "https://opengameart.org/content/balloon-sounds",
    author: "AntumDeluge",
    license: "CC0",
    what: "loading the popper, and the dud",
  },
  impacts: {
    file: "rubberduck_breaking.zip",
    url: "https://opengameart.org/sites/default/files/sfx_breaking_and_falling.zip",
    page: "https://opengameart.org/content/75-cc0-breaking-falling-hit-sfx",
    author: "rubberduck",
    license: "CC0",
    what: "glass and wood impacts",
  },
  clicks: {
    file: "equipmentclicks.wav",
    url: "https://opengameart.org/sites/default/files/equipmentclicks.wav",
    page: "https://opengameart.org/content/equipment-clicks-ii",
    author: "LFA",
    license: "CC0",
    what: "the dry click and the pump",
  },
  heartbeat: {
    file: "heartbeat.wav",
    url: "https://opengameart.org/sites/default/files/heartbeat_slow_reverb.wav",
    page: "https://opengameart.org/content/heartbeat-sounds",
    author: "bart",
    license: "CC0",
    what: "the heartbeat",
  },
  crowd: {
    file: "crowd_oooh.ogg",
    url: "https://opengameart.org/sites/default/files/oooooooooo.ogg",
    page: "https://opengameart.org/content/oooooooooooooo",
    author: "Nocturnal_Vanguard",
    license: "CC0",
    what: "the crowd",
  },
  alarm: {
    file: "alarm.ogg",
    url: "https://opengameart.org/sites/default/files/alarm_0.ogg",
    page: "https://opengameart.org/content/short-alarm",
    author: "yd",
    license: "CC0",
    what: "the alarm",
  },
  coolVibes: {
    file: "Cool Vibes.mp3",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Cool%20Vibes.mp3",
    page: "https://incompetech.com/music/royalty-free/music.html",
    author: "Kevin MacLeod",
    license: "CC-BY 4.0",
    what: "the main theme",
  },
  deadlyRoulette: {
    file: "Deadly Roulette.mp3",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Deadly%20Roulette.mp3",
    page: "https://incompetech.com/music/royalty-free/music.html",
    author: "Kevin MacLeod",
    license: "CC-BY 4.0",
    what: "the table music",
  },
  covertAffair: {
    file: "Covert Affair.mp3",
    url: "https://incompetech.com/music/royalty-free/mp3-royaltyfree/Covert%20Affair.mp3",
    page: "https://incompetech.com/music/royalty-free/music.html",
    author: "Kevin MacLeod",
    license: "CC-BY 4.0",
    what: "the tape music",
  },
};

/** Archives are unpacked into .audio-cache/<key>/. `in` paths below are relative to that. */
const ARCHIVES = ["casino", "jingles", "bangs", "impacts"];

/*
 * One line per sound. `ss`/`t` cut the source, `filters` shapes it, and everything is then
 * peak-normalised to -1 dBFS so that lib/sounds.ts can set the mix in one place.
 * Names ending in a digit are variants: sounds.ts picks between them so repeats never
 * machine-gun (chips, cards, clicks).
 */
const SFX = [
  /*
   * The popper. A real party popper is a dry crack with a body behind it, so the balloon burst is
   * layered over a firework cannon: the balloon gives the transient, the cannon gives the room.
   */
  {
    out: "bang",
    src: "balloonPop",
    filters: "highpass=f=60",
    layer: { src: "bangs", in: "cannon_03.ogg", gain: 0.8, delay: 0.012, filters: "lowpass=f=6000" },
  },
  {
    out: "bang2",
    src: "balloonPop",
    // Headroom before the mix: bang_07 is a hot recording and the sum was clipping.
    filters: "highpass=f=60,asetrate=44100*1.06,aresample=44100,volume=0.8",
    layer: { src: "bangs", in: "bang_07.ogg", gain: 0.5, delay: 0.014, filters: "lowpass=f=6000" },
  },
  // Stretched rubber: winding the popper up, and the wheeze when it turns out to be a dud.
  { out: "rack", src: "balloonStretch", t: 1.0, filters: "afade=t=out:st=0.8:d=0.2" },
  { out: "blank", src: "balloonStretch", ss: 1.25, t: 0.28, filters: "lowpass=f=2400,afade=t=out:st=0.2:d=0.08" },
  { out: "tick", src: "clicks", ss: 1.07, t: 0.08, filters: "highpass=f=400" },

  // Money on felt.
  { out: "chip", src: "casino", in: "Audio/chip-lay-1.ogg" },
  { out: "chip2", src: "casino", in: "Audio/chip-lay-2.ogg" },
  { out: "chip3", src: "casino", in: "Audio/chip-lay-3.ogg" },
  { out: "chips", src: "casino", in: "Audio/chips-handle-1.ogg" },
  { out: "chips2", src: "casino", in: "Audio/chips-handle-3.ogg" },
  { out: "chips3", src: "casino", in: "Audio/chips-handle-5.ogg" },
  { out: "pot", src: "casino", in: "Audio/chips-collide-1.ogg" },
  { out: "pot2", src: "casino", in: "Audio/chips-collide-3.ogg" },
  { out: "stack", src: "casino", in: "Audio/chips-stack-1.ogg" },

  // Cards.
  { out: "card", src: "casino", in: "Audio/card-slide-1.ogg" },
  { out: "card2", src: "casino", in: "Audio/card-slide-4.ogg" },
  { out: "card3", src: "casino", in: "Audio/card-slide-7.ogg" },
  { out: "deal", src: "casino", in: "Audio/card-shuffle.ogg", t: 1.8, filters: "afade=t=out:st=1.5:d=0.3" },

  // Consequences.
  { out: "shatter", src: "impacts", in: "bfh1_glass_breaking_01.ogg" },
  // Pitched down an octave-ish, which turns a wood knock into a courtroom gavel.
  { out: "gavel", src: "impacts", in: "bfh1_wood_hit_03.ogg", filters: "asetrate=44100*0.62,aresample=44100,atempo=1.15" },
  { out: "stamp", src: "impacts", in: "bfh1_wood_hit_01.ogg", filters: "asetrate=44100*0.85,aresample=44100" },
  { out: "alarm", src: "alarm", filters: "afade=t=out:st=1.4:d=0.3" },
  { out: "rigged", src: "jingles", in: "OGG/jingles_SAX/jingles_SAX03.ogg" },
  { out: "cash", src: "jingles", in: "OGG/jingles_SAX/jingles_SAX10.ogg" },
  { out: "win", src: "jingles", in: "OGG/jingles_SAX/jingles_SAX07.ogg" },
  { out: "boo", src: "crowd", filters: "afade=t=out:st=2.1:d=0.3" },
  { out: "heartbeat", src: "heartbeat" },

  // A shuffle played backwards at speed is a VHS spooling back to the start.
  {
    out: "rewind",
    src: "casino",
    in: "Audio/card-shuffle.ogg",
    filters: "areverse,atempo=2.0,asetrate=44100*1.5,aresample=44100,bandpass=f=2200:width_type=h:w=1800,tremolo=f=14:d=0.5,afade=t=out:st=0.9:d=0.15",
    t: 3.0,
  },
];

/*
 * Music loops. Kevin MacLeod's tracks run 3–4 minutes; the game only needs a bed, so each one is
 * cut to a whole number of bars (past the intro) and the tail is crossfaded back over the head,
 * which makes the wrap seamless. 112 kbps keeps a phone's first load small.
 */
const MUSIC = [
  { out: "theme", src: "coolVibes", bpm: 83, startBars: 8, bars: 32, gain: "-18" },
  { out: "table", src: "deadlyRoulette", bpm: 104, startBars: 8, bars: 32, gain: "-20" },
  { out: "tape", src: "covertAffair", bpm: 68, startBars: 4, bars: 24, gain: "-19" },
];

/* ───────────── plumbing ───────────── */

function ff(args, { capture = false } = {}) {
  return execFileSync(FFMPEG, ["-y", "-hide_banner", ...args], {
    stdio: capture ? ["ignore", "pipe", "pipe"] : ["ignore", "ignore", "inherit"],
    encoding: "utf8",
  });
}

/** ffmpeg logs volumedetect to stderr, which execFileSync never returns — so read it with spawnSync. */
function peakDb(file) {
  const r = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], { encoding: "utf8" });
  const m = /max_volume:\s*(-?\d+(\.\d+)?) dB/.exec(`${r.stdout ?? ""}${r.stderr ?? ""}`);
  if (!m) throw new Error(`no peak for ${file}: ${(r.stderr ?? "").slice(-300)}`);
  return Number(m[1]);
}

async function download(key) {
  const s = SOURCES[key];
  const at = join(cache, s.file);
  if (existsSync(at)) return at;
  process.stdout.write(`  ↓ ${s.file} … `);
  const res = await fetch(s.url, { headers: { "user-agent": "blank-check-build/1 (+asset pipeline)" } });
  if (!res.ok) throw new Error(`${s.url} → ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  writeFileSync(at, buf);
  console.log(`${(buf.length / 1024).toFixed(0)} KB`);
  return at;
}

/**
 * Unpack a zip with zlib alone. The system `tar` would do it, but the one on a Windows PATH is
 * often MSYS tar, which reads "C:\…" as a remote host and refuses.
 */
function unpack(key, archive) {
  const dir = join(cache, key);
  if (existsSync(dir) && readdirSync(dir).length) return dir;
  const buf = readFileSync(archive);
  // Walk the central directory backwards from the end-of-central-directory record.
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error(`${archive}: not a zip`);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localAt = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith("/")) continue;
    // The local header repeats the name and extra fields, with its own lengths.
    const dataAt = localAt + 30 + buf.readUInt16LE(localAt + 26) + buf.readUInt16LE(localAt + 28);
    const raw = buf.subarray(dataAt, dataAt + compressed);
    const out = join(dir, name);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, method === 0 ? raw : inflateRawSync(raw));
  }
  return dir;
}

function sourceFile(recipe, unpacked) {
  return recipe.in ? join(unpacked[recipe.src], recipe.in) : join(cache, SOURCES[recipe.src].file);
}

function renderSfx(recipe, unpacked) {
  const src = sourceFile(recipe, unpacked);
  const tmp = join(cache, `_${recipe.out}.wav`);
  const out = join(sfxDir, `${recipe.out}.wav`);
  const cut = [...(recipe.ss ? ["-ss", String(recipe.ss)] : []), ...(recipe.t ? ["-t", String(recipe.t)] : [])];
  // Trim any lead-in silence so every one-shot fires the instant it's triggered.
  const tail = "silenceremove=start_periods=1:start_threshold=-50dB:start_silence=0.005,aformat=sample_fmts=s16:sample_rates=44100:channel_layouts=mono";

  if (recipe.layer) {
    // Two recordings into one hit: the second is delayed a few milliseconds and tucked underneath.
    const l = recipe.layer;
    const under = l.in ? join(unpacked[l.src], l.in) : join(cache, SOURCES[l.src].file);
    const ms = Math.round((l.delay ?? 0) * 1000);
    const graph = [
      `[0:a]${[recipe.filters, "aformat=channel_layouts=mono"].filter(Boolean).join(",")}[a]`,
      `[1:a]${[l.filters, "aformat=channel_layouts=mono", `volume=${l.gain ?? 0.8}`, ms ? `adelay=${ms}` : null].filter(Boolean).join(",")}[b]`,
      `[a][b]amix=inputs=2:duration=longest:normalize=0,${tail}[mixed]`,
    ].join(";");
    ff([...cut, "-i", src, "-i", under, "-filter_complex", graph, "-map", "[mixed]", "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", tmp]);
  } else {
    const chain = [recipe.filters, tail].filter(Boolean).join(",");
    ff([...cut, "-i", src, "-af", chain, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", tmp]);
  }
  const gain = (-1 - peakDb(tmp)).toFixed(2);
  ff(["-i", tmp, "-af", `volume=${gain}dB`, "-ac", "1", "-ar", "44100", "-c:a", "pcm_s16le", out]);
  rmSync(tmp, { force: true });
  return { out, gain };
}

function renderMusic(recipe) {
  const src = join(cache, SOURCES[recipe.src].file);
  const bar = (4 * 60) / recipe.bpm;
  const start = recipe.startBars * bar;
  const len = recipe.bars * bar;
  const xf = bar / 2; // half a bar of overlap: long enough to hide the seam, short enough to stay tight
  const seg = join(cache, `_${recipe.out}_seg.wav`);
  const loop = join(cache, `_${recipe.out}_loop.wav`);
  const out = join(musicDir, `${recipe.out}.mp3`);

  ff(["-ss", start.toFixed(3), "-t", (len + xf).toFixed(3), "-i", src, "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le", seg]);
  // Lay the tail back over the head, each fading through the other, so the wrap is inaudible.
  const graph = [
    `[0:a]atrim=0:${len.toFixed(3)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${xf.toFixed(3)}[head]`,
    `[0:a]atrim=${len.toFixed(3)}:${(len + xf).toFixed(3)},asetpts=PTS-STARTPTS,afade=t=out:st=0:d=${xf.toFixed(3)},adelay=0|0[tail]`,
    `[head][tail]amix=inputs=2:duration=first:normalize=0[mixed]`,
  ].join(";");
  ff(["-i", seg, "-filter_complex", graph, "-map", "[mixed]", "-c:a", "pcm_s16le", loop]);
  ff(["-i", loop, "-af", `loudnorm=I=${recipe.gain}:TP=-1.5:LRA=11`, "-c:a", "libmp3lame", "-b:a", "112k", out]);
  rmSync(seg, { force: true });
  rmSync(loop, { force: true });
  return { out, seconds: len };
}

function writeCredits(used) {
  const byLicense = (lic) => Object.values(SOURCES).filter((s) => s.license === lic);
  const line = (s) => `- **${s.what}** — [${s.file.replace(/\.[a-z0-9]+$/i, "")}](${s.page}) by ${s.author} (${s.license})`;
  const md = `# Audio credits

Every sound and every note in this game is royalty-free and used within its licence. Nothing is
sampled from another game. \`apps/web/scripts/build-audio.mjs\` downloads these sources and renders
the files in \`public/sfx\` and \`public/music\`.

## Music — Kevin MacLeod (CC-BY 4.0, attribution required)

${MUSIC.map((m) => {
  const s = SOURCES[m.src];
  const title = s.file.replace(/\.mp3$/, "");
  return `- **${title}** — ${m.bars} bars looped as \`public/music/${m.out}.mp3\` (${m.what ?? s.what})`;
}).join("\n")}

> "Cool Vibes", "Deadly Roulette", "Covert Affair" — Kevin MacLeod (incompetech.com)
> Licensed under Creative Commons: By Attribution 4.0 License
> http://creativecommons.org/licenses/by/4.0/

This credit is also shown in the app, on the lobby screen and at the end of Review the Tape.

## Sound effects (CC0 — public domain, no attribution required; credited anyway)

${byLicense("CC0").map(line).join("\n")}
`;
  writeFileSync(join(web, "public", "CREDITS.md"), md);
  writeFileSync(join(web, "..", "..", "CREDITS.md"), md);
  return used;
}

/* ───────────── go ───────────── */

async function main() {
  mkdirSync(cache, { recursive: true });
  mkdirSync(sfxDir, { recursive: true });
  mkdirSync(musicDir, { recursive: true });

  console.log("sources:");
  const files = {};
  for (const key of Object.keys(SOURCES)) files[key] = await download(key);

  const unpacked = {};
  for (const key of ARCHIVES) unpacked[key] = unpack(key, files[key]);

  console.log("\nsound effects:");
  for (const recipe of SFX) {
    const { gain } = renderSfx(recipe, unpacked);
    console.log(`  ${recipe.out.padEnd(10)} ${SOURCES[recipe.src].author.padEnd(18)} ${gain > 0 ? "+" : ""}${gain} dB`);
  }

  console.log("\nmusic loops:");
  for (const recipe of MUSIC) {
    const { seconds } = renderMusic(recipe);
    console.log(`  ${recipe.out.padEnd(10)} ${seconds.toFixed(1)}s loop @ ${recipe.bpm} bpm`);
  }

  writeCredits();
  console.log("\nwrote CREDITS.md");
}

await main();
