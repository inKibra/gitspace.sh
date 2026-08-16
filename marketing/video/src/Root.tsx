import React from 'react';
import { Composition } from 'remotion';
import { FleetGreen } from './episodes/01-fleet-green/index';
import { FleetGreenTok } from './episodes/01-fleet-green/Tok';
import { Og } from './episodes/01-fleet-green/Og';
import { EvidenceNotVibes } from './episodes/02-evidence-not-vibes/index';
import { EvidenceNotVibesV2 } from './episodes/02-evidence-not-vibes/index-v2';
import { ChangeGuide } from './episodes/03-change-guide/index';
import { ShippedIsntDone } from './episodes/04-shipped-isnt-done/index';
import { ParticleSpike } from './spikes/ParticleSpike';
import { SceneCaptureSpike } from './spikes/SceneCaptureSpike';
import { BendTransitionSpike } from './spikes/BendTransitionSpike';
import { BendPanTest } from './spikes/BendPanTest';
import { ParticleScrollTransitionSpike } from './spikes/ParticleScrollTransitionSpike';
import { HeroShaderSpike } from './spikes/HeroShaderSpike';
import { Og as Og02 } from './episodes/02-evidence-not-vibes/Og';

/**
 * One <Composition> pair per episode. Adding episode NN:
 *   1. copy src/episodes/01-fleet-green → src/episodes/NN-<name>
 *   2. register `epNN-<name>` (+ optional `-tok`) below
 *   3. add render scripts in package.json → ../out/NN-<name>.mp4
 * See README.md for the full checklist.
 */
export const RemotionRoot: React.FC = () => (
  <>
    <Composition
      id="ep01-fleet-green"
      component={FleetGreen}
      durationInFrames={720}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="ep01-fleet-green-tok"
      component={FleetGreenTok}
      durationInFrames={420}
      fps={30}
      width={1080}
      height={1920}
    />
    <Composition id="ep01-og" component={Og} durationInFrames={1} fps={30} width={1200} height={630} />

    <Composition
      id="ep02-evidence"
      component={EvidenceNotVibes}
      durationInFrames={720}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="ep02-evidence-v2"
      component={EvidenceNotVibesV2}
      durationInFrames={1935}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="ep03-change-guide"
      component={ChangeGuide}
      durationInFrames={1635}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition
      id="ep04-shipped-isnt-done"
      component={ShippedIsntDone}
      durationInFrames={1515}
      fps={30}
      width={1920}
      height={1080}
    />
    <Composition id="ep02-evidence-og" component={Og02} durationInFrames={1} fps={30} width={1200} height={630} />
    <Composition id="cui-particle-spike" component={ParticleSpike} durationInFrames={120} fps={30} width={1920} height={1080} />
    <Composition id="cui-scene-capture-spike" component={SceneCaptureSpike} durationInFrames={120} fps={30} width={1920} height={1080} />
    <Composition id="bend-pan-test" component={BendPanTest} durationInFrames={41} fps={30} width={1920} height={1080} />
    <Composition id="bend-pan-test-transparent" component={BendPanTest} durationInFrames={41} fps={30} width={1920} height={1080} defaultProps={{ abs: true, transparent: true }} />
    <Composition id="bend-pan-test-abs" component={BendPanTest} durationInFrames={41} fps={30} width={1920} height={1080} defaultProps={{ abs: true }} />
    <Composition id="cui-bend-transition-spike" component={BendTransitionSpike} durationInFrames={90} fps={30} width={1920} height={1080} />
    <Composition id="cui-sand-transition-spike" component={ParticleScrollTransitionSpike} durationInFrames={96} fps={30} width={1920} height={1080} />
    <Composition id="hero-shader-spike" component={HeroShaderSpike} durationInFrames={150} fps={30} width={1920} height={1080} />
  </>
);
