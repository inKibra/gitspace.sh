type PlatformWorkerEnv = Env;

declare namespace Cloudflare {
  interface Env extends PlatformWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import('../src/index.js');
  }
}
