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
import voSrc from './vo.wav';
import { T } from '../../lib/theme';
import { TL, CLICKS } from './timeline';
import { DECK, INTRO_SHIFT } from './timeline';
import { FLAGS_CARD_CENTER, DOCS_CARD_CENTER, chipCenterX, CHIP } from './fleet';
import { Cursor } from '../../lib/ui';
import { Board } from './scenes/Board';
import { FlagsDetail } from './scenes/FlagsDetail';
import { DocsDetail, SEND, INPUT, USER_MSG } from './scenes/DocsDetail';
import { AskDialog, MODAL_TARGETS } from './scenes/AskDialog';
import { ChromeBar, type ActiveChip } from './scenes/ChromeBar';
import { Deck, EndCard, TAGLINE } from './Deck';
import { KineticCaptions, type CapLine } from '../../lib/Captions';
import { FaultyTerminalFrame } from '../../lib/FaultyTerminalFrame';
import { ParticleScrollFrame } from '../../lib/ParticleScrollFrame';

loadFont();

const P = DECK.matchCut; // product-local frame offset (deck intro = 5 beats)
/**
 * The intro grew 60 → 150 frames for the dissolve. The VO is a REAL recording
 * and the captions below are already retimed to it, so nothing here gets
 * re-typed: the voice, the captions and the pad ducking all shift by the same
 * INTRO_SHIFT. A uniform offset preserves sync exactly; retiming would not.
 */

const ease = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

// ── global cursor path: the user drives every resolution (product frames) ───
const FLAGS_CHIP = { x: chipCenterX(1), y: CHIP.centerY };
const DOCS_CHIP = { x: chipCenterX(3), y: CHIP.centerY };

// Every click target gets a hold window so the ring never fires mid-flight.
const CURSOR_TS = [TL.cursorIn, 103, 130, 150, 168, 182, 192, 202, 218, 250, 272, 292, 300, 332, 340, 352];
const CURSOR_XS = [
  1500, FLAGS_CHIP.x, FLAGS_CHIP.x, 900,
  MODAL_TARGETS.option1.x, MODAL_TARGETS.option2.x, MODAL_TARGETS.option1.x, MODAL_TARGETS.option1.x,
  MODAL_TARGETS.submit.x,
  DOCS_CHIP.x, DOCS_CHIP.x, 900, 900, SEND.x, SEND.x, 1600,
];
const CURSOR_YS = [
  300, FLAGS_CHIP.y, FLAGS_CHIP.y, 400,
  MODAL_TARGETS.option1.y, MODAL_TARGETS.option2.y, MODAL_TARGETS.option1.y, MODAL_TARGETS.option1.y,
  MODAL_TARGETS.submit.y,
  DOCS_CHIP.y, DOCS_CHIP.y, INPUT.y + 28, INPUT.y + 28, SEND.y, SEND.y, 860,
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

// Text reveals at ~34 chars/sec (demo speed); a sound per char is a 30Hz buzz,
// not typing. Sample every 3rd char (~11 thocks/sec) plus the final one.
const everyThird = (frames: number[]): number[] =>
  frames.filter((_, i) => i % 3 === 0 || i === frames.length - 1);

const MSG_KEY_FRAMES = everyThird(typingFrames(TL.typeStart + P, 1.15, USER_MSG.length));
const TAG_KEY_FRAMES = everyThird(typingFrames(DECK.tagType, 1.35, TAGLINE.length));

// ── VO captions — retimed to the recorded take (vo.wav, take 1) ─────────────
// Word times follow the ACTUAL read (silencedetect phrase boundaries × 30fps).
// Last line ("Keep your fleet green.") is the typed tagline, not a caption.
const MAIN_CAPTIONS: CapLine[] = [
  {
    y: 640, size: 60, out: 104,
    words: [
      { w: 'Babysitting', at: 27 },
      { w: 'agents', at: 36 },
      { w: "doesn't", at: 45, color: T.accent },
      { w: 'have', at: 53 },
      { w: 'to', at: 60 },
      { w: 'suck.', at: 67 },
    ],
  },
  {
    y: 880, size: 44, out: 168,
    words: [
      { w: 'This', at: 125 },
      { w: 'is', at: 131 },
      { w: 'your', at: 137 },
      { w: 'fleet.', at: 143, color: T.accent },
    ],
  },
  {
    y: 880, size: 44, out: 285,
    words: [
      { w: 'Blue', at: 176, color: T.waiting },
      { w: 'means', at: 183 },
      { w: 'idle.', at: 190, color: T.waiting },
      { w: 'Amber', at: 228, color: T.needsInput },
      { w: 'means', at: 235 },
      { w: 'it', at: 240 },
      { w: 'has', at: 245 },
      { w: 'a', at: 249 },
      { w: 'question.', at: 254, color: T.needsInput },
    ],
  },
  {
    y: 880, size: 44, out: 355,
    words: [
      { w: 'One', at: 322 },
      { w: 'answer…', at: 330 },
    ],
  },
  {
    y: 880, size: 44, out: 415,
    words: [
      { w: '…one', at: 378 },
      { w: 'nudge…', at: 386 },
    ],
  },
  {
    y: 880, size: 44, out: 490,
    words: [
      { w: '…and', at: 447 },
      { w: "everything's", at: 453 },
      { w: 'moving', at: 461 },
      { w: 'again.', at: 468, color: T.accent },
    ],
  },
];

// Speech segments (frames) for pad ducking under the voice.
const VO_SEGMENTS: Array<[number, number]> = [
  [27, 91], [125, 147], [176, 204], [228, 270],
  [322, 344], [378, 410], [447, 482], [511, 546],
];

const padDuck = (f: number): number => {
  for (const [a, b] of VO_SEGMENTS) {
    if (f >= a - 10 && f <= b + 16) {
      const in_ = Math.min(1, Math.max(0, (f - (a - 10)) / 10));
      const out_ = Math.min(1, Math.max(0, ((b + 16) - f) / 16));
      return 0.85 - 0.23 * Math.min(in_, out_); // gentle duck to ~0.62
    }
  }
  return 0.85;
};

/** The product story, in product-local frames (pf). */
export const Product: React.FC<{ pf: number; fps: number }> = ({ pf, fps }) => {
  // ── camera ──
  const origin = pf < TL.pullStart ? FLAGS_CARD_CENTER : DOCS_CARD_CENTER;
  const boardScale =
    pf < TL.pullStart
      ? interpolate(pf, [TL.pushStart, TL.pushEnd], [1, 2.0], { ...clamp, easing: ease })
      : interpolate(pf, [TL.pullStart, TL.pullEnd], [2.0, 1], { ...clamp, easing: ease });
  const boardOpacity =
    pf < TL.pullStart
      ? interpolate(pf, [TL.pushStart + 4, TL.pushEnd], [1, 0], clamp)
      : interpolate(pf, [TL.pullStart, TL.pullEnd - 2], [0, 1], clamp);

  const flagsOpacity = interpolate(pf, [TL.pushStart + 4, TL.pushEnd + 2], [0, 1], clamp);
  const flagsScale = interpolate(pf, [TL.pushStart + 4, TL.pushEnd + 2], [1.06, 1], {
    ...clamp,
    easing: ease,
  });
  const flagsSlideX = interpolate(pf, [TL.slideStart, TL.slideEnd], [0, -1920], {
    ...clamp,
    easing: ease,
  });

  const docsSlideX = interpolate(pf, [TL.slideStart, TL.slideEnd], [1920, 0], {
    ...clamp,
    easing: ease,
  });
  const docsOpacity = interpolate(pf, [TL.pullStart, TL.pullEnd - 4], [1, 0], clamp);
  const docsScale = interpolate(pf, [TL.pullStart, TL.pullEnd], [1, 1.06], {
    ...clamp,
    easing: ease,
  });

  const showBoard = pf < TL.pushEnd || pf >= TL.pullStart;
  const showFlags = pf >= TL.pushStart + 4 && pf < TL.slideEnd;
  const showDocs = pf >= TL.slideStart && pf < TL.pullEnd;

  // ── chrome bar active chip ──
  const active: ActiveChip =
    pf < TL.clickFlagsChip + 1 ? 'board'
    : pf < TL.clickDocsChip + 2 ? 'flags'
    : pf < TL.pullEnd - 2 ? 'docs'
    : 'board';

  // ── cursor ──
  const cx = interpolate(pf, CURSOR_TS, CURSOR_XS, { ...clamp, easing: ease });
  const cy = interpolate(pf, CURSOR_TS, CURSOR_YS, { ...clamp, easing: ease });
  const cursorOpacity =
    interpolate(pf, [TL.cursorIn, TL.cursorIn + 6], [0, 1], clamp) *
    interpolate(pf, [350, 358], [1, 0], clamp);
  const click = CLICKS.reduce((acc, at) => {
    if (pf >= at && pf <= at + 12) return (pf - at) / 12;
    return acc;
  }, 0);

  // ── click punch: subtle whole-frame zoom snap toward the click point ──
  const CLICK_POINTS = [
    FLAGS_CHIP,
    MODAL_TARGETS.option1,
    MODAL_TARGETS.submit,
    DOCS_CHIP,
    { x: 900, y: INPUT.y + 28 },
    SEND,
  ];
  let punch = 0;
  let punchAt = { x: 960, y: 540 };
  CLICKS.forEach((at, i) => {
    const d = pf - at;
    if (d >= 0 && d <= 28) {
      // ease in over 3, hold at peak through 8, long eased release to 28
      punch =
        d < 3 ? Easing.out(Easing.cubic)(d / 3)
        : d < 8 ? 1
        : 1 - Easing.inOut(Easing.cubic)((d - 8) / 20);
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
      {/* the site's hero field, under everything — the scenes are transparent
          so it reads through the gaps, exactly as in ep02 */}
      {/* 0.6, NOT the site's 0.12. Measured: at 0.12 this field peaks at 4-6/255,
          which is DARKER than the card surfaces (#0a0a0a = 10) it sits behind —
          invisible in a dark film. The site value works on the web because the
          hero sits in a lighter page behind bright type. In video it needs ~5x.
          Landed on 0.22: p95 ~18-20. Above card surface so it reads as texture,
          low enough that it does not compete with the cards for attention. */}
      <FaultyTerminalFrame width={1920} height={1080} opacity={0.22} />

      {showBoard && (
        <AbsoluteFill
          style={{
            transform: `scale(${boardScale})`,
            transformOrigin: `${origin.x}px ${origin.y}px`,
            opacity: boardOpacity,
          }}
        >
          <Board frame={pf} />
        </AbsoluteFill>
      )}
      {showFlags && (
        <AbsoluteFill
          style={{
            transform: `translateX(${flagsSlideX}px) scale(${flagsScale})`,
            opacity: flagsOpacity,
          }}
        >
          <FlagsDetail frame={pf} />
        </AbsoluteFill>
      )}
      {showDocs && (
        <AbsoluteFill
          style={{
            transform: `translateX(${docsSlideX}px) scale(${docsScale})`,
            opacity: docsOpacity,
          }}
        >
          <DocsDetail frame={pf} />
        </AbsoluteFill>
      )}

      {/* the site's hero field, under everything — same as ep02 */}
      {/* (placed first so every surface sits on top of it) */}

      {/* global chrome bar — fixed above every view, like the product */}
      <ChromeBar frame={pf} active={active} />

      <AskDialog frame={pf} fps={fps} />

      {/* the user's cursor — every resolution is user-driven */}
      {cursorOpacity > 0.001 && (
        <div style={{ opacity: cursorOpacity }}>
          <Cursor x={cx} y={cy} click={click} />
        </div>
      )}
    </AbsoluteFill>
  );
};

/** Fine, dark grain — the type should erode, not explode. */
const SAND_OUT = {
  band: 700,
  density: 2.2,
  size: 1.5,
  spread: 210,
  gravity: 0.45,
  drift: 1,
  swirl: 150,
  stagger: 0.6,
  fade: 0.9,
  settle: 0.3,
  smoothing: 0,
  transparent: true,
} as const;

export const FleetGreen: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pf = frame - P;

  const inDeck = frame < P || frame >= DECK.outStart;
  const sanding = frame >= DECK.sandStart;
  const product = <Product pf={pf} fps={fps} />;

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {/* ── soundtrack: VO + ethereal pad (ducked under speech) + cues ── */}
      <Sequence from={INTRO_SHIFT}>
        <Audio src={voSrc} volume={1} />
      </Sequence>
      <Audio src={staticFile('audio/pad.wav')} volume={(f) => padDuck(f - INTRO_SHIFT)} />
      <Audio src={staticFile('audio/riser.wav')} volume={0.8} />
      <Sequence from={DECK.select}>
        <Audio src={staticFile('audio/thunk.wav')} volume={0.8} />
      </Sequence>
      {CLICKS.map((at) => (
        <Sequence key={`click-${at}`} from={at + P}>
          <Audio src={staticFile('audio/click.wav')} volume={0.75} />
        </Sequence>
      ))}
      <Sequence from={TL.docsIdle + P}>
        <Audio src={staticFile('audio/droplet-blue.wav')} volume={0.7} />
      </Sequence>
      <Sequence from={TL.flagsAsk + P}>
        <Audio src={staticFile('audio/droplet-amber.wav')} volume={0.7} />
      </Sequence>
      <Sequence from={TL.flagsGreen + P}>
        <Audio src={staticFile('audio/bloom-flags.wav')} volume={0.65} />
      </Sequence>
      <Sequence from={TL.docsGreen + P}>
        <Audio src={staticFile('audio/bloom-docs.wav')} volume={0.65} />
      </Sequence>
      {[TL.pushStart + P, TL.slideStart + P, TL.pullStart + P, DECK.outStart].map((at) => (
        <Sequence key={`whoosh-${at}`} from={at}>
          <Audio src={staticFile('audio/whoosh.wav')} volume={0.55} />
        </Sequence>
      ))}
      <Sequence from={DECK.deckBack}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.55} />
      </Sequence>
      {MSG_KEY_FRAMES.map((at, i) => (
        <Sequence key={`msgkey-${at}`} from={at}>
          <Audio src={staticFile(`audio/key-${(i % 4) + 1}.wav`)} volume={0.4} />
        </Sequence>
      ))}
      {TAG_KEY_FRAMES.map((at, i) => (
        <Sequence key={`tagkey-${at}`} from={at}>
          <Audio src={staticFile(`audio/key-${((i + 2) % 4) + 1}.wav`)} volume={0.26} />
        </Sequence>
      ))}

      {/* ── one snippet in a deck of snippets ── */}
      {inDeck ? <Deck frame={frame} hideType={sanding}>{product}</Deck> : product}

      {/* ── the ending: everything goes to sand ──
          The deck sinks to black under the type, and the type itself comes
          apart and blows away. The deck's own copy is suppressed while this
          runs; the swap is invisible because the type is fully typed by then
          and the captured copy just drops the blinking caret. */}
      {sanding && (
        <>
          <AbsoluteFill
            style={{ background: '#000', opacity: interpolate(frame, [DECK.sandStart, DECK.sandStart + 30], [0, 1], clamp) }}
          />
          <ParticleScrollFrame
            progress={interpolate(frame, [DECK.sandStart, DECK.sandEnd], [1, 0], { ...clamp, easing: Easing.in(Easing.quad) })}
            options={SAND_OUT}
          >
            <EndCard frame={frame} />
          </ParticleScrollFrame>
        </>
      )}

      {/* ── VO captions (muted viewers read the voice over) ── */}
      <KineticCaptions frame={frame - INTRO_SHIFT} lines={MAIN_CAPTIONS} />
    </AbsoluteFill>
  );
};
