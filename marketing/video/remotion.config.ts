import { Config } from '@remotion/cli/config';

Config.setVideoImageFormat('png');
Config.setOverwriteOutput(true);
// WebGL effects (Canvas UI ParticleReveal) need a real GL backend when rendering.
Config.setChromiumOpenGlRenderer('angle');
