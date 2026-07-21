/**
 * Synthesizes the video's sound palette as WAV files in public/audio/.
 * Cuelume-inspired: small synthesized cues (droplet, bloom, click) plus an
 * ethereal game-loading-screen pad. Deterministic — seeded noise, no Math.random.
 *
 * Run: bun scripts/gen-audio.ts
 */

const SR = 44100;

// ── helpers ──────────────────────────────────────────────────────────────────

/** Seeded PRNG (mulberry32) so noise is deterministic. */
const prng = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const wav = (left: Float64Array, right: Float64Array): Uint8Array => {
  const n = left.length;
  const data = new DataView(new ArrayBuffer(44 + n * 4));
  const str = (o: number, s: string) => [...s].forEach((c, i) => data.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  data.setUint32(4, 36 + n * 4, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, 2, true); // stereo
  data.setUint32(24, SR, true);
  data.setUint32(28, SR * 4, true);
  data.setUint16(32, 4, true);
  data.setUint16(34, 16, true);
  str(36, 'data');
  data.setUint32(40, n * 4, true);
  for (let i = 0; i < n; i++) {
    const l = Math.max(-1, Math.min(1, left[i]!));
    const r = Math.max(-1, Math.min(1, right[i]!));
    data.setInt16(44 + i * 4, l * 32767, true);
    data.setInt16(46 + i * 4, r * 32767, true);
  }
  return new Uint8Array(data.buffer);
};

const buf = (seconds: number): [Float64Array, Float64Array] => {
  const n = Math.round(seconds * SR);
  return [new Float64Array(n), new Float64Array(n)];
};

const TAU = Math.PI * 2;

/** Exponentially decaying sine partial added into l/r. */
const bell = (
  l: Float64Array,
  r: Float64Array,
  startSec: number,
  freq: number,
  amp: number,
  decaySec: number,
  pan = 0, // -1..1
) => {
  const start = Math.round(startSec * SR);
  const dur = Math.min(l.length - start, Math.round(decaySec * 5 * SR));
  const gl = amp * (1 - pan * 0.5);
  const gr = amp * (1 + pan * 0.5);
  for (let i = 0; i < dur; i++) {
    const t = i / SR;
    const env = Math.exp(-t / decaySec) * Math.min(1, t / 0.004); // 4ms attack, no click
    const s = Math.sin(TAU * freq * t) * env;
    l[start + i]! += s * gl;
    r[start + i]! += s * gr;
  }
};

const write = async (name: string, l: Float64Array, r: Float64Array) => {
  const path = new URL(`../public/audio/${name}.wav`, import.meta.url).pathname;
  await Bun.write(path, wav(l, r));
  console.log(`✓ ${name}.wav (${(l.length / SR).toFixed(2)}s)`);
};

// ── pad v2: evolving ethereal bed, 19.4s ────────────────────────────────────
// Chord journey instead of a static drone: A(add9) → Fmaj7 → C(add9) → home.
// Sections crossfade; a soft quarter-note pluck arp gives it motion.
{
  const DUR = 19.4;
  const [l, r] = buf(DUR);
  const smooth = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
  const XF = 1.8; // crossfade seconds between sections
  const SECTIONS = [
    { t0: 0.0, t1: 5.0, root: 55.0, freqs: [110.0, 164.81, 246.94, 293.66] }, // A add9
    { t0: 5.0, t1: 9.5, root: 43.65, freqs: [87.31, 130.81, 164.81, 220.0] }, // Fmaj7
    { t0: 9.5, t1: 14.0, root: 65.41, freqs: [130.81, 196.0, 293.66, 329.63] }, // C add9
    { t0: 14.0, t1: DUR, root: 55.0, freqs: [110.0, 164.81, 246.94, 293.66] }, // A home
  ];
  const AMPS = [0.05, 0.045, 0.038, 0.03];
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const master = Math.min(1, t / 2.2) * Math.min(1, (DUR - t) / 2.2);
    let sl = 0;
    let sr = 0;
    for (const s of SECTIONS) {
      const env = smooth((t - s.t0 + XF / 2) / XF) * (1 - smooth((t - s.t1 + XF / 2) / XF));
      if (env <= 0) continue;
      for (let j = 0; j < s.freqs.length; j++) {
        const f = s.freqs[j]!;
        const trem = 0.75 + 0.25 * Math.sin(TAU * (0.07 + j * 0.02) * t + j * 1.7);
        sl += Math.sin(TAU * f * 0.9988 * t + j) * AMPS[j]! * trem * env;
        sr += Math.sin(TAU * f * 1.0012 * t + j) * AMPS[j]! * trem * env;
      }
      // sub root + high shimmer
      sl += Math.sin(TAU * s.root * t) * 0.026 * env;
      sr += Math.sin(TAU * s.root * t) * 0.026 * env;
      const shim = Math.sin(TAU * s.root * 16 * t) * 0.004 * env * (0.6 + 0.4 * Math.sin(TAU * 0.09 * t));
      sl += shim;
      sr += shim;
    }
    // 120bpm heartbeat, quieter than v1
    const beatT = t % 0.5;
    const pulse = Math.exp(-beatT / 0.03) * Math.sin(TAU * 220 * beatT) * 0.01;
    l[i] = (sl + pulse) * master;
    r[i] = (sr + pulse) * master;
  }
  // quarter-note pluck arp cycling chord tones an octave up (the motion layer)
  for (let k = 0; k * 0.5 + 0.25 < DUR - 0.5; k++) {
    const time = k * 0.5 + 0.25;
    const s = SECTIONS.find((x) => time >= x.t0 && time < x.t1) ?? SECTIONS[0]!;
    const f = s.freqs[k % 4]! * 2;
    bell(l, r, time, f, 0.032, 0.22, k % 2 === 0 ? -0.35 : 0.35);
    bell(l, r, time, f * 2.003, 0.008, 0.15, k % 2 === 0 ? -0.35 : 0.35);
  }
  await write('pad', l, r);
}

// ── click: tiny tick (press) ────────────────────────────────────────────────
{
  const [l, r] = buf(0.09);
  const rand = prng(7);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const noise = (rand() * 2 - 1) * Math.exp(-t / 0.004) * 0.25;
    const tick = Math.sin(TAU * 2000 * t) * Math.exp(-t / 0.012) * 0.5;
    const body = Math.sin(TAU * 340 * t) * Math.exp(-t / 0.02) * 0.2;
    l[i] = r[i] = noise + tick + body;
  }
  await write('click', l, r);
}

// ── droplets: a dot turns (problem appears) — soft falling pitch ────────────
const droplet = async (name: string, f0: number, pan: number) => {
  const [l, r] = buf(0.7);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const glide = f0 * (1 - 0.16 * Math.min(1, t / 0.18)); // slide down a whole-ish step
    const env = Math.exp(-t / 0.22) * Math.min(1, t / 0.008);
    const s = (Math.sin(TAU * glide * t) + 0.35 * Math.sin(TAU * glide * 2.02 * t)) * env * 0.32;
    l[i] = s * (1 - pan * 0.5);
    r[i] = s * (1 + pan * 0.5);
  }
  await write(name, l, r);
};
await droplet('droplet-blue', 740, 0.4); // docs-refresh goes idle
await droplet('droplet-amber', 587.33, -0.3); // checkout-flags asks

// ── blooms: a dot resolves (user fixed it) — rising two-note chime ──────────
const bloom = async (name: string, fA: number, fB: number) => {
  const [l, r] = buf(1.6);
  bell(l, r, 0, fA, 0.2, 0.28, -0.3);
  bell(l, r, 0, fA * 2.004, 0.05, 0.2, -0.3);
  bell(l, r, 0.11, fB, 0.24, 0.45, 0.3);
  bell(l, r, 0.11, fB * 2.006, 0.06, 0.3, 0.3);
  bell(l, r, 0.11, fB * 2.997, 0.02, 0.22, 0);
  await write(name, l, r);
};
await bloom('bloom-flags', 659.25, 880); // E5 → A5
await bloom('bloom-docs', 880, 1318.51); // A5 → E6 (brighter: second win)

// ── whoosh: camera moves — filtered noise swell ─────────────────────────────
{
  const [l, r] = buf(0.55);
  const rand = prng(21);
  let lpL = 0;
  let lpR = 0;
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const x = t / 0.55;
    const env = Math.sin(Math.PI * Math.min(1, x)) ** 2 * 0.16;
    const cutoff = 300 + 2600 * Math.sin(Math.PI * x); // sweep up then down
    const k = 1 - Math.exp((-TAU * cutoff) / SR);
    lpL += k * ((rand() * 2 - 1) - lpL);
    lpR += k * ((rand() * 2 - 1) - lpR);
    l[i] = lpL * env;
    r[i] = lpR * env;
  }
  await write('whoosh', l, r);
}

// ── key presses: soft laptop thocks, four variants so typing patters ────────
const key = async (name: string, seed: number, thump: number, noiseCut: number) => {
  const [l, r] = buf(0.06);
  const rand = prng(seed);
  let lp = 0;
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const k = 1 - Math.exp((-TAU * noiseCut) / SR);
    lp += k * ((rand() * 2 - 1) - lp);
    const noise = lp * Math.exp(-t / 0.006) * 0.55;
    const body = Math.sin(TAU * thump * t) * Math.exp(-t / 0.012) * 0.3;
    const s = (noise + body) * Math.min(1, t / 0.001);
    l[i] = s * 0.95;
    r[i] = s * 1.05;
  }
  await write(name, l, r);
};
await key('key-1', 101, 196, 2600);
await key('key-2', 202, 178, 3100);
await key('key-3', 303, 214, 2300);
await key('key-4', 404, 187, 2900);

// ── sparkle: end-card garnish — tiny cluster ────────────────────────────────
{
  const [l, r] = buf(1.4);
  bell(l, r, 0.0, 1760, 0.09, 0.3, -0.5);
  bell(l, r, 0.07, 2217.46, 0.07, 0.32, 0.5);
  bell(l, r, 0.15, 2637.02, 0.055, 0.4, 0);
  await write('sparkle', l, r);
}

// ── riser: deck flythrough build-up, peaks at the match-cut (1.5s) ──────────
{
  const [l, r] = buf(2.05);
  const rand = prng(33);
  let lp = 0;
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const x = Math.min(1, t / 2.0);
    const env = x * x * 0.2 * Math.min(1, (2.05 - t) / 0.05);
    const cutoff = 200 + 3800 * x * x;
    const k = 1 - Math.exp((-TAU * cutoff) / SR);
    lp += k * ((rand() * 2 - 1) - lp);
    const tone = Math.sin(TAU * (70 + 180 * x * x) * t) * 0.35;
    const s = (lp + tone) * env;
    l[i] = s;
    r[i] = s;
  }
  await write('riser', l, r);
}

// ── thunk: card selected — deep soft impact ─────────────────────────────────
{
  const [l, r] = buf(0.6);
  const rand = prng(55);
  for (let i = 0; i < l.length; i++) {
    const t = i / SR;
    const sub = Math.sin(TAU * 52 * t) * Math.exp(-t / 0.16) * 0.4;
    const body = Math.sin(TAU * 84 * t) * Math.exp(-t / 0.09) * 0.3;
    const snap = (rand() * 2 - 1) * Math.exp(-t / 0.005) * 0.18;
    const s = (sub + body + snap) * Math.min(1, t / 0.002);
    l[i] = s;
    r[i] = s;
  }
  await write('thunk', l, r);
}

console.log('done.');
