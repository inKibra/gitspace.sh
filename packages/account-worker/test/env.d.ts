type AccountWorkerEnv = Env;

declare namespace Cloudflare {
  interface Env extends AccountWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import('../src/index.js');
  }
}
