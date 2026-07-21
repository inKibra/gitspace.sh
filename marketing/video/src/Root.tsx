import React from 'react';
import { Composition } from 'remotion';
import { FleetGreen } from './episodes/01-fleet-green/index';
import { FleetGreenTok } from './episodes/01-fleet-green/Tok';
import { Og } from './episodes/01-fleet-green/Og';

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
      durationInFrames={570}
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
  </>
);
