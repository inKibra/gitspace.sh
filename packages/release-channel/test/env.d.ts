type ReleaseChannelEnv = Env;

declare namespace Cloudflare {
  interface Env extends ReleaseChannelEnv {}
  interface GlobalProps {
    mainModule: typeof import('../src/index.js');
  }
}
