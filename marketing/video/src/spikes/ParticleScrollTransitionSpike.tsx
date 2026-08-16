import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { T } from '../lib/theme';
import { ParticleScrollFrame } from '../lib/ParticleScrollFrame';
import { WorkflowSurface } from '../episodes/02-evidence-not-vibes/scenes/WorkflowSurface';
import { Evidence } from '../episodes/02-evidence-not-vibes/scenes/Evidence';

/**
 * SPIKE — OPTION 3: the horizontal slide as a SAND WIPE.
 *
 * A formation line travels left to right. The outgoing surface comes apart
 * into drifting grains in its wake; the incoming one condenses out of the same
 * cloud behind it. No slide, no cards: the surface itself is the material.
 *
 * Runs the real workflow → evidence hand-off so the judgement is honest.
 * Touches nothing in the episode compositions.
 */

const HOLD = 22;
const WIPE = 40; // a sand wipe needs more room than a slide to read

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const SAND = {
  band: 620, // width of the travelling formation edge
  density: 2.4, // grain spacing — fine, so it reads as sand not confetti
  size: 1.4,
  spread: 190, // how far grains fly from home
  gravity: 0.55, // biased along the wipe, so the cloud trails the line
  drift: 0.9,
  swirl: 130, // sideways arc on the way home
  stagger: 0.55,
  fade: 0.22,
  settle: 0.28,
  smoothing: 0,
} as const;

export const ParticleScrollTransitionSpike: React.FC = () => {
  const frame = useCurrentFrame();
  const t = interpolate(frame, [HOLD, HOLD + WIPE], [0, 1], {
    ...clampOpts,
    easing: Easing.inOut(Easing.cubic),
  });

  // The effect paints an OPAQUE surface (uCover), so two of these can't be
  // stacked and blended — the top one would simply hide the other. Instead the
  // two surfaces hand off THROUGH the dust: the outgoing one scatters to a
  // field of grains, and at the moment it's fully apart the incoming one takes
  // over and condenses out of a field that looks the same. The swap happens
  // where there's nothing left to see.
  const scattered = t >= 0.5;
  const out = interpolate(t, [0, 0.5], [1, 0], clampOpts);
  const inc = interpolate(t, [0.5, 1], [0, 1], clampOpts);

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      {scattered ? (
        <ParticleScrollFrame progress={inc} options={SAND}>
          <Evidence frame={900} />
        </ParticleScrollFrame>
      ) : (
        <ParticleScrollFrame progress={out} options={SAND}>
          <WorkflowSurface frame={700} />
        </ParticleScrollFrame>
      )}
    </AbsoluteFill>
  );
};
