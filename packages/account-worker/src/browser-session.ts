/// <reference path="./global-props.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { BROWSER_RUN_LIMIT_MS, type RuntimeAccountBrowserAuthorization, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { launchCloudBrowser, type BrowserChannel } from './browser-cdp.js';
import { AccountBrowserRuntime } from './browser-runtime.js';
import { BROWSER_SCRIPT_PATH } from './browser-relay.js';
import { CdpBrowserShim, serveCdpSocket } from './browser-shim.js';
import { BROWSER_RUNNER_SOURCE } from './generated/browser-runner.js';
import { hostedServiceUrlPattern, isHostedServiceHostname, isWorkspaceServiceHostname } from './service-access.js';
import { SERVICE_COOKIE, type ServiceWorkspace } from './service-sessions.js';
import { BudgetedDurableObject } from './storage-quarantine.js';

/** A cloud browser nobody has used for this long closes; Browser Run would end it after ten idle minutes anyway. */
const IDLE_CLOSE_MS = 5 * 60_000;
/** A service session lasts 15 minutes from each mint; a request that finds it older than this mints again. */
const SERVICE_RENEW_MS = 10 * 60_000;
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

/** The cloud browser's sessions for its workspace's hosted services (docs/APERTURE-DESIGN.md §12): the relay mints
 * one per hostname, only for a live hostname of this workspace, and it is set as an HttpOnly cookie for exactly that
 * hostname through the browser's own connection. Pages then load the hosted URL directly, WebSockets and streamed
 * responses included. Clients of the shim cannot set or read cookies, and their network events show the cookie blank. */
export class CloudServiceCookies {
  private readonly admitted = new Map<string, { at: number; done: Promise<void> }>();
  constructor(private readonly env: Pick<Env, 'RELAY' | 'RELAY_NAME' | 'TENANT_ID'>, private readonly upstream: BrowserChannel, private readonly workspace: ServiceWorkspace) {}

  /** Gives the browser its session for `hostname` unless one set in the last 10 minutes holds; requests meanwhile wait
   * for the same one. Refused for a hostname that is not a live one of this workspace. */
  admit(hostname: string): Promise<void> {
    const held = this.admitted.get(hostname);
    if (held && Date.now() - held.at < SERVICE_RENEW_MS) return held.done;
    const done = (async () => {
      const { token, expiresAt } = await this.env.RELAY.getByName(this.env.RELAY_NAME).serviceCloudSession(hostname, this.workspace);
      await this.upstream.send('Storage.setCookies', { cookies: [{ name: SERVICE_COOKIE, value: token, url: `https://${hostname}/`, path: '/', secure: true, httpOnly: true, sameSite: 'Lax', expires: expiresAt / 1000 }] });
    })();
    this.admitted.set(hostname, { at: Date.now(), done });
    done.catch(() => { if (this.admitted.get(hostname)?.done === done) this.admitted.delete(hostname); });
    return done;
  }

  /** A client's navigation to a hosted name gets its session first, so a script's `goto` loads the service too. One
   * that is not this workspace's goes without, and the hosted path refuses it. */
  async navigating(url: string): Promise<void> {
    const hostname = URL.parse(url)?.hostname;
    if (hostname && isHostedServiceHostname(this.env, hostname)) await this.admit(hostname).catch(() => {});
  }
}

/** One workspace's browser session (docs/APERTURE-DESIGN.md §5): the only object holding its cloud browser's Browser
 * Run connection, so the workspace object sleeps while a browser is open, and this one closes it when unused. The
 * agent's tools and its scripts are clients of one browser through `CdpBrowserShim`. Scripts on your Chrome run here
 * too; their CDP connection goes to the relay, which presents the workspace group as a browser. */
export class BrowserSessionDO extends BudgetedDurableObject {
  private browser: Promise<CdpBrowserShim> | undefined;
  private upstream: BrowserChannel | undefined;
  private cookies: CloudServiceCookies | undefined;
  private runtime: AccountBrowserRuntime | undefined;
  /** The workspace this object serves, from its calls' scope: its browser holds service sessions for its hostnames only. */
  private workspace: ServiceWorkspace | undefined;
  /** Script connections open now, by run; the browser stays while any is. */
  private readonly scripts = new Map<string, Set<WebSocket>>();

  private shim(): Promise<CdpBrowserShim> {
    if (this.browser) return this.browser;
    const workspace = this.workspace;
    if (!workspace) return Promise.reject(new Error('Browser session has no workspace'));
    const opening = (async () => {
      const upstream = await launchCloudBrowser(this.env.BROWSER, AbortSignal.timeout(30_000));
      const cookies = new CloudServiceCookies(this.env, upstream, workspace);
      this.upstream = upstream;
      this.cookies = cookies;
      // A dropped connection ends this browser; the next use opens another.
      upstream.subscribe(event => { if (event.method === 'disconnected' && this.browser === opening) this.release(); });
      return CdpBrowserShim.open(upstream, { navigating: url => cookies.navigating(url) });
    })();
    this.browser = opening;
    opening.catch(() => { if (this.browser === opening) this.browser = undefined; });
    return opening;
  }

  private release(): void {
    const upstream = this.upstream;
    this.browser = undefined;
    this.upstream = undefined;
    this.cookies = undefined;
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
    const { command, scope } = authorization.body;
    // Each workspace has its own session object; a call for another workspace must never mint its service cookies here.
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${scope.projectId}:${scope.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    this.workspace = { projectId: scope.projectId, workspaceId: scope.workspaceId };
    await this.used();
    if (command.type === 'execute' && command.args.action === 'run') return this.run(authorization, command.args.script);
    const workspace = this.workspace;
    this.runtime ??= new AccountBrowserRuntime({
      storage: this.ctx.storage,
      // One channel serves every caller's single steps, so its cursor cannot say which agent acts.
      cloud: async () => shimChannel(await this.shim(), 'Agent'),
      services: {
        urlPattern: hostedServiceUrlPattern(this.env),
        hostname: hostname => isHostedServiceHostname(this.env, hostname),
        workspace: (hostname, grant) => isWorkspaceServiceHostname(this.env, workspace, hostname, grant),
        admit: async hostname => {
          if (!this.cookies) throw new Error('Cloud browser closed');
          await this.cookies.admit(hostname);
        },
      },
    });
    return this.runtime.execute(authorization, AbortSignal.timeout(Math.max(1, Date.parse(authorization.body.expiresAt) - Date.now())));
  }

  /** Runs one agent-written Playwright script in a sandbox whose only way out is a CDP connection to the cloud browser
   * or, for your Chrome, to the relay. The `state` it leaves is kept for the next script on the same browser. */
  private async run(authorization: RuntimeAccountBrowserAuthorization, script: string): Promise<RuntimeToolResult> {
    const { scope } = authorization.body, placement = scope.placement;
    const name = this.ctx.id.name;
    if (!name) throw new Error('Browser session has no name');
    const relay = placement.kind === 'account-relay' ? this.env.RELAY.getByName(this.env.RELAY_NAME) : undefined;
    // Your Chrome: the relay checks the run's authority and admits its connection by this token until the run ends.
    const relayToken = relay ? (await relay.browserRelayScriptBegin(authorization)).token : undefined;
    if (!relay) await this.shim();
    const stateKey = placement.kind === 'account-relay' ? `browser.run.state:relay:${placement.pairingId}` : 'browser.run.state:cloud';
    const run = crypto.randomUUID();
    const sandbox = this.env.CODEMODE_LOADER.load({
      compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js',
      modules: { 'runner.js': BROWSER_RUNNER_SOURCE, 'script.js': `export default async function ({ page, context, browser, state, snapshot }) {\n${script}\n}` },
      env: { CDP: this.ctx.exports.BrowserSessionCdp({ props: { session: name, run, ...(relayToken ? { relayToken } : {}) } }) },
      globalOutbound: null,
      limits: { cpuMs: 30_000 },
    });
    type Runner = WorkerEntrypoint & { run(input: { label: string; state: unknown }): Promise<string> };
    const stopped = Promise.withResolvers<never>();
    const timer = setTimeout(() => {
      this.endRun(run, 'Script stopped');
      stopped.reject(new Error(`The script ran longer than ${BROWSER_RUN_LIMIT_MS / 1000} s and was stopped`));
    }, BROWSER_RUN_LIMIT_MS);
    let text: string;
    try { text = await Promise.race([sandbox.getEntrypoint<Runner>().run({ label: scope.conversationKind === 'main' ? 'Agent' : 'Subagent', state: await this.ctx.storage.get(stateKey) ?? {} }), stopped.promise]); }
    finally {
      clearTimeout(timer);
      // Cuts the script off your Chrome; a lost end still lapses at the run's deadline.
      if (relay && relayToken) await relay.browserRelayScriptEnd(relayToken).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_relay_script_end_failed', error: String(error) })));
    }
    const result = RunResult.parse(JSON.parse(text));
    if (!result.stateError) await this.ctx.storage.put(stateKey, result.state);
    const { state: _state, ...reply } = result;
    return { status: 'completed', requestId: scope.requestId, attemptId: scope.attemptId, content: [{ type: 'text', text: JSON.stringify(reply) }] };
  }

  /** A cloud script's CDP connection, from the sandbox through `BrowserSessionCdp`: `/script/<run>/<cursor label>`. */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a CDP WebSocket', { status: 426 });
    const [, kind, run, label] = new URL(request.url).pathname.split('/');
    if (kind !== 'script' || !run) return new Response('Unknown browser session path', { status: 404 });
    const shim = await this.shim();
    const sockets = this.scripts.get(run) ?? new Set<WebSocket>();
    const { socket, response } = serveCdpSocket(shim, { cursor: { label: decodeURIComponent(label ?? '').slice(0, 64) || 'Agent' } }, () => {
      sockets.delete(socket);
      if (!sockets.size && this.scripts.get(run) === sockets) this.scripts.delete(run);
      void this.used();
    });
    this.scripts.set(run, sockets.add(socket));
    return response;
  }
}

/** The sandbox's only way out: a CDP connection to its workspace's browser session, or for a script on your Chrome to
 * the relay, admitted by the run's token. It offers `fetch` alone, so code in the sandbox cannot reach the session
 * object's other methods, and it names the run itself (`props`, set by the session), so a script cannot pass for
 * another. Playwright puts the cursor label in the last path segment. */
export class BrowserSessionCdp extends WorkerEntrypoint<Env, { session: string; run: string; relayToken?: string }> {
  fetch(request: Request): Promise<Response> {
    const label = new URL(request.url).pathname.split('/').at(-1) ?? '';
    const { session, run, relayToken } = this.ctx.props;
    if (relayToken) return this.env.RELAY.getByName(this.env.RELAY_NAME).fetch(new Request(`https://relay${BROWSER_SCRIPT_PATH}${relayToken}/${label}`, request));
    return this.env.BROWSER_SESSION.getByName(session).fetch(new Request(`https://browser-session/script/${run}/${label}`, request));
  }
}
