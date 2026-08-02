import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame, Easing } from 'remotion';
import { T } from '../lib/theme';
import { ParticleRevealFrame } from '../lib/ParticleRevealFrame';
import { WorkflowSurface } from '../episodes/02-evidence-not-vibes/scenes/WorkflowSurface';

/**
 * SPIKE — can html-in-canvas capture a WHOLE SCENE subtree?
 *
 * The deck hero card silently defeated `drawElementImage` when it wrapped the
 * live product; a plain div captured fine. Everything about doing particle /
 * bend transitions between surfaces depends on the answer, so prove it before
 * building anything: a full 1920×1080 scene, dissolved.
 *
 * PASS = the workflow graph reads as dust mid-dissolve.
 * FAIL = it stays crisp (capture no-op'd) or goes black (capture empty).
 */
export const SceneCaptureSpike: React.FC = () => {
  const frame = useCurrentFrame();
  const progress = interpolate(frame, [0, 45, 75, 120], [0, 1, 1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.inOut(Easing.cubic),
  });

  return (
    <AbsoluteFill style={{ background: T.bg }}>
      <ParticleRevealFrame
        progress={progress}
        width={1920}
        height={1080}
        options={{ radius: 1400, softness: 0.8, size: 1, threshold: 0.1, scatter: 30, drift: 1.2, aberration: 45, bend: 55, background: '#000000' }}
      >
        {/* frame 585 = the gate blocks; a busy, high-contrast scene to read */}
        <WorkflowSurface frame={585} />
      </ParticleRevealFrame>
    </AbsoluteFill>
  );
};
