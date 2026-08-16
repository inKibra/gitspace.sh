import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { T } from '../lib/theme';
import { BendFrame } from '../lib/BendFrame';
import { WorkflowSurface } from '../episodes/02-evidence-not-vibes/scenes/WorkflowSurface';
import { Evidence } from '../episodes/02-evidence-not-vibes/scenes/Evidence';

/**
 * SPIKE — OPTION 1: the transition as ONE BENT SHEET.
 *
 * Both screens live on a single surface, laid end to end. We travel along it,
 * and the sheet curves over the left and right screen edges as it passes, like
 * scrolling on the face of a cube. Nothing slides past anything else; there is
 * only one surface, and it bends.
 *
 * Runs the real workflow → evidence hand-off so the judgement is honest.
 * Touches nothing in the episode compositions.
 */

const HOLD = 20; // beat on the first screen
const TRAVEL = 38; // the journey along the sheet

const clampOpts = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const BEND = {
  zone: 620, // how much of the sheet is curling at each edge
  angle: 86,
  rounding: 260, // a generous radius — a bent sheet, not a folded card
  perspective: 900,
  direction: 'in', // the curl comes toward the viewer, like the near face
  ease: 620, // scroll distance over which an end edge flattens out
  smoothing: 0,
  top: true,
  bottom: true,
  tumble: 0,
  tilt: 0,
} as const;

export const BendTransitionSpike: React.FC = () => {
  const frame = useCurrentFrame();
  // position along the sheet, in screens: 0 = workflow, 1 = evidence
  const position = interpolate(frame, [HOLD, HOLD + TRAVEL], [0, 1], {
    ...clampOpts,
    easing: Easing.inOut(Easing.cubic),
  });


  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <BendFrame position={position} options={BEND}>
        <WorkflowSurface frame={700} />
        <Evidence frame={900} />
      </BendFrame>

    </AbsoluteFill>
  );
};
