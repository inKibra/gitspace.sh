// Runs one agent-written Playwright script inside a Worker Loader sandbox (docs/APERTURE-DESIGN.md §6.1). The sandbox
// has no network of its own: `env.CDP` is its only way out, a WebSocket to the browser through GitSpace's CDP layer.
// `./script.js` is the agent's script, an async function of `{ page, context, browser, state }`.
import { connect } from '@cloudflare/playwright';
import { WorkerEntrypoint } from 'cloudflare:workers';
import script from './script.js';

const OUTPUT_LIMIT = 64 * 1024;

function printable(value) {
  if (typeof value === 'string') return value;
  try { return JSON.stringify(value) ?? String(value); } catch { return String(value); }
}

export default class Runner extends WorkerEntrypoint {
  /** `label` names who acts, for the ghost cursor; `state` is what the previous script left. Returns JSON text. */
  async run({ label, state }) {
    const logs = [];
    let bytes = 0;
    const log = (...values) => {
      const line = values.map(printable).join(' ');
      bytes += line.length;
      if (bytes <= OUTPUT_LIMIT) logs.push(line);
    };
    console.log = console.info = console.warn = console.error = console.debug = log;
    // The session slot of the connection carries the cursor label; GitSpace's CDP layer reads it back. `persistent`
    // adopts the browser's default context and its open pages: without it Playwright makes a context Chrome disposes
    // when the script disconnects, so the next run would start on a blank page.
    const browser = await connect(this.env.CDP, { sessionId: encodeURIComponent(label), persistent: true });
    const finish = (result) => {
      const body = { ...result, logs, truncated: bytes > OUTPUT_LIMIT };
      // State that cannot become JSON is dropped, not the whole result.
      try { return JSON.stringify({ ...body, state }); } catch { return JSON.stringify({ ...body, state: null, stateError: 'state was not JSON-serializable and was not kept' }); }
    };
    try {
      const [context] = browser.contexts();
      if (!context) throw new Error('The browser session has no default context');
      const page = context.pages().at(-1) ?? await context.newPage();
      const value = await script({ page, context, browser, state });
      let returned;
      try { returned = JSON.parse(JSON.stringify(value === undefined ? null : value)); } catch { returned = String(value); }
      return finish({ ok: true, value: returned });
    } catch (error) {
      return finish({ ok: false, error: String(error?.stack ?? error).slice(0, 8192) });
    } finally {
      // Ends this script's view of the browser; the browser and its pages stay for the agent.
      await browser.close().catch(() => {});
    }
  }
}
