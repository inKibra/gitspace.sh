import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../lib/theme';
import { typed, Caret } from '../../lib/ui';
import { DECK } from './timeline';
import { ParticleRevealFrame } from '../../lib/ParticleRevealFrame';

/**
 * The 3D snippet deck (reused from ep01): the product story is one card among
 * many. Intro flies through the deck into the hero "evidence" card (match-cut
 * at DECK.matchCut); outro shrinks the accepted review board back into its card
 * and re-racks the deck, then types the tagline and the stinger.
 *
 * Perspective math: hero card sits at z=0 scaled 0.26. A world translateZ of
 * PERSPECTIVE * (1 - 0.26) makes it exactly full-frame → seamless match-cut.
 */

export const TAGLINE = 'A diff is not a story.';
export const STINGER = 'Read it in build order.';

const PERSPECTIVE = 1600;
const HERO_SCALE = 0.26;
const Z_MATCH = PERSPECTIVE * (1 - HERO_SCALE); // 1184
const HERO_ROT = -7; // deg; world counter-rotates to cancel at the cut

const CARD_W = 1920 * HERO_SCALE; // ~499
const CARD_H = 1080 * HERO_SCALE; // ~281

interface DeckCard {
  title: string;
  variant: 'modal' | 'blame' | 'journal' | 'artifacts' | 'kanban' | 'terminal';
  x: number;
  y: number;
  z: number;
  r: number;
}

const CARDS: DeckCard[] = [
  { title: 'ask forms', variant: 'modal', x: -720, y: -180, z: -260, r: 22 },
  { title: 'agent blame', variant: 'blame', x: 700, y: -150, z: -420, r: -18 },
  { title: 'phase journal', variant: 'journal', x: -580, y: 260, z: -560, r: 14 },
  { title: 'artifacts', variant: 'artifacts', x: 620, y: 280, z: -500, r: -22 },
  { title: 'kanban', variant: 'kanban', x: -240, y: -360, z: -700, r: 10 },
  { title: 'sessions', variant: 'terminal', x: 260, y: 380, z: -760, r: -12 },
  { title: 'rubrics', variant: 'modal', x: -880, y: 60, z: -880, r: 26 },
  { title: 'command judges', variant: 'terminal', x: 890, y: 30, z: -840, r: -26 },
];

const BAR = (w: number, c: string, h = 8): React.CSSProperties => ({
  width: w,
  height: h,
  background: c,
  flex: 'none',
});

/** Abstract mini-UI skeletons: reads as product, avoids fake-text cheapness. */
const MiniContent: React.FC<{ variant: DeckCard['variant']; frame: number }> = ({
  variant,
  frame,
}) => {
  const blink = Math.floor(frame / 14) % 2 === 0;
  switch (variant) {
    case 'modal':
      return (
        <div style={{ margin: '38px 70px', border: `1px solid ${T.border}`, padding: 18 }}>
          <div style={{ ...BAR(90, T.textGhost, 6), marginBottom: 12 }} />
          {[T.accent, T.textGhost, T.textGhost].map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', border: `2px solid ${c}` }} />
              <div style={BAR(150 - i * 20, i === 0 ? T.textMuted : T.textGhost, 7)} />
            </div>
          ))}
          <div style={{ ...BAR(70, T.accent, 18), marginLeft: 'auto' }} />
        </div>
      );
    case 'blame':
      return (
        <div style={{ margin: '30px 46px' }}>
          {[T.running, T.waiting, T.needsInput, T.running, T.textGhost].map((c, i) => (
            <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 14 }}>
              <div style={BAR(26, c, 12)} />
              <div style={BAR(230 - (i % 3) * 40, T.textGhost, 7)} />
            </div>
          ))}
        </div>
      );
    case 'journal':
      return (
        <div style={{ margin: '30px 60px', display: 'flex', gap: 20 }}>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
            {[0, 1, 2, 3].map((i) => (
              <React.Fragment key={i}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: i < 2 ? T.accent : T.textGhost }} />
                {i < 3 && <div style={BAR(2, T.border, 26)} />}
              </React.Fragment>
            ))}
          </div>
          <div style={{ paddingTop: 2 }}>
            {[190, 150, 210, 120].map((w, i) => (
              <div key={i} style={{ ...BAR(w, T.textGhost, 7), marginBottom: 32 }} />
            ))}
          </div>
        </div>
      );
    case 'artifacts':
      return (
        <div style={{ margin: '32px 60px' }}>
          {[0, 18, 18, 36, 18, 0].map((ind, i) => (
            <div key={i} style={{ display: 'flex', gap: 8, marginLeft: ind, marginBottom: 13 }}>
              <div style={BAR(12, i === 3 ? T.accent : T.textGhost, 9)} />
              <div style={BAR(140 - (i % 3) * 26, T.textGhost, 9)} />
            </div>
          ))}
        </div>
      );
    case 'kanban':
      return (
        <div style={{ margin: '32px 40px', display: 'flex', gap: 16 }}>
          {[3, 2, 2].map((n, c) => (
            <div key={c} style={{ flex: 1 }}>
              <div style={{ ...BAR(50, T.textGhost, 6), marginBottom: 10 }} />
              {Array.from({ length: n }, (_, i) => (
                <div
                  key={i}
                  style={{
                    height: 38,
                    marginBottom: 8,
                    border: `1px solid ${T.border}`,
                    background: T.elevated,
                    padding: 6,
                  }}
                >
                  <div style={BAR(60 - i * 10, c === 1 && i === 0 ? T.waiting : T.textGhost, 6)} />
                </div>
              ))}
            </div>
          ))}
        </div>
      );
    case 'terminal':
      return (
        <div style={{ margin: '34px 56px' }}>
          {[210, 160, 250, 130].map((w, i) => (
            <div key={i} style={{ ...BAR(w, i % 2 ? T.textGhost : '#0f5132', 8), marginBottom: 16 }} />
          ))}
          <div style={{ ...BAR(14, blink ? T.accent : 'transparent', 16), marginTop: 4 }} />
        </div>
      );
  }
};

const DUST_OPTS = {
  radius: 470,
  softness: 0.8,
  size: 1,
  threshold: 0.1,
  scatter: 30,
  drift: 1.2,
  aberration: 45,
  bend: 55,
  background: '#000000',
} as const;
/** Each ParticleReveal owns a WebGL context; browsers cap how many can be live. */
const DUST_CARDS = true;

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;
const ease = Easing.inOut(Easing.cubic);

/**
 * World (camera) transform. The intro is ONE continuous parametric flight —
 * a single eased progress `u` drives every axis (no piecewise keyframes, so
 * velocity never drops to zero mid-move → no hitching): a banking orbital
 * swoop (yaw sweep + lateral arc + roll) that lands gently on the hero card.
 */
const world = (frame: number) => {
  if (frame < DECK.matchCut) {
    const u = interpolate(frame, [0, DECK.matchCut], [0, 1], {
      ...clampOpts,
      easing: Easing.bezier(0.6, 0, 0.25, 1),
    });
    return {
      tz: -720 + (Z_MATCH + 720) * u,
      ry: -16 + (-HERO_ROT + 16) * u,
      tx: 260 * (1 - u),
      ty: 90 * (1 - u),
      rz: -2.2 * (1 - u),
    };
  }
  return {
    tz: interpolate(frame, [DECK.outStart, DECK.deckBack, DECK.total], [Z_MATCH, -40, -95], {
      ...clampOpts,
      easing: ease,
    }),
    ry: interpolate(frame, [DECK.outStart, DECK.deckBack], [-HERO_ROT, 0], {
      ...clampOpts,
      easing: ease,
    }),
    tx: 0,
    ty: 0,
    rz: 0,
  };
};


/**
 * The closing type. Lives outside the deck's 3D context so it can ALSO be
 * rendered on its own and fed to a capture-based effect — a subtree inside
 * `transform-style: preserve-3d` is not something html-in-canvas can read.
 *
 * `caret` is off for the captured copy: a blinking caret frozen into sand
 * reads as a glitch.
 */
export const EndCard: React.FC<{ frame: number; caret?: boolean }> = ({ frame, caret }) => (
  <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', fontFamily: MONO }}>
    <div style={{ fontSize: 60, color: T.text, height: 78 }}>
      {typed(TAGLINE, frame, DECK.tagType, 1.35)}
      {caret && frame < DECK.stingerType && <Caret frame={frame} height={52} />}
    </div>
    {/* the stinger — the human's line, in the human's green */}
    {frame >= DECK.stingerType && (
      <div style={{ fontSize: 40, color: T.accent, height: 54, marginTop: 30 }}>
        {typed(STINGER, frame, DECK.stingerType, 1.35)}
        {caret && <Caret frame={frame} height={36} />}
      </div>
    )}
    <div
      style={{
        marginTop: 46,
        fontSize: 19,
        letterSpacing: '0.2em',
        color: T.textDim,
        opacity: interpolate(frame, [DECK.tagType + 20, DECK.tagType + 32], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        }),
      }}
    >
      GITSPACE · Nº 03
    </div>
  </AbsoluteFill>
);

export const Deck: React.FC<{ frame: number; children: React.ReactNode; hideType?: boolean }> = ({
  frame,
  children,
  hideType,
}) => {
  const { tz, ry, tx, ty, rz } = world(frame);
  const intro = frame < DECK.matchCut;

  const glow = intro
    ? interpolate(frame, [DECK.select, DECK.select + 8], [0, 1], clampOpts)
    : interpolate(frame, [DECK.outStart + 4, DECK.outStart + 14], [1, 0], clampOpts);
  const heroBorder = intro
    ? interpolate(frame, [DECK.matchCut - 4, DECK.matchCut], [1, 0], clampOpts)
    : interpolate(frame, [DECK.outStart + 2, DECK.outStart + 10], [0, 1], clampOpts);

  /* Canvas UI ParticleReveal, frame-driven: cards MATERIALISE out of grayscale
   * dust as they fly in (staggered so the deck assembles rather than pops), and
   * on the outro they re-form and then DISSOLVE back to dust under the tagline
   * so the type has a quiet field to sit on. */
  /* Canvas UI ParticleReveal, frame-driven. Everything starts DISSOLVED and
   * sharpens as the camera comes in, so the resolve is tied to the approach
   * rather than to arbitrary frames: `zoom` is the intro's own progress.
   *
   * The resolve is FRONT-LOADED (done by ~zoom 0.5). The camera is still far out
   * early, so a late resolve reads backwards: the cards are biggest at the end,
   * which is exactly when the dust is most legible — it looked like they were
   * dissolving INTO the cut instead of out of it.
   *
   * On the outro the cards re-form, then dissolve back under the tagline. */
  const zoom = intro ? interpolate(frame, [0, DECK.matchCut], [0, 1], clampOpts) : 1;

  const cardProgress = (i: number) =>
    intro
      ? interpolate(zoom, [0.04 + i * 0.01, 0.46 + i * 0.01], [0, 1], clampOpts)
      : interpolate(frame, [DECK.outStart + 6 + i * 2, DECK.outStart + 32 + i * 2], [0, 1], clampOpts) *
        interpolate(frame, [DECK.tagType - 6, DECK.tagType + 26], [1, 0], clampOpts);

  // the hero resolves slightly ahead of the deck so it is unambiguously crisp
  // by the match cut
  const heroProgress = intro ? interpolate(zoom, [0.02, 0.42], [0, 1], clampOpts) : 1;

  const sideOpacity = (i: number) =>
    intro
      ? interpolate(frame, [4 + i * 3, 14 + i * 3], [0, 1], clampOpts) *
        interpolate(frame, [DECK.matchCut - 16, DECK.matchCut - 4], [1, 0], clampOpts)
      : interpolate(frame, [DECK.outStart + 8 + i * 2, DECK.outStart + 20 + i * 2], [0, 1], clampOpts);

  // 0.6 left the product's final `✓ ready` glowing through the tagline; the
  // deck should read as texture behind the type, not as legible UI.
  const dim = interpolate(frame, [DECK.tagDim, DECK.tagDim + 14], [0, 0.84], clampOpts);

  return (
    <AbsoluteFill style={{ background: T.bg, fontFamily: MONO, overflow: 'hidden' }}>
      <AbsoluteFill style={{ perspective: PERSPECTIVE }}>
        <div
          style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            transformStyle: 'preserve-3d',
            transform: `translate3d(${tx}px, ${ty}px, ${tz}px) rotateY(${ry}deg) rotateZ(${rz}deg)`,
          }}
        >
          {CARDS.map((c, i) => (
            <div
              key={c.title}
              style={{
                position: 'absolute',
                width: CARD_W,
                height: CARD_H,
                marginLeft: -CARD_W / 2,
                marginTop: -CARD_H / 2,
                transform: `translate3d(${c.x}px, ${c.y}px, ${c.z}px) rotateY(${c.r}deg)`,
                border: `1px solid ${T.border}`,
                opacity: sideOpacity(i),
                overflow: 'hidden',
              }}
            >
              {(() => {
              const face = (
                <div style={{ position: 'absolute', inset: 0, background: T.surface }}>
                  <MiniContent variant={c.variant} frame={frame} />
                  <div
                    style={{
                      position: 'absolute',
                      left: 14,
                      bottom: 10,
                      fontSize: 13,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: T.textDim,
                    }}
                  >
                    {c.title}
                  </div>
                </div>
              );
              return DUST_CARDS ? (
                <ParticleRevealFrame
                  progress={cardProgress(i)}
                  width={Math.round(CARD_W)}
                  height={Math.round(CARD_H)}
                  options={DUST_OPTS}
                >
                  {face}
                </ParticleRevealFrame>
              ) : (
                face
              );
              })()}
            </div>
          ))}

          {/* hero card: the live product, scaled into the "change guide" card */}
          <div
            style={{
              position: 'absolute',
              width: CARD_W,
              height: CARD_H,
              marginLeft: -CARD_W / 2,
              marginTop: -CARD_H / 2,
              transform: `rotateY(${HERO_ROT}deg)`,
              border: `1px solid ${
                glow > 0.05 ? `rgba(0,255,102,${0.3 + glow * 0.7})` : T.border
              }`,
              boxShadow: glow > 0.05 ? `0 0 ${glow * 40}px rgba(0,255,102,0.28)` : 'none',
              overflow: 'hidden',
              background: T.bg,
            }}
          >
            {(() => {
              // The product's last frame ends on a glowing green `✓ ready`, whose
              // text-shadow punched straight through the tagline's dim overlay.
              // Fade the product itself out under the type instead of trying to
              // cover it: by the tagline the hero card is texture, not content.
              const productFade = interpolate(
                frame,
                [DECK.tagDim - 6, DECK.tagType],
                [1, 0.12],
                clampOpts,
              );
              const content = (
                <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', opacity: intro ? 1 : productFade }}>
                  <div
                    style={{
                      width: 1920,
                      height: 1080,
                      transform: `scale(${HERO_SCALE})`,
                      transformOrigin: 'top left',
                    }}
                  >
                    {children}
                  </div>
                </div>
              );
              // once resolved, render the real DOM so the match cut is exact
              return heroProgress < 0.999 ? (
                <ParticleRevealFrame
                  progress={heroProgress}
                  width={Math.round(CARD_W)}
                  height={Math.round(CARD_H)}
                  options={DUST_OPTS}
                >
                  {content}
                </ParticleRevealFrame>
              ) : (
                content
              );
            })()}
            <div
              style={{
                position: 'absolute',
                left: 14,
                bottom: 10,
                fontSize: 13,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                color: glow > 0.05 ? T.accent : T.textDim,
                opacity: heroBorder,
              }}
            >
              change guide
            </div>
          </div>
        </div>
      </AbsoluteFill>

      {/* tagline + stinger over the re-racked deck */}
      {!intro && (
        <>
          <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} />
          {frame >= DECK.tagType && !hideType && <EndCard frame={frame} caret />}
        </>
      )}
    </AbsoluteFill>
  );
};
