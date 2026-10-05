type OperatorWorkerEnv = Env;

declare namespace Cloudflare {
  interface Env extends OperatorWorkerEnv {}
  interface GlobalProps {
    mainModule: typeof import('../src/index.js');
  }
}
