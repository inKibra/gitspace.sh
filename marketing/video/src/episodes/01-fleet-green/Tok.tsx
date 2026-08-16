import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Sequence,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from 'remotion';
import { T } from '../../lib/theme';
import { TL, CLICKS } from './timeline';
import { Product } from './index';
import { KineticCaptions, type CapLine } from '../../lib/Captions';
import { USER_MSG } from './scenes/DocsDetail';

/**
 * FleetGreenTok — 1080×1920 vertical cut, retention-pacing rules:
 * hook on frame 0 (no intro), snap punch-ins on every state change / click,
 * uneven cut timing, captions inside the safe zone, loop-friendly ending.
 * The product plane is the same 1920×1080 Product; a snap camera crops it.
 * No deck bookends; product frames == global frames (pf = frame).
 */

const TOTAL = 420; // 14s

// ── snap camera: segments over the product plane (uneven 2–4s cuts) ─────────
interface Seg {
  from: number;
  scale: number;
  cx: number; // product point centered horizontally
  cy: number; // product point centered vertically
}

const SEGS: Seg[] = [
  { from: 0, scale: 0.62, cx: 960, cy: 430 }, // board wide — frame 0 is the fleet
  { from: TL.flagsAsk, scale: 1.05, cx: 640, cy: 470 }, // punch: the amber card
  { from: TL.clickFlagsChip - 4, scale: 1.35, cx: 775, cy: 240 }, // strip chip
  { from: TL.pushEnd, scale: 0.62, cx: 960, cy: 480 }, // flags detail wide
  { from: TL.modalIn, scale: 1.02, cx: 960, cy: 540 }, // the ask modal
  { from: TL.clickOption, scale: 1.12, cx: 900, cy: 520 }, // punch: option
  { from: TL.clickSubmit, scale: 1.2, cx: 1080, cy: 640 }, // punch: submit
  { from: TL.modalGone, scale: 0.62, cx: 960, cy: 480 }, // resumed
  { from: TL.clickDocsChip - 4, scale: 1.35, cx: 1315, cy: 240 }, // docs chip
  { from: TL.slideEnd, scale: 0.62, cx: 960, cy: 480 }, // docs detail wide
  { from: TL.typeStart, scale: 1.3, cx: 960, cy: 820 }, // punch: the input
  { from: TL.docsGreen, scale: 1.0, cx: 960, cy: 500 }, // strip goes all green
  { from: TL.pullEnd - 6, scale: 0.62, cx: 960, cy: 430 }, // board wide (= frame 0 → loop)
];

const SNAP = 4; // frames per snap-zoom

const camera = (frame: number) => {
  let idx = 0;
  for (let i = 0; i < SEGS.length; i++) if (frame >= SEGS[i]!.from) idx = i;
  const cur = SEGS[idx]!;
  const prev = idx > 0 ? SEGS[idx - 1]! : cur;
  const t = interpolate(frame, [cur.from, cur.from + SNAP], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.cubic),
  });
  return {
    scale: prev.scale + (cur.scale - prev.scale) * t,
    cx: prev.cx + (cur.cx - prev.cx) * t,
    cy: prev.cy + (cur.cy - prev.cy) * t,
  };
};

// ── captions: safe zone (center 900×1400), body above the bottom UI band ────
const TOK_CAPTIONS: CapLine[] = [
  {
    // hook ON frame 0 — most viewers watch muted; negative times = pre-popped
    y: 260, size: 72, out: 54,
    words: [
      { w: 'Babysitting', at: -8 },
      { w: 'agents', at: -5 },
      { w: "doesn't", at: -2, color: T.accent },
      { w: 'have', at: 0 },
      { w: 'to', at: 2 },
      { w: 'suck.', at: 4 },
    ],
  },
  {
    y: 1400, size: 54, out: 100,
    words: [
      { w: 'This', at: 58 },
      { w: 'is', at: 61 },
      { w: 'your', at: 64 },
      { w: 'fleet.', at: 67, color: T.accent },
    ],
  },
  {
    y: 1400, size: 54, out: 176,
    words: [
      { w: 'Blue', at: 92, color: T.waiting },
      { w: 'is', at: 96 },
      { w: 'idle.', at: 99, color: T.waiting },
      { w: 'Amber', at: 106, color: T.needsInput },
      { w: 'has', at: 110 },
      { w: 'a', at: 113 },
      { w: 'question.', at: 116, color: T.needsInput },
    ],
  },
  {
    y: 1400, size: 54, out: 262,
    words: [
      { w: 'One', at: 225 },
      { w: 'answer…', at: 229 },
    ],
  },
  {
    y: 1400, size: 54, out: 354,
    words: [
      { w: '…one', at: 336 },
      { w: 'nudge…', at: 340 },
    ],
  },
  {
    y: 1400, size: 54, out: 400,
    words: [
      { w: '…and', at: 358 },
      { w: "everything's", at: 362 },
      { w: 'moving', at: 366 },
      { w: 'again.', at: 370, color: T.accent },
    ],
  },
  {
    // loop sentence: rises toward the hook position as the board matches frame 0
    y: 620, size: 64, out: TOTAL - 2,
    words: [
      { w: 'Keep', at: 392 },
      { w: 'your', at: 396 },
      { w: 'fleet', at: 400, color: T.accent },
      { w: 'green.', at: 404, color: T.accent },
    ],
  },
];

/** Same key-thock pacing logic as the main cut. */
const typingFrames = (start: number, cps: number, chars: number): number[] => {
  const frames: number[] = [];
  let prev = 0;
  for (let f = start; prev < chars && f < start + 400; f++) {
    const n = Math.min(chars, Math.max(0, Math.floor((f - start) * cps)));
    if (n > prev) frames.push(f);
    prev = n;
  }
  return frames;
};
const KEYS = typingFrames(TL.typeStart, 1.15, USER_MSG.length).filter(
  (_, i, a) => i % 3 === 0 || i === a.length - 1,
);

export const FleetGreenTok: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const { scale, cx, cy } = camera(frame);

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {/* ── audio (product cues; pad ducks out at the end for the loop) ── */}
      <Audio
        src={staticFile('audio/pad.wav')}
        volume={(f) =>
          interpolate(f, [0, 20, TOTAL - 30, TOTAL - 4], [0, 0.9, 0.9, 0], {
            extrapolateLeft: 'clamp',
            extrapolateRight: 'clamp',
          })
        }
      />
      {CLICKS.map((at) => (
        <Sequence key={`click-${at}`} from={at}>
          <Audio src={staticFile('audio/click.wav')} volume={0.75} />
        </Sequence>
      ))}
      <Sequence from={TL.docsIdle}>
        <Audio src={staticFile('audio/droplet-blue.wav')} volume={0.7} />
      </Sequence>
      <Sequence from={TL.flagsAsk}>
        <Audio src={staticFile('audio/droplet-amber.wav')} volume={0.7} />
      </Sequence>
      <Sequence from={TL.flagsGreen}>
        <Audio src={staticFile('audio/bloom-flags.wav')} volume={0.65} />
      </Sequence>
      <Sequence from={TL.docsGreen}>
        <Audio src={staticFile('audio/bloom-docs.wav')} volume={0.65} />
      </Sequence>
      {[TL.pushStart, TL.slideStart, TL.pullStart].map((at) => (
        <Sequence key={`whoosh-${at}`} from={at}>
          <Audio src={staticFile('audio/whoosh.wav')} volume={0.55} />
        </Sequence>
      ))}
      <Sequence from={392}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.55} />
      </Sequence>
      {KEYS.map((at, i) => (
        <Sequence key={`k-${at}`} from={at}>
          <Audio src={staticFile(`audio/key-${(i % 4) + 1}.wav`)} volume={0.4} />
        </Sequence>
      ))}

      {/* ── product plane under a snap camera ── */}
      <div
        style={{
          position: 'absolute',
          width: 1920,
          height: 1080,
          transformOrigin: '0 0',
          transform: `translate(${540 - cx * scale}px, ${960 - cy * scale}px) scale(${scale})`,
        }}
      >
        <Product pf={frame} fps={fps} />
      </div>

      {/* ── captions in the safe zone ── */}
      <KineticCaptions frame={frame} lines={TOK_CAPTIONS} />
    </AbsoluteFill>
  );
};
