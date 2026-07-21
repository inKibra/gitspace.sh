import React from 'react';
import { AbsoluteFill, interpolate, Easing } from 'remotion';
import { T, MONO } from '../../lib/theme';
import { typed, Caret } from '../../lib/ui';
import { DECK } from './timeline';

/**
 * The 3D snippet deck: the product story is one card among many. Intro flies
 * through the deck into the hero card (match-cut at DECK.matchCut); outro
 * shrinks the all-green board back into its card and re-racks the deck.
 *
 * Perspective math: hero card sits at z=0 scaled 0.26. A world translateZ of
 * PERSPECTIVE * (1 - 0.26) makes it exactly full-frame → seamless match-cut.
 */

export const TAGLINE = 'keep your fleet green.';

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
  { title: 'services', variant: 'terminal', x: -880, y: 60, z: -880, r: 26 },
  { title: 'review', variant: 'modal', x: 890, y: 30, z: -840, r: -26 },
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
    // Every axis is MONOTONIC: start wide on the whole deck, browse, and
    // converge on the hero card in one commitment — no direction reversals.
    const u = interpolate(frame, [0, DECK.matchCut], [0, 1], {
      ...clampOpts,
      easing: Easing.bezier(0.6, 0, 0.25, 1), // long browse, late commit, soft landing
    });
    return {
      tz: -720 + (Z_MATCH + 720) * u,
      ry: -16 + (-HERO_ROT + 16) * u, // one 23° sweep across the deck
      tx: 260 * (1 - u),
      ty: 90 * (1 - u),
      rz: -2.2 * (1 - u), // starts banked, settles level as we land
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

export const Deck: React.FC<{ frame: number; children: React.ReactNode }> = ({
  frame,
  children,
}) => {
  const { tz, ry, tx, ty, rz } = world(frame);
  const intro = frame < DECK.matchCut;

  // hero card chrome
  const glow = intro
    ? interpolate(frame, [DECK.select, DECK.select + 8], [0, 1], clampOpts)
    : interpolate(frame, [DECK.outStart + 4, DECK.outStart + 14], [1, 0], clampOpts);
  const heroBorder = intro
    ? interpolate(frame, [DECK.matchCut - 4, DECK.matchCut], [1, 0], clampOpts)
    : interpolate(frame, [DECK.outStart + 2, DECK.outStart + 10], [0, 1], clampOpts);

  // side cards: fade out as we punch past them; return on the way back
  const sideOpacity = (i: number) =>
    intro
      ? interpolate(frame, [4 + i * 3, 14 + i * 3], [0, 1], clampOpts) *
        interpolate(frame, [DECK.matchCut - 16, DECK.matchCut - 4], [1, 0], clampOpts)
      : interpolate(frame, [DECK.outStart + 8 + i * 2, DECK.outStart + 20 + i * 2], [0, 1], clampOpts);

  const dim = interpolate(frame, [DECK.tagDim, DECK.tagDim + 14], [0, 0.55], clampOpts);
  const tagFrame = frame - DECK.tagType;

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
                background: T.surface,
                border: `1px solid ${T.border}`,
                opacity: sideOpacity(i),
                overflow: 'hidden',
              }}
            >
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
          ))}

          {/* hero card: the live product, scaled into a card */}
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
              opacity: 1,
              boxShadow: glow > 0.05 ? `0 0 ${glow * 40}px rgba(0,255,102,0.28)` : 'none',
              overflow: 'hidden',
              background: T.bg,
            }}
          >
            <div
              style={{
                width: 1920,
                height: 1080,
                transform: `scale(${HERO_SCALE})`,
                transformOrigin: 'top left',
                opacity: heroBorder * 0 + 1, // content always full; border handled above
              }}
            >
              {children}
            </div>
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
              fleet
            </div>
          </div>
        </div>
      </AbsoluteFill>

      {/* tagline over the re-racked deck */}
      {!intro && (
        <>
          <AbsoluteFill style={{ background: `rgba(0,0,0,${dim})` }} />
          {tagFrame >= 0 && (
            <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
              <div style={{ fontSize: 54, color: T.text, height: 70 }}>
                {typed(TAGLINE, frame, DECK.tagType, 1.35)}
                <Caret frame={frame} height={48} />
              </div>
              <div
                style={{
                  marginTop: 46,
                  fontSize: 19,
                  letterSpacing: '0.2em',
                  color: T.textDim,
                  opacity: interpolate(frame, [DECK.tagType + 20, DECK.tagType + 32], [0, 1], clampOpts),
                }}
              >
                GITSPACE · Nº 01
              </div>
            </AbsoluteFill>
          )}
        </>
      )}
    </AbsoluteFill>
  );
};
