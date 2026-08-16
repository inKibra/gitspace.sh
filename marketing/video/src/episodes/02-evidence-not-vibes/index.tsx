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
import { loadFont } from '@remotion/google-fonts/JetBrainsMono';
// NOTE: no VO track yet — the real recording lands here later:
// import voSrc from './vo.wav';   // → mastered vo-02.wav (see ../../README.md)
import { T } from '../../lib/theme';
import { TL, CLICKS, DECK } from './timeline';
import { HUMAN_LINE } from './rubric';
import { Cursor } from '../../lib/ui';
import { PlanSurface } from './scenes/PlanSurface';
import { ReviewSurface, REVIEW } from './scenes/ReviewSurface';
import { ChromeBar, type ActiveChip } from './scenes/ChromeBar';
import { Deck, TAGLINE, STINGER } from './Deck';
import { KineticCaptions, type CapLine } from '../../lib/Captions';

loadFont();

const P = DECK.matchCut; // product-local frame offset (deck intro = 4 beats)
const ease = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// ── global cursor path (product frames): the human reviews the evidence ──────
// Act 2 only. Every click target holds through its click window so the ring
// never fires mid-flight.
const CURSOR_TS = [
  TL.cursorIn, TL.req1JudgeIn, TL.req1CmdResult, TL.videoPlay, TL.videoEnd - 10,
  TL.req2Accept, TL.readyType, TL.act2End,
];
const CURSOR_XS = [
  1520, REVIEW.row1.statusPt.x, REVIEW.row1.judgePt.x, REVIEW.video.playPt.x, REVIEW.video.playPt.x,
  REVIEW.row2.statusPt.x, REVIEW.readyPt.x, 240,
];
const CURSOR_YS = [
  240, REVIEW.row1.statusPt.y, REVIEW.row1.judgePt.y, REVIEW.video.playPt.y, REVIEW.video.playPt.y,
  REVIEW.row2.statusPt.y, REVIEW.readyPt.y, 1000,
];

/** Frames where typed() reveals a new character (mirrors ui.typed math). */
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

// key thock every 3rd revealed char (~11/s) plus the final one — never 30Hz.
const everyThird = (frames: number[]): number[] =>
  frames.filter((_, i) => i % 3 === 0 || i === frames.length - 1);

const HUMAN_KEYS = everyThird(typingFrames(TL.humanType + P, 1.2, HUMAN_LINE.length));
const CMD_KEYS = everyThird(typingFrames(TL.req1CmdRun + P, 1.9, 21));
const READY_KEYS = everyThird(typingFrames(TL.readyType + P, 1.25, 46));
const TAG_KEYS = everyThird(typingFrames(DECK.tagType, 1.35, TAGLINE.length));
const STING_KEYS = everyThird(typingFrames(DECK.stingerType, 1.35, STINGER.length));

// ── VO captions — PLACEHOLDER word timings (main retimes to vo-02.wav) ───────
const H = T.running; // human green
const A = T.waiting; // agent blue
// Windows are strictly sequential — each line's `out` is ≥8 frames before the
// next line's first word, so two lines never share the y=880 band at once.
const MAIN_CAPTIONS: CapLine[] = [
  {
    // "Before it starts, we agree on what done means."
    y: 872, size: 46, out: 150,
    words: [
      { w: 'Before', at: 78 }, { w: 'it', at: 84 }, { w: 'starts,', at: 89 },
      { w: 'we', at: 98 }, { w: 'agree', at: 103 }, { w: 'on', at: 110 },
      { w: 'what', at: 115 }, { w: 'done', at: 121, color: T.accent }, { w: 'means.', at: 127 },
    ],
  },
  {
    // "I set the bar. The agent writes the checks."
    y: 872, size: 46, out: 214,
    words: [
      { w: 'I', at: 160, color: H }, { w: 'set', at: 165 }, { w: 'the', at: 170 },
      { w: 'bar.', at: 175, color: H }, { w: 'The', at: 185 }, { w: 'agent', at: 190, color: A },
      { w: 'writes', at: 197 }, { w: 'the', at: 203 }, { w: 'checks.', at: 208 },
    ],
  },
  {
    // "A test that has to pass. A video of the feature working."
    y: 872, size: 44, out: 288,
    words: [
      { w: 'A', at: 224 }, { w: 'test', at: 229, color: T.accent }, { w: 'that', at: 235 },
      { w: 'has', at: 240 }, { w: 'to', at: 244 }, { w: 'pass.', at: 248, color: T.accent },
      { w: 'A', at: 260 }, { w: 'video', at: 265, color: A }, { w: 'of', at: 272 },
      { w: 'the', at: 276 }, { w: 'feature', at: 280 }, { w: 'working.', at: 286 },
    ],
  },
  {
    // "This agent says it's done. Now it has to prove it."
    y: 872, size: 46, out: 368,
    words: [
      { w: 'This', at: 298 }, { w: 'agent', at: 304, color: A }, { w: 'says', at: 311 },
      { w: "it's", at: 317 }, { w: 'done.', at: 322, color: A }, { w: 'Now', at: 340 },
      { w: 'it', at: 346 }, { w: 'has', at: 351 }, { w: 'to', at: 356 },
      { w: 'prove', at: 360, color: T.accent }, { w: 'it.', at: 366 },
    ],
  },
  {
    // "This test passes. And the video looks right."
    y: 872, size: 44, out: 430,
    words: [
      { w: 'This', at: 378 }, { w: 'test', at: 383, color: T.accent }, { w: 'passes.', at: 389, color: T.accent },
      { w: 'And', at: 404 }, { w: 'the', at: 409 }, { w: 'video', at: 414, color: A },
      { w: 'looks', at: 421 }, { w: 'right.', at: 427 },
    ],
  },
  {
    // "The reviewer was looking at the right thing. Every check accepted."
    y: 820, size: 44, out: 512,
    words: [
      { w: 'The', at: 440 }, { w: 'reviewer', at: 445 }, { w: 'was', at: 453 },
      { w: 'looking', at: 458 }, { w: 'at', at: 465 }, { w: 'the', at: 469 },
      { w: 'right', at: 473, color: T.accent }, { w: 'thing.', at: 480 },
      { w: 'Every', at: 494 }, { w: 'check', at: 500, color: T.accent }, { w: 'accepted.', at: 506, color: T.accent },
    ],
  },
];

// Caption windows (global frames) for gentle pad ducking (proxy for VO).
const VO_SEGMENTS: Array<[number, number]> = [
  [78, 130], [160, 210], [224, 288], [298, 368], [378, 429], [440, 508],
];
const padDuck = (f: number): number => {
  for (const [a, b] of VO_SEGMENTS) {
    if (f >= a - 10 && f <= b + 16) {
      const in_ = Math.min(1, Math.max(0, (f - (a - 10)) / 10));
      const out_ = Math.min(1, Math.max(0, ((b + 16) - f) / 16));
      return 0.85 - 0.22 * Math.min(in_, out_);
    }
  }
  return 0.85;
};

/** The product story, in product-local frames (pf). */
export const Product: React.FC<{ pf: number; fps: number }> = ({ pf, fps: _fps }) => {
  // ── camera: plan surface slides out left, review surface slides in ──
  const planSlideX = interpolate(pf, [TL.slideStart, TL.slideEnd], [0, -1920], { ...clamp, easing: ease });
  const planOpacity = interpolate(pf, [TL.slideStart, TL.slideEnd - 3], [1, 0], clamp);
  const reviewSlideX = interpolate(pf, [TL.slideStart, TL.slideEnd], [1920, 0], { ...clamp, easing: ease });
  const reviewScale = interpolate(pf, [TL.slideStart, TL.slideEnd], [1.04, 1], { ...clamp, easing: ease });

  const showPlan = pf < TL.slideEnd;
  const showReview = pf >= TL.slideStart;

  // ── chrome bar active chip: goal (Act 1) → checkout-refactor (Act 2) ──
  const active: ActiveChip = pf < TL.slideStart + 7 ? 'goal' : 'checkout';

  // ── cursor (Act 2 only) ──
  const cx = interpolate(pf, CURSOR_TS, CURSOR_XS, { ...clamp, easing: ease });
  const cy = interpolate(pf, CURSOR_TS, CURSOR_YS, { ...clamp, easing: ease });
  const cursorOpacity =
    interpolate(pf, [TL.cursorIn, TL.cursorIn + 6], [0, 1], clamp) *
    interpolate(pf, [TL.act2End - 8, TL.act2End], [1, 0], clamp);
  const click = CLICKS.reduce((acc, at) => (pf >= at && pf <= at + 12 ? (pf - at) / 12 : acc), 0);

  // ── click punch: subtle whole-frame zoom snap toward the click point ──
  const CLICK_POINTS = [REVIEW.row1.statusPt, REVIEW.video.playPt];
  let punch = 0;
  let punchAt = { x: 960, y: 540 };
  CLICKS.forEach((at, i) => {
    const d = pf - at;
    if (d >= 0 && d <= 28) {
      punch = d < 3 ? Easing.out(Easing.cubic)(d / 3) : d < 8 ? 1 : 1 - Easing.inOut(Easing.cubic)((d - 8) / 20);
      punchAt = CLICK_POINTS[i]!;
    }
  });
  const punchScale = 1 + 0.028 * punch;

  return (
    <AbsoluteFill
      style={{
        background: T.bg,
        transform: `scale(${punchScale})`,
        transformOrigin: `${punchAt.x}px ${punchAt.y}px`,
      }}
    >
      {showPlan && (
        <AbsoluteFill style={{ transform: `translateX(${planSlideX}px)`, opacity: planOpacity }}>
          <PlanSurface frame={pf} />
        </AbsoluteFill>
      )}
      {showReview && (
        <AbsoluteFill style={{ transform: `translateX(${reviewSlideX}px) scale(${reviewScale})` }}>
          <ReviewSurface frame={pf} />
        </AbsoluteFill>
      )}

      {/* global chrome bar — fixed above every view, like the product */}
      <ChromeBar frame={pf} active={active} />

      {/* the human's cursor — the review is user-driven */}
      {cursorOpacity > 0.001 && (
        <div style={{ opacity: cursorOpacity }}>
          <Cursor x={cx} y={cy} click={click} />
        </div>
      )}
    </AbsoluteFill>
  );
};

export const EvidenceNotVibes: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pf = frame - P;

  const inDeck = frame < P || frame >= DECK.outStart;
  const product = <Product pf={pf} fps={fps} />;

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {/* ── soundtrack: pad (ducked under caption windows) + synthesized cues ──
          VO slot is intentionally empty — vo-02.wav lands here later. */}
      {/* <Audio src={voSrc} volume={1} /> */}
      <Audio src={staticFile('audio/pad.wav')} volume={(f) => padDuck(f)} />
      <Audio src={staticFile('audio/riser.wav')} volume={0.8} />
      <Sequence from={DECK.select}>
        <Audio src={staticFile('audio/thunk.wav')} volume={0.8} />
      </Sequence>

      {/* click rings */}
      {CLICKS.map((at) => (
        <Sequence key={`click-${at}`} from={at + P}>
          <Audio src={staticFile('audio/click.wav')} volume={0.75} />
        </Sequence>
      ))}

      {/* the workspace goes BLUE — idle, your move */}
      <Sequence from={TL.agentDone + P}>
        <Audio src={staticFile('audio/droplet-blue.wav')} volume={0.7} />
      </Sequence>

      {/* the two accept-blooms */}
      <Sequence from={TL.req1Accept + P}>
        <Audio src={staticFile('audio/bloom-flags.wav')} volume={0.65} />
      </Sequence>
      <Sequence from={TL.req2Accept + P}>
        <Audio src={staticFile('audio/bloom-docs.wav')} volume={0.68} />
      </Sequence>

      {/* readiness type — bright cluster */}
      <Sequence from={TL.readyType + P}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.55} />
      </Sequence>

      {/* camera whooshes: act transition, deck outro */}
      {[TL.slideStart + P, DECK.outStart].map((at) => (
        <Sequence key={`whoosh-${at}`} from={at}>
          <Audio src={staticFile('audio/whoosh.wav')} volume={0.55} />
        </Sequence>
      ))}
      <Sequence from={DECK.deckBack}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.5} />
      </Sequence>

      {/* typing thocks */}
      {[...HUMAN_KEYS, ...CMD_KEYS, ...READY_KEYS].map((at, i) => (
        <Sequence key={`type-${at}-${i}`} from={at}>
          <Audio src={staticFile(`audio/key-${(i % 4) + 1}.wav`)} volume={0.38} />
        </Sequence>
      ))}
      {[...TAG_KEYS, ...STING_KEYS].map((at, i) => (
        <Sequence key={`tagkey-${at}-${i}`} from={at}>
          <Audio src={staticFile(`audio/key-${((i + 2) % 4) + 1}.wav`)} volume={0.26} />
        </Sequence>
      ))}

      {/* ── one snippet in a deck of snippets ── */}
      {inDeck ? <Deck frame={frame}>{product}</Deck> : product}

      {/* ── VO captions (placeholder timings; muted viewers read the voice) ── */}
      <KineticCaptions frame={frame} lines={MAIN_CAPTIONS} />
    </AbsoluteFill>
  );
};
