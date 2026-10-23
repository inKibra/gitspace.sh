import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import type { RuntimeAccountBrowserAuthorization, RuntimeToolResult } from '@gitspace/protocol-runtime';
import { launchCloudBrowser, type BrowserChannel } from './browser-cdp.js';
import { AccountBrowserRuntime } from './browser-runtime.js';
import { CdpBrowserShim, type CdpShimClient } from './browser-shim.js';
import { BROWSER_RUNNER_SOURCE } from './generated/browser-runner.js';
import { fetchInternalService, isHostedServiceHostname, isWorkspaceServiceHostname } from './service-access.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

/** A cloud browser nobody has used for this long closes; Browser Run would end it after ten idle minutes anyway. */
const IDLE_CLOSE_MS = 5 * 60_000;
/** The longest one script runs before it is stopped. */
const RUN_LIMIT_MS = 120_000;
const RUN_STATE_KEY = 'browser.run.state';
const CdpRequest = z.object({ id: z.number().int(), method: z.string().min(1).max(256), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().max(256).optional() });
const RunResult = z.object({ ok: z.boolean(), value: z.unknown().optional(), error: z.string().optional(), state: z.unknown(), stateError: z.string().optional(), logs: z.array(z.string()), truncated: z.boolean() });

/** A client of the shared browser as the agent tools use it: the browser channel shape over a shim client. */
function shimChannel(shim: CdpBrowserShim, label: string): BrowserChannel {
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  const client = shim.client(event => { for (const listener of listeners) listener(event); }, { cursor: { label } });
  return {
    send: (method, params, sessionId) => client.send(method, params ?? {}, sessionId),
    subscribe: listener => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    close: () => client.close(),
  };
}

/** One workspace's cloud browser (docs/APERTURE-DESIGN.md §5): the only object holding its Browser Run connection, so
 * the workspace object sleeps while a browser is open, and this one closes it when unused. The agent's tools and its
 * scripts are clients of one browser through `CdpBrowserShim`. */
export class BrowserSessionDO extends BudgetedDurableObject {
  private browser: Promise<CdpBrowserShim> | undefined;
  private upstream: BrowserChannel | undefined;
  private runtime: AccountBrowserRuntime | undefined;
  /** Script connections open now, by run; the browser stays while any is. */
  private readonly scripts = new Map<string, Set<WebSocket>>();

  private shim(): Promise<CdpBrowserShim> {
    if (this.browser) return this.browser;
    const opening = (async () => {
      const upstream = await launchCloudBrowser(this.env.BROWSER, AbortSignal.timeout(30_000));
      this.upstream = upstream;
      // A dropped connection ends this browser; the next use opens another.
      upstream.subscribe(event => { if (event.method === 'disconnected' && this.browser === opening) this.release(); });
      return CdpBrowserShim.open(upstream);
    })();
    this.browser = opening;
    opening.catch(() => { if (this.browser === opening) this.browser = undefined; });
    return opening;
  }

  private release(): void {
    const upstream = this.upstream;
    this.browser = undefined;
    this.upstream = undefined;
    this.runtime = undefined;
    for (const run of this.scripts.keys()) this.endRun(run, 'Browser closed');
    if (upstream) void upstream.send('Browser.close').catch(() => {}).finally(() => upstream.close());
  }

  /** Cuts a run's connections, so a stopped script cannot keep driving the browser. */
  private endRun(run: string, reason: string): void {
    for (const socket of this.scripts.get(run) ?? []) socket.close(1001, reason);
    this.scripts.delete(run);
  }

  private async used(): Promise<void> { await this.ctx.storage.setAlarm(Date.now() + IDLE_CLOSE_MS); }

  async alarm(): Promise<void> {
    if (this.scripts.size) { await this.used(); return; }
    this.release();
  }

  /** The workspace's browser tools, and its scripts for `run`. */
  async execute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> {
    const { command } = authorization.body;
    await this.used();
    if (command.type === 'execute' && command.args.action === 'run') return this.run(authorization, command.args.script);
    const workspace = { projectId: authorization.body.scope.projectId, workspaceId: authorization.body.scope.workspaceId };
    this.runtime ??= new AccountBrowserRuntime({
      storage: this.ctx.storage,
      // One channel serves every caller's single steps, so its cursor cannot say which agent acts.
      cloud: async () => shimChannel(await this.shim(), 'Agent'),
      serviceFetch: request => fetchInternalService(this.env, { kind: 'cloud', accountId: this.env.ACCOUNT_ID, ...workspace }, request),
      serviceHostname: hostname => isHostedServiceHostname(this.env, hostname),
      workspaceServiceHostname: (hostname, grant) => isWorkspaceServiceHostname(this.env, workspace, hostname, grant),
    });
    return this.runtime.execute(authorization, AbortSignal.timeout(Math.max(1, Date.parse(authorization.body.expiresAt) - Date.now())));
  }

  /** Runs one agent-written Playwright script in a sandbox whose only way out is a CDP connection to this browser. The
   * `state` it leaves is kept for the next script. */
  private async run(authorization: RuntimeAccountBrowserAuthorization, script: string): Promise<RuntimeToolResult> {
    const { scope } = authorization.body;
    const name = this.ctx.id.name;
    if (!name) throw new Error('Browser session has no name');
    await this.shim();
    const run = crypto.randomUUID();
    const sandbox = this.env.CODEMODE_LOADER.load({
      compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js',
      modules: { 'runner.js': BROWSER_RUNNER_SOURCE, 'script.js': `export default async function ({ page, context, browser, state }) {\n${script}\n}` },
      env: { CDP: this.ctx.exports.BrowserSessionCdp({ props: { session: name, run } }) },
      globalOutbound: null,
      limits: { cpuMs: 30_000 },
    });
    type Runner = WorkerEntrypoint & { run(input: { label: string; state: unknown }): Promise<string> };
    const stopped = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      this.endRun(run, 'Script stopped');
      stopped.reject(new Error(`The script ran longer than ${RUN_LIMIT_MS / 1000} s and was stopped`));
    }, RUN_LIMIT_MS);
    let text: string;
    try { text = await Promise.race([sandbox.getEntrypoint<Runner>().run({ label: scope.conversationKind === 'main' ? 'Agent' : 'Subagent', state: await this.ctx.storage.get(RUN_STATE_KEY) ?? {} }), stopped.promise]); }
    finally { clearTimeout(timer); }
    const result = RunResult.parse(JSON.parse(text));
    if (!result.stateError) await this.ctx.storage.put(RUN_STATE_KEY, result.state);
    const { state: _state, ...reply } = result;
    return { status: 'completed', requestId: scope.requestId, attemptId: scope.attemptId, content: [{ type: 'text', text: JSON.stringify(reply) }] };
  }

  /** A script's CDP connection, from the sandbox through `BrowserSessionCdp`: `/script/<run>/<cursor label>`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a CDP WebSocket', { status: 426 });
    const [, kind, run, label] = new URL(request.url).pathname.split('/');
    if (kind !== 'script' || !run) return new Response('Unknown browser session path', { status: 404 });
    const shim = await this.shim();
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    const sockets = this.scripts.get(run) ?? new Set<WebSocket>();
    this.scripts.set(run, sockets.add(server));
    const view: CdpShimClient = shim.client(event => { if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify(event)); }, { cursor: { label: decodeURIComponent(label ?? '').slice(0, 64) || 'Agent' } });
    server.addEventListener('message', event => {
      void (async () => {
        const message = CdpRequest.parse(JSON.parse(typeof event.data === 'string' ? event.data : ''));
        try { server.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: await view.send(message.method, message.params ?? {}, message.sessionId) })); }
        catch (error) { server.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })); }
      })().catch(() => server.close(1008, 'Invalid CDP message'));
    });
    server.addEventListener('close', () => {
      sockets.delete(server);
      if (!sockets.size && this.scripts.get(run) === sockets) this.scripts.delete(run);
      void view.close(); void this.used();
    });
    return new Response(null, { status: 101, webSocket: client });
  }
}

/** The sandbox's only way out: a CDP connection to its workspace's browser session. It offers `fetch` alone, so code in
 * the sandbox cannot reach the session object's other methods, and it names the run itself (`props`, set by the
 * session), so a script cannot pass for another. Playwright puts the cursor label in the last path segment. */
export class BrowserSessionCdp extends WorkerEntrypoint<Env, { session: string; run: string }> {
  fetch(request: Request): Promise<Response> {
    const label = new URL(request.url).pathname.split('/').at(-1) ?? '';
    return this.env.BROWSER_SESSION.getByName(this.ctx.props.session).fetch(new Request(`https://browser-session/script/${this.ctx.props.run}/${label}`, request));
  }
}
