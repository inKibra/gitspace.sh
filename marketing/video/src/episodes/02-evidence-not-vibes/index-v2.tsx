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
import { TLV, RV, DECK, REVIEW_SHIFT, ACTS } from './timeline-v2';
import { Opening } from './scenes/Opening';
import { RubricForms } from './scenes/RubricForms';
import { WorkflowSurface } from './scenes/WorkflowSurface';
import { Evidence } from './scenes/Evidence';
import { ChromeBar, type ActiveChip } from './scenes/ChromeBar';
import { Deck, EndCard, TAGLINE, STINGER } from './Deck-v2';
import { ParticleScrollFrame } from '../../lib/ParticleScrollFrame';
import { BendFrame } from '../../lib/BendFrame';
import { FaultyTerminalFrame } from '../../lib/FaultyTerminalFrame';
import { KineticCaptions, type CapLine } from '../../lib/Captions';
import { Cursor } from '../../lib/ui';

loadFont();

const P = DECK.matchCut; // product-local frame offset (deck intro = 4 beats)
/** Captions + pad ducking were authored in global frames against the original
 *  60-frame deck intro. The intro grew to 150 (the close L→R truck), so shift
 *  them by the difference rather than re-typing every word timing. */
const CAP_SHIFT = DECK.matchCut - 60;
const ease = Easing.inOut(Easing.cubic);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;


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

const HUMAN_KEYS = everyThird(typingFrames(TLV.humanType + P, 1.25, 43));
const SESS_KEYS = everyThird(typingFrames(TLV.sessIn + P, 1.6, 17));
const TAG_KEYS = everyThird(typingFrames(DECK.tagType, 1.35, TAGLINE.length));
const STING_KEYS = everyThird(typingFrames(DECK.stingerType, 1.35, STINGER.length));

// ── VO captions — PLACEHOLDER word timings (main retimes to vo-02.wav) ───────
// New arc: I set the bar → it lied → a workflow of roles → the reviewer catches
// the liar → then (and only then) un-gamed evidence.
const A = T.waiting; // agent / reviewer — the agent turn label's blue
const D = T.error; // the lie (the stub, the blocked gate)
const G = T.accent; // accepted / cleared / ready
// Windows are strictly sequential — each line's `out` is ≥8 frames before the
// next line's first word, so two lines never share the y-band at once.
// Retimed to the v2b breathing grid: each line sits INSIDE its beat's reaction
// hold (global frames = product-local + P), leaving stillness for the VO react.
/**
 * TIMING MODEL — the words are not on a grid. Each word's duration comes from
 * its syllable count, and punctuation buys a real pause, so short function
 * words go by quickly and long ones sit. That is what makes it sound like a
 * person rather than a metronome.
 *
 * REACTION ORDER: a line never starts before the thing it reacts to. The
 * screen does something, the speaker sees it, THEN they speak. Every anchored
 * line opens 10-26 frames after its trigger — the pop-up, the gate going red,
 * the gate going green, the readiness — never on it and never before it.
 *
 * BREATH: 32 frames of silence between sentences, always. And no line's last
 * word falls within ~24 frames of a cut, so a sentence finishes, hangs, and
 * only then does the surface move.
 *
 * The beats in timeline-v2 were sized to fit THIS, not the other way round.
 * Regenerate with the model rather than hand-editing these numbers.
 *
 * TENSE: past for the four opening lines (recounting what went wrong), present
 * from the rubric on (how the thing actually works). The switch lands on the
 * transition out of the opening.
 *
 * COLOUR: a word is tinted only when it names something on screen at that
 * moment, and takes THAT thing's colour. Pronouns and verbs stay white.
 *   agent · reviewer → blue · workflow → purple · rubric/gate/ready → green
 *   stub → red · passed → green (the FALSE green, deliberately)
 *
 * Still placeholder timings for a VO that hasn't been recorded.
 */
const MAIN_CAPTIONS: CapLine[] = [
  {
    // the ask, typed alongside the composer
    y: 872, size: 44, out: 189,
    words: [
      { w: 'I', at: 90 }, { w: 'asked', at: 98 }, { w: 'the', at: 111 }, { w: 'agent', at: 119, color: A },
      { w: 'to', at: 132 }, { w: 'refactor', at: 140 }, { w: 'checkout.', at: 158 },
    ],
  },
  {
    // `passed` is green because the product is showing green. The colour is the lie.
    y: 872, size: 46, out: 346,
    words: [
      { w: 'It', at: 247 }, { w: 'worked,', at: 255 }, { w: 'and', at: 275 }, { w: 'said', at: 283 },
      { w: 'that', at: 291 }, { w: 'the', at: 299 }, { w: 'test', at: 307 }, { w: 'passed.', at: 315, color: G },
    ],
  },
  {
    // reacting to the pop-up, not announcing it
    y: 872, size: 46, out: 448,
    words: [
      { w: 'Then', at: 380 }, { w: 'I', at: 388 }, { w: 'opened', at: 396 }, { w: 'the', at: 414 },
      { w: 'file.', at: 422 },
    ],
  },
  {
    // the stub. Finishes well before the surface moves.
    y: 866, size: 44, out: 575,
    words: [
      { w: 'Oh.', at: 474 }, { w: 'The', at: 494 }, { w: 'AI', at: 502 }, { w: 'just', at: 510 },
      { w: 'stubbed', at: 518, color: D }, { w: 'the', at: 531 }, { w: 'behavior.', at: 539 },
    ],
  },
  {
    // the turn — still past, but looking forward
    y: 866, size: 44, out: 669,
    words: [
      { w: "I'll", at: 601 }, { w: 'need', at: 609 }, { w: 'a', at: 617 }, { w: 'better', at: 625 },
      { w: 'workflow.', at: 638, color: '#bc8cff' },
    ],
  },
  {
    // present tense from here: how it works, not what happened
    y: 872, size: 42, out: 850,
    words: [
      { w: 'Now', at: 727 }, { w: 'the', at: 735 }, { w: 'agent', at: 743, color: A }, { w: 'writes', at: 756 },
      { w: 'a', at: 769 }, { w: 'review', at: 777 }, { w: 'rubric', at: 790, color: G }, { w: 'and', at: 803 },
      { w: 'a', at: 811 }, { w: 'workflow.', at: 819, color: '#bc8cff' },
    ],
  },
  {
    // a role that only reviews
    y: 872, size: 44, out: 1024,
    words: [
      { w: 'So', at: 922 }, { w: 'there', at: 930 }, { w: 'is', at: 938 }, { w: 'a', at: 946 },
      { w: 'reviewer', at: 954, color: A }, { w: 'that', at: 972 }, { w: 'only', at: 980, underline: true }, { w: 'reviews.', at: 993 },
    ],
  },
  {
    // reacting to the gate going red; trails off into the next line
    y: 872, size: 44, out: 1153,
    words: [
      { w: 'Now', at: 1050 }, { w: 'it', at: 1058 }, { w: 'catches', at: 1066 }, { w: 'the', at: 1079 },
      { w: 'stub', at: 1087, color: D }, { w: 'and', at: 1095 }, { w: 'sends', at: 1103 }, { w: 'it', at: 1111 },
      { w: 'back…', at: 1119 },
    ],
  },
  {
    // reacting to the gate going green
    y: 872, size: 46, out: 1266,
    words: [
      { w: 'And', at: 1179 }, { w: 'it', at: 1187 }, { w: 'gets', at: 1195 }, { w: 'fixed', at: 1203 },
      { w: 'and', at: 1216 }, { w: 'the', at: 1224 }, { w: 'gate', at: 1232, color: G }, { w: 'clears.', at: 1240, color: G },
    ],
  },
  {
    // reacting to the evidence — the payoff line
    y: 872, size: 46, out: 1425,
    words: [
      { w: 'This', at: 1346 }, { w: 'is', at: 1354 }, { w: 'a', at: 1362 }, { w: 'result', at: 1370, color: G },
      { w: 'I', at: 1383 }, { w: 'can', at: 1391 }, { w: 'trust.', at: 1399 },
    ],
  },
  {
    // the closing line, over the ✓ ready
    y: 820, size: 46, out: 1589,
    words: [
      { w: 'No', at: 1501 }, { w: 'games', at: 1509 }, { w: 'this', at: 1522 }, { w: 'time.', at: 1530 },
      { w: "It's", at: 1550 }, { w: 'ready.', at: 1558, color: G },
    ],
  },
];

// Caption windows (global frames) for gentle pad ducking (proxy for VO).
const VO_SEGMENTS: Array<[number, number]> = [
  [90, 183], [247, 340], [380, 442], [474, 569], [601, 663], [727, 844], [922, 1018], [1050, 1147], [1179, 1260], [1346, 1419], [1501, 1583],
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

/** The turn between problem and solution: a deep zone and a generous crease,
 *  so it reads as a sheet being folded rather than a card being creased.
 *  `transparent` keeps the background shader field visible behind the fold —
 *  the field is the room, not the page, and a live WebGL canvas can't be
 *  captured into the sheet anyway. */
const TURN = {
  zone: 620,
  angle: 86,
  rounding: 260,
  perspective: 900,
  direction: 'in',
  ease: 620,
  smoothing: 0,
  transparent: true,
  top: true,
  bottom: true,
  tumble: 0,
  tilt: 0,
} as const;

/** The product story, in product-local frames (pf). */
export const Product: React.FC<{ pf: number; fps: number }> = ({ pf, fps: _fps }) => {
  // ── camera ──
  // The problem→solution turn is a BEND: both surfaces on ONE sheet, travelling
  // through the fold. Everything after it is a plain slide, so the turn is the
  // only place the film changes direction. (bend-pan-test proves the pan.)
  const turning = pf >= TLV.openSlideStart && pf < TLV.openSlideEnd;
  const turn = interpolate(pf, [TLV.openSlideStart, TLV.openSlideEnd], [0, 1], { ...clamp, easing: ease });

  const rubricOpacity = interpolate(pf, [TLV.wfSlideStart, TLV.wfSlideEnd], [1, 0], clamp);

  // workflow fades IN over the rubric (in place), then slides out to the evidence.
  const wfSlideX = interpolate(pf, [TLV.rvSlideStart, TLV.rvSlideEnd], [0, -1920], { ...clamp, easing: ease });
  const wfOpacity = interpolate(pf, [TLV.wfSlideStart, TLV.wfSlideEnd], [0, 1], clamp);

  const reviewSlideX = interpolate(pf, [TLV.rvSlideStart, TLV.rvSlideEnd], [1920, 0], { ...clamp, easing: ease });
  const reviewScale = interpolate(pf, [TLV.rvSlideStart, TLV.rvSlideEnd], [1.04, 1], { ...clamp, easing: ease });

  const showOpening = pf < TLV.openSlideStart;
  const showRubric = pf >= TLV.openSlideEnd && pf < TLV.wfSlideEnd;
  const showWorkflow = pf >= TLV.wfSlideStart && pf < TLV.rvSlideEnd;
  const showReview = pf >= TLV.rvSlideStart;

  // ── the human's hand: cursor + click punch, on the three acts only ──
  // Same envelope as ep01: snap in over 3 frames, hold to 8, long release to
  // 28. The punch is what makes a click feel like it landed on something.
  let punch = 0;
  let punchAt = { x: 960, y: 540 };
  let cursorOp = 0;
  let cx = 960;
  let cy = 540;
  let click = 0;
  for (let i = 0; i < ACTS.length; i++) {
    const a = ACTS[i]!;
    const d = pf - a.at;
    if (d >= -26 && d <= 26) {
      // approach from wherever the last act left off, so it reads as one hand
      const from = i > 0 ? ACTS[i - 1]! : { x: 1500, y: 300 };
      const travel = interpolate(pf, [a.at - 26, a.at - 2], [0, 1], { ...clamp, easing: ease });
      cx = from.x + (a.x - from.x) * travel;
      cy = from.y + (a.y - from.y) * travel;
      cursorOp =
        interpolate(pf, [a.at - 26, a.at - 18], [0, 1], clamp) *
        interpolate(pf, [a.at + 12, a.at + 24], [1, 0], clamp);
      click = interpolate(pf, [a.at, a.at + 12], [1, 0], clamp);
    }
    if (d >= 0 && d <= 28) {
      punch =
        d < 3 ? Easing.out(Easing.cubic)(d / 3)
        : d < 8 ? 1
        : 1 - Easing.inOut(Easing.cubic)((d - 8) / 20);
      punchAt = { x: a.x, y: a.y };
    }
  }
  const punchScale = 1 + 0.028 * punch;

  // ── chrome bar: the workspace beats are all checkout-refactor ──
  const active: ActiveChip = 'checkout';
  // drive the bar on the shifted frame so its accept-sweep lands on RV.req2Accept
  const barFrame = pf - REVIEW_SHIFT;

  return (
    // the click punch lives HERE, on the whole product surface, so a click
    // snaps the entire frame toward the point — same as ep01
    <AbsoluteFill
      style={{
        background: T.bg,
        transform: `scale(${punchScale})`,
        transformOrigin: `${punchAt.x}px ${punchAt.y}px`,
      }}
    >
      {/* the site's hero field, under everything — the scenes are transparent
          so it reads through the gaps between cards, exactly as it does behind
          the blog post's hero */}
      {/* 0.6, NOT the site's 0.12. Measured: at 0.12 this field peaks at 4-6/255,
          which is DARKER than the card surfaces (#0a0a0a = 10) it sits behind —
          invisible in a dark film. The site value works on the web because the
          hero sits in a lighter page behind bright type. In video it needs ~5x.
          Landed on 0.22: p95 ~18-20. Above card surface so it reads as texture,
          low enough that it does not compete with the cards for attention. */}
      <FaultyTerminalFrame width={1920} height={1080} opacity={0.22} />

      {showOpening && <Opening frame={pf} />}

      {/* THE TURN — one sheet, two panels, travelling through the fold */}
      {turning && (
        <BendFrame position={turn} options={TURN}>
          <Opening frame={pf} />
          <RubricForms frame={pf} />
        </BendFrame>
      )}

      {showRubric && (
        <AbsoluteFill style={{ opacity: rubricOpacity }}>
          <RubricForms frame={pf} />
        </AbsoluteFill>
      )}
      {showWorkflow && (
        <AbsoluteFill style={{ transform: `translateX(${wfSlideX}px)`, opacity: wfOpacity }}>
          <WorkflowSurface frame={pf} />
        </AbsoluteFill>
      )}
      {showReview && (
        <AbsoluteFill style={{ transform: `translateX(${reviewSlideX}px) scale(${reviewScale})` }}>
          <Evidence frame={pf} />
        </AbsoluteFill>
      )}

      {/* chrome bar — on the workspace/session beats (rubric + evidence); the
          abstract beats (opening, workflow) stay clean */}
      <ChromeBar frame={barFrame} active={active} />

      {/* the human's cursor — present ONLY while a person is actually acting.
          ep02 is an agent-driven story; a cursor on screen for the rest of it
          would be a lie about who is doing the work. */}
      {cursorOp > 0.001 && (
        <div style={{ opacity: cursorOp }}>
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

export const EvidenceNotVibesV2: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pf = frame - P;

  const inDeck = frame < P || frame >= DECK.outStart;
  const sanding = frame >= DECK.sandStart;
  const product = <Product pf={pf} fps={fps} />;

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {/* ── soundtrack: pad (ducked under caption windows) + synthesized cues ──
          VO slot is intentionally empty — vo-02.wav lands here later. */}
      {/* <Audio src={voSrc} volume={1} /> */}
      <Audio src={staticFile('audio/pad-long.wav')} volume={(f) => padDuck(f - CAP_SHIFT)} />
      <Audio src={staticFile('audio/riser.wav')} volume={0.8} />
      <Sequence from={DECK.select}>
        <Audio src={staticFile('audio/thunk.wav')} volume={0.8} />
      </Sequence>

      {/* the four clicks — ep02 had a cursor and a punch but no SOUND, so the
          clicks landed silently. Same cue and level as ep01. */}
      {ACTS.map((a) => (
        <Sequence key={`click-${a.at}`} from={a.at + P}>
          <Audio src={staticFile('audio/click.wav')} volume={0.75} />
        </Sequence>
      ))}

      {/* ── BEAT 2 — AGENTS LIED: the false green claim cracks (amber droplet) ── */}
      <Sequence from={TLV.crackStamp + P}>
        <Audio src={staticFile('audio/droplet-amber.wav')} volume={0.75} />
      </Sequence>

      {/* ── BEAT 4 — THE CATCH: riser builds into the gate, thunk slams it RED ── */}
      <Sequence from={TLV.wfGateIn + P}>
        <Audio src={staticFile('audio/riser.wav')} volume={0.5} />
      </Sequence>
      <Sequence from={TLV.wfCatch + P}>
        <Audio src={staticFile('audio/thunk.wav')} volume={0.85} />
      </Sequence>
      <Sequence from={TLV.wfCatch + P}>
        <Audio src={staticFile('audio/droplet-amber.wav')} volume={0.6} />
      </Sequence>

      {/* ── BEAT 5 — the gate CLEARS green (rising chime) ── */}
      <Sequence from={TLV.wfGateGreen + P}>
        <Audio src={staticFile('audio/bloom-flags.wav')} volume={0.7} />
      </Sequence>

      {/* the workspace goes BLUE — idle, your move (agent's last line) */}
      <Sequence from={RV.agentDone + P}>
        <Audio src={staticFile('audio/droplet-blue.wav')} volume={0.7} />
      </Sequence>

      {/* the two accept-blooms — un-gamed evidence accepted */}
      <Sequence from={RV.req1Accept + P}>
        <Audio src={staticFile('audio/bloom-flags.wav')} volume={0.65} />
      </Sequence>
      <Sequence from={RV.req2Accept + P}>
        <Audio src={staticFile('audio/bloom-docs.wav')} volume={0.68} />
      </Sequence>

      {/* readiness type — bright cluster */}
      <Sequence from={RV.readyType + P}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.55} />
      </Sequence>

      {/* camera whooshes on the SLIDES only (opening→rubric, workflow→evidence,
          deck outro); rubric→workflow cross-fades in place, no whoosh */}
      {[TLV.openSlideStart + P, TLV.rvSlideStart + P, DECK.outStart].map((at) => (
        <Sequence key={`whoosh-${at}`} from={at}>
          <Audio src={staticFile('audio/whoosh.wav')} volume={0.55} />
        </Sequence>
      ))}
      <Sequence from={DECK.deckBack}>
        <Audio src={staticFile('audio/sparkle.wav')} volume={0.5} />
      </Sequence>

      {/* typing thocks */}
      {[...HUMAN_KEYS, ...SESS_KEYS].map((at, i) => (
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
      {inDeck ? <Deck frame={frame} hideType={sanding}>{product}</Deck> : product}

      {/* ── the ending: everything goes to sand ──
          The deck sinks to black under the type, and the type itself comes
          apart and blows away. The deck's own copy of the card is suppressed
          while this runs and the swap is invisible, because by now the type is
          fully typed and the captured copy just drops the blinking caret. */}
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

      {/* ── VO captions (placeholder timings; muted viewers read the voice) ── */}
      <KineticCaptions frame={frame - CAP_SHIFT} lines={MAIN_CAPTIONS} />
    </AbsoluteFill>
  );
};
