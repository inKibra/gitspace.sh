// Types `ctx.exports`, the loopback bindings for this Worker's own exports (the browser runner's CDP entrypoint).
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import('./index');
  }
}
