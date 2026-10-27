/// <reference path="./global-props.d.ts" />
import { WorkerEntrypoint } from 'cloudflare:workers';
import { z } from 'zod';
import { BROWSER_RUN_LIMIT_MS, RuntimeBrowserHolderSchema, type RuntimeAccountBrowserAuthorization, type RuntimeBrowserCapture, type RuntimeBrowserHolder, type RuntimeBrowserPreview, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { launchCloudBrowser, type BrowserChannel } from './browser-cdp.js';
import { AccountBrowserRuntime } from './browser-runtime.js';
import { BROWSER_CLOUD_RENEW_MS, BROWSER_SCRIPT_PATH } from './browser-relay.js';
import { CdpBrowserShim, serveCdpSocket, type CdpShimOptions } from './browser-shim.js';
import { BROWSER_TAB_HELD } from './browser-takeover.js';
import { BROWSER_RUNNER_SOURCE } from './generated/browser-runner.js';
import { hostedServiceUrlPattern, isHostedServiceHostname, isWorkspaceServiceHostname } from './service-access.js';
import { localhostPort, localhostRefusal, type WorkspaceServiceUrl } from './workspace-service-urls.js';
import { SERVICE_COOKIE, type ServiceWorkspace } from './service-sessions.js';
import { BudgetedDurableObject } from './storage-quarantine.js';
import { CloudCaptures } from './browser-capture.js';
import { CloudDownloads } from './browser-downloads.js';
import { ScriptRunFiles, type ScriptUploadFiles } from './browser-script-files.js';
import { workspaceDrive } from './workspace-drive.js';
import { BROWSER_WATCH_INTERNAL_PATH, browserWatchDeviceActive, CloudWatch } from './browser-watch.js';

/** A cloud browser nobody has used for this long closes; Browser Run would end it after ten idle minutes anyway. */
const IDLE_CLOSE_MS = 5 * 60_000;
/** What a cloud script's command to a tab you hold answers, and every later command of that script. */
const SCRIPT_TAKEN = 'The user took over this tab; the script stopped at its next command';
/** Where the tabs you hold are kept (docs/APERTURE-DESIGN.md §7.2), with their workspace, so a restart of this object
 * (which ends its browser) still hands them back. */
const HOLDERS_KEY = 'browser.holders';
const StoredHolders = z.object({ projectId: z.string(), workspaceId: z.string(), holders: z.array(RuntimeBrowserHolderSchema) });
/** A take over or Resume agent on a cloud tab: the tabs you held before and after, and the tab's page (null once it
 * is gone). */
export type BrowserHoldChange = { before: RuntimeBrowserHolder[]; after: RuntimeBrowserHolder[]; page: { url: string; title: string } | null };
/** A service session lasts 15 minutes from each mint; a request that finds it older than this mints again. */
const SERVICE_RENEW_MS = 10 * 60_000;
const RunResult = z.object({ ok: z.boolean(), value: z.unknown().optional(), view: z.string().optional(), viewError: z.string().optional(), error: z.string().optional(), state: z.unknown(), stateError: z.string().optional(), logs: z.array(z.string()), truncated: z.boolean() });
const Targets = z.object({ targetInfos: z.array(z.object({ targetId: z.string(), type: z.string(), url: z.string(), title: z.string() })) });
const LayoutMetrics = z.object({ cssVisualViewport: z.object({ pageX: z.number(), pageY: z.number(), clientWidth: z.number().positive(), clientHeight: z.number().positive() }) });
/** Previews are at most this wide, small enough to refresh often. */
const PREVIEW_WIDTH = 480;

/** The pages open in a browser, as the Inspector's Browser tab lists them. */
export async function browserPages(shim: CdpBrowserShim): Promise<{ targetId: string; url: string; title: string }[]> {
  const client = shim.client(() => {});
  try { return Targets.parse(await client.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page').map(({ targetId, url, title }) => ({ targetId, url: url.slice(0, 8192), title: title.slice(0, 500) })); }
  finally { await client.close(); }
}

/** A small JPEG of a page's visible area, through a client of its own that lets the page go afterwards. */
export async function browserPreview(shim: CdpBrowserShim, targetId: string): Promise<RuntimeBrowserPreview> {
  const client = shim.client(() => {});
  try {
    const { sessionId } = z.object({ sessionId: z.string() }).parse(await client.send('Target.attachToTarget', { targetId, flatten: true }));
    const viewport = LayoutMetrics.parse(await client.send('Page.getLayoutMetrics', {}, sessionId)).cssVisualViewport;
    const clip = { x: viewport.pageX, y: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: Math.min(1, PREVIEW_WIDTH / viewport.clientWidth) };
    const { data } = z.object({ data: z.string() }).parse(await client.send('Page.captureScreenshot', { format: 'jpeg', quality: 50, clip }, sessionId));
    return { targetId, capturedAt: new Date().toISOString(), image: { mediaType: 'image/jpeg', data }, reason: null };
  } finally { await client.close(); }
}

/** A client of the shared browser as the agent tools use it: the browser channel shape over a shim client. */
function shimChannel(shim: CdpBrowserShim, label: string, hold: CdpShimOptions['hold']): BrowserChannel {
  const listeners = new Set<Parameters<BrowserChannel['subscribe']>[0]>();
  // A storage step reaches the cookies of the site it names (`browser-powers.ts`), the service session cookie never.
  const client = shim.client(event => { for (const listener of listeners) listener(event); }, { cursor: { label }, hold, siteCookies: true });
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
  /** `services` lists the workspace's running http services at their workspace URLs. */
  constructor(private readonly env: Pick<Env, 'RELAY' | 'RELAY_NAME' | 'TENANT_ID'>, private readonly upstream: BrowserChannel, private readonly workspace: ServiceWorkspace, private readonly services: () => Promise<WorkspaceServiceUrl[]>) {}

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
   * that is not this workspace's goes without, and the hosted path refuses it. A navigation to localhost, which the
   * cloud browser cannot reach, is refused with the workspace URL of the service on that port, if any. */
  async navigating(url: string): Promise<void> {
    const port = localhostPort(url);
    if (port !== null) throw new Error(localhostRefusal(port, await this.services()));
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
  /** Tabs being captured; the browser stays while any is. */
  private readonly captures = new CloudCaptures();
  /** Each running script's files (its captures, uploads and the downloads while it runs), by run. */
  private readonly runFiles = new Map<string, ScriptRunFiles>();
  /** When this object last told the account its cloud browser is open (`tellAccount`); 0 once it said it closed. */
  private toldOpen = 0;
  /** The tabs you hold now, by target (docs/APERTURE-DESIGN.md §7.2): none of the agent's commands reach them, a
   * single step's and a script's alike. Kept in `HOLDERS_KEY`. */
  private readonly held = new Map<string, RuntimeBrowserHolder>();
  /** Scripts that reached a tab you hold: each later command of theirs is refused too. */
  private readonly stopped = new Set<string>();
  /** The Watch dialog's sockets on cloud tabs (`browser-watch.ts`): your input there counts as use; watching alone does not. */
  private readonly watch = new CloudWatch(this.ctx, {
    browser: () => this.browser,
    holder: targetId => this.held.get(targetId),
    used: () => { if (this.browser) this.ctx.waitUntil(this.used()); },
    deviceActive: deviceId => browserWatchDeviceActive(this.env, deviceId),
  });

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // This object restarting ended the browser it held, so the tabs you held there are gone: they go back to the agent.
    void ctx.blockConcurrencyWhile(async () => {
      const stored = StoredHolders.safeParse(await ctx.storage.get(HOLDERS_KEY));
      if (!stored.success) return;
      for (const holder of stored.data.holders) this.held.set(holder.targetId, holder);
      ctx.waitUntil(this.returnHolders('the cloud browser restarted, so the tab is gone; open a new one if you still need it.'));
    });
  }

  private shim(): Promise<CdpBrowserShim> {
    if (this.browser) return this.browser;
    const workspace = this.workspace;
    if (!workspace) return Promise.reject(new Error('Browser session has no workspace'));
    const opening = (async () => {
      const upstream = await launchCloudBrowser(this.env.BROWSER, AbortSignal.timeout(30_000));
      const cookies = new CloudServiceCookies(this.env, upstream, workspace, () => this.env.PROJECT_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${workspace.projectId}`).workspaceServices(workspace.workspaceId));
      this.upstream = upstream;
      this.cookies = cookies;
      // A dropped connection ends this browser; the next use opens another.
      upstream.subscribe(event => { if (event.method === 'disconnected' && this.browser === opening) this.release('the cloud browser’s connection ended, so the tab is gone; open a new one if you still need it.'); });
      const shim = await CdpBrowserShim.open(upstream, { navigating: url => cookies.navigating(url) });
      // Downloads go to the workspace drive; each running cloud script lists those started while it ran.
      await CloudDownloads.open(shim, workspaceDrive(this.env, workspace), download => {
        for (const files of this.runFiles.values()) if (files.browser.source === 'headless') files.downloaded(download);
      });
      this.tellAccount(true);
      return shim;
    })();
    this.browser = opening;
    opening.catch(() => { if (this.browser === opening) this.browser = undefined; });
    return opening;
  }

  /** Ends the browser; the tabs you held there go back to the agent, `note` saying why. */
  private release(note: string): void {
    // Also after this object restarted: the account may still count the browser it held before.
    this.tellAccount(false);
    const upstream = this.upstream;
    void this.captures.stopAll('The cloud browser closed');
    this.browser = undefined;
    this.upstream = undefined;
    this.cookies = undefined;
    this.runtime = undefined;
    for (const run of this.scripts.keys()) this.endRun(run, 'Browser closed');
    if (upstream) void upstream.send('Browser.close').catch(() => {}).finally(() => upstream.close());
    if (this.held.size) this.ctx.waitUntil(this.returnHolders(note));
    this.watch.browserClosed('ended');
  }

  /** The tabs you held go back to the agent (their browser closed): the workspace hears it with `note`. */
  private async returnHolders(note: string): Promise<void> {
    const stored = StoredHolders.safeParse(await this.ctx.storage.get(HOLDERS_KEY));
    const holders = [...this.held.values()];
    this.held.clear();
    for (const holder of holders) this.holderChanged(holder.targetId);
    await this.ctx.storage.delete(HOLDERS_KEY);
    if (!stored.success || !holders.length) return;
    const { projectId, workspaceId } = stored.data;
    await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${workspaceId}`).browserCloudReturned({ projectId, workspaceId }, holders, note)
      .catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_cloud_return_failed', workspaceId, error: String(error) })));
  }

  /** Cuts a run's connections, so a stopped script cannot keep driving the browser. */
  private endRun(run: string, reason: string): void {
    for (const socket of this.scripts.get(run) ?? []) socket.close(1001, reason);
    this.scripts.delete(run);
  }

  private async used(): Promise<void> {
    if (this.upstream && Date.now() - this.toldOpen >= BROWSER_CLOUD_RENEW_MS) this.tellAccount(true);
    await this.ctx.storage.setAlarm(Date.now() + IDLE_CLOSE_MS);
  }

  /** Tells the account whether this workspace's cloud browser is open, for Plugins → Browsers. A failed notice is only
   * logged: the account forgets an open browser it stops hearing about. */
  private tellAccount(open: boolean): void {
    const session = this.ctx.id.name;
    if (!session) return;
    this.toldOpen = open ? Date.now() : 0;
    this.ctx.waitUntil(this.env.RELAY.getByName(this.env.RELAY_NAME).browserRelayCloudOpen(session, open).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_cloud_open_notice_failed', session, open, error: String(error) }))));
  }

  /** Real use pushes this deadline (`used`): the agent's commands and your input in the Watch dialog. A dialog left open
   * with nothing happening does not, so the browser closes at the idle time and its viewers say why. */
  async alarm(): Promise<void> {
    if (this.scripts.size || this.captures.recording) { await this.used(); return; }
    this.watch.browserClosed('idle');
    this.release(`the cloud browser closed after ${IDLE_CLOSE_MS / 60_000} minutes without use while the user held the tab, so it is gone; open a new one if you still need it.`);
  }

  /** The cloud browser's pages, running scripts and the tabs you hold, for the Inspector's Browser tab. With no browser
   * open there is nothing to show, and none is opened to show it. */
  async overview(): Promise<{ tabs: { targetId: string; url: string; title: string }[]; running: number; held: RuntimeBrowserHolder[] }> {
    return { tabs: this.browser ? await browserPages(await this.browser) : [], running: this.scripts.size, held: [...this.held.values()] };
  }

  /** Who holds a cloud tab you took over; undefined while the agent does. */
  holderOf(targetId: string): RuntimeBrowserHolder | undefined {
    return this.held.get(targetId);
  }

  /** The cloud tabs you hold, for the workspace (a single step on one waits for you to hand it back). */
  holders(): RuntimeBrowserHolder[] {
    return [...this.held.values()];
  }

  /** A tab's holder changed: the agent's refs on it no longer apply. */
  private holderChanged(targetId: string): void {
    this.runtime?.invalidate(targetId);
    this.watch.holderChanged(targetId);
  }

  /** Keeps the tabs you hold with their workspace, or forgets them when none is left. */
  private async keepHolders(workspace: { projectId: string; workspaceId: string }): Promise<void> {
    if (this.held.size) await this.ctx.storage.put(HOLDERS_KEY, { projectId: workspace.projectId, workspaceId: workspace.workspaceId, holders: [...this.held.values()] });
    else await this.ctx.storage.delete(HOLDERS_KEY);
  }

  /** You take a cloud tab over from GitSpace (docs/APERTURE-DESIGN.md §7.2) from `device`: none of the agent's commands
   * reach it until `resume`. Taking it again from another device moves `device`; it stays yours since the first take. */
  async takeOver(input: { projectId: string; workspaceId: string; targetId: string; device: string | null }): Promise<BrowserHoldChange> {
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${input.projectId}:${input.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    if (!this.browser) throw new Error('The cloud browser is not running');
    const page = (await browserPages(await this.browser)).find(tab => tab.targetId === input.targetId);
    if (!page) throw new Error('That tab is not open in the cloud browser');
    const before = [...this.held.values()];
    this.held.set(input.targetId, { targetId: input.targetId, holder: 'you', since: this.held.get(input.targetId)?.since ?? new Date().toISOString(), by: 'gitspace', device: input.device });
    await this.keepHolders(input);
    await this.used();
    this.holderChanged(input.targetId);
    return { before, after: [...this.held.values()], page: { url: page.url, title: page.title } };
  }

  /** Resume agent on a cloud tab you hold: the agent's commands reach it again, and its earlier refs on it are stale. */
  async resume(input: { projectId: string; workspaceId: string; targetId: string }): Promise<BrowserHoldChange> {
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${input.projectId}:${input.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    const before = [...this.held.values()];
    if (this.held.delete(input.targetId)) {
      await this.keepHolders(input);
      this.holderChanged(input.targetId);
      if (this.browser) await this.used();
    }
    const page = this.browser ? (await browserPages(await this.browser)).find(tab => tab.targetId === input.targetId) : undefined;
    return { before, after: [...this.held.values()], page: page ? { url: page.url, title: page.title } : null };
  }

  /** One cloud tab's preview; none while no browser is open. */
  async preview(targetId: string): Promise<RuntimeBrowserPreview> {
    if (!this.browser) return { targetId, capturedAt: new Date().toISOString(), image: null, reason: 'The cloud browser is not running' };
    return browserPreview(await this.browser, targetId);
  }

  /** Closes one cloud tab (Close tab in the Browser tab); with no browser open there is none to close. */
  async closeTab(targetId: string): Promise<void> {
    if (!this.browser) throw new Error('The cloud browser is not running');
    const client = (await this.browser).client(() => {});
    try { await client.send('Target.closeTarget', { targetId }); } finally { await client.close(); }
  }

  /** Starts recording a cloud tab's screencast into the workspace's drive (you, from the Browser tab). The browser
   * must be open already: a capture never opens one. */
  async captureStart(input: { projectId: string; workspaceId: string; captureId: string; groupId: string; targetId: string }): Promise<RuntimeBrowserCapture> {
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${input.projectId}:${input.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    if (!this.browser) throw new Error('The cloud browser is not running');
    await this.used();
    return this.captures.start(await this.browser, workspaceDrive(this.env, input), input);
  }

  /** Stops a cloud capture and saves it; one whose recording was lost when the browser closed is saved as failed. */
  async captureStop(input: { projectId: string; workspaceId: string; captureId: string }): Promise<RuntimeBrowserCapture> {
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${input.projectId}:${input.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    return this.captures.stop(input.captureId, undefined, workspaceDrive(this.env, input));
  }

  /** The workspace's browser tools, and its scripts for `run`. */
  async execute(authorization: RuntimeAccountBrowserAuthorization): Promise<RuntimeToolResult> {
    const { command, scope } = authorization.body;
    // Each workspace has its own session object; a call for another workspace must never mint its service cookies here.
    if (this.ctx.id.name !== `${this.env.ACCOUNT_ID}:${scope.projectId}:${scope.workspaceId}`) throw new Error('Browser session belongs to another workspace');
    this.workspace = { projectId: scope.projectId, workspaceId: scope.workspaceId };
    await this.used();
    if (command.type === 'execute' && command.args.action === 'run') return this.run(authorization, command.args.script);
    // The workspace waits for you to hand a tab back before its step; one that reaches here meanwhile is refused.
    if (command.type === 'execute' && 'targetId' in command.args && command.args.targetId !== undefined && this.held.has(command.args.targetId)) return { status: 'failed', requestId: scope.requestId, attemptId: scope.attemptId, content: [], error: { code: 'BROWSER_TAB_HELD', message: BROWSER_TAB_HELD } };
    const workspace = this.workspace;
    this.runtime ??= new AccountBrowserRuntime({
      storage: this.ctx.storage,
      // One channel serves every caller's single steps, so its cursor cannot say which agent acts.
      cloud: async () => shimChannel(await this.shim(), 'Agent', { holds: targetId => this.held.has(targetId), refuse: () => BROWSER_TAB_HELD }),
      // Debug files of the cloud browser's tabs (`browser-powers.ts`).
      drive: identity => workspaceDrive(this.env, identity),
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
    const { scope, command } = authorization.body, placement = scope.placement;
    const name = this.ctx.id.name;
    if (!name) throw new Error('Browser session has no name');
    if (command.type !== 'execute') throw new Error('Browser script authorization required');
    const relay = placement.kind === 'account-relay' ? this.env.RELAY.getByName(this.env.RELAY_NAME) : undefined;
    // Your Chrome: the relay checks the run's authority and admits its connection by this token until the run ends.
    const relayToken = relay ? (await relay.browserRelayScriptBegin(authorization)).token : undefined;
    if (!relay) await this.shim();
    const stateKey = placement.kind === 'account-relay' ? `browser.run.state:relay:${placement.pairingId}` : 'browser.run.state:cloud';
    const run = crypto.randomUUID(), groupId = command.grant.body.groupId;
    const files = new ScriptRunFiles(workspaceDrive(this.env, scope), relay && placement.kind === 'account-relay'
      ? { source: 'relay', groupId, chrome: async () => {
        const pairing = (await relay.browserRelayStatus()).pairings.find(item => item.pairingId === placement.pairingId);
        return { name: pairing?.name ?? 'Your Chrome', protocol: pairing?.extension?.protocol ?? 0 };
      } }
      : { source: 'headless', groupId });
    this.runFiles.set(run, files);
    const sandbox = this.env.CODEMODE_LOADER.load({
      compatibilityDate: '2026-08-27', compatibilityFlags: ['nodejs_compat'], mainModule: 'runner.js',
      modules: { 'runner.js': BROWSER_RUNNER_SOURCE, 'script.js': `export default async function ({ page, context, browser, state, view, act, capture, upload }) {\n${script}\n}` },
      env: {
        CDP: this.ctx.exports.BrowserSessionCdp({ props: { session: name, run, ...(relayToken ? { relayToken } : {}) } }),
        FILES: this.ctx.exports.BrowserSessionFiles({ props: { session: name, run } }),
      },
      globalOutbound: null,
      limits: { cpuMs: 30_000 },
    });
    type Runner = WorkerEntrypoint & { run(input: { label: string; state: unknown }): Promise<string> };
    const stopped = Promise.withResolvers<never>();
    const limit = `The script ran longer than ${BROWSER_RUN_LIMIT_MS / 1000} s and was stopped`;
    const timer = setTimeout(() => {
      this.endRun(run, 'Script stopped');
      stopped.reject(new Error(limit));
    }, BROWSER_RUN_LIMIT_MS);
    let text: string;
    // Downloads your Chrome's extension saved for this run, which it finishes uploading before the run ends.
    let chromeDownloads: { path: string; size: number; mediaType: string }[] = [];
    // Why your Chrome stopped the script (you took one of its tabs over), which its result says instead of the error
    // its Playwright saw as its connection closed.
    let takenOver: string | null = null;
    // What the script was waiting on in your Chrome as it ended, which a script stopped at its time limit says.
    let waiting: string | null = null;
    try {
      try { text = await Promise.race([sandbox.getEntrypoint<Runner>().run({ label: scope.conversationKind === 'main' ? 'Agent' : 'Subagent', state: await this.ctx.storage.get(stateKey) ?? {} }), stopped.promise]); }
      finally {
        clearTimeout(timer);
        this.runFiles.delete(run);
        this.stopped.delete(run);
        // Cuts the script off your Chrome; a lost end still lapses at the run's deadline.
        if (relay && relayToken) ({ downloads: chromeDownloads, stopped: takenOver, waiting } = await relay.browserRelayScriptEnd(relayToken).catch((error: unknown) => { console.warn(JSON.stringify({ event: 'browser_relay_script_end_failed', error: String(error) })); return { downloads: [], stopped: null, waiting: null }; }));
      }
    } catch (error) {
      if (waiting && error instanceof Error && error.message === limit) throw new Error(`${limit}: ${waiting}`);
      throw error;
    }
    const ran = RunResult.parse(JSON.parse(text));
    const result = takenOver ? { ...ran, ok: false, value: undefined, error: takenOver } : ran;
    if (!result.stateError) await this.ctx.storage.put(stateKey, result.state);
    const { state: _state, view, ...reply } = result;
    const { downloads, content } = await files.report(chromeDownloads);
    // The view of the page the script ended on follows as its own text, the indented page observe shows; then each
    // capture's address and image.
    return { status: 'completed', requestId: scope.requestId, attemptId: scope.attemptId, content: [{ type: 'text', text: JSON.stringify(downloads.length ? { ...reply, downloads } : reply) }, ...(view === undefined ? [] : [{ type: 'text' as const, text: view }]), ...content] };
  }

  /** A running script's `capture()`, from its sandbox through `BrowserSessionFiles`. */
  async scriptCapture(run: string, shot: unknown): Promise<{ captureId: string; url: string }> {
    const files = this.runFiles.get(run);
    if (!files) throw new Error('The script run ended');
    return files.capture(shot);
  }

  /** The drive files a running script's `upload()` sets, from its sandbox through `BrowserSessionFiles`. */
  async scriptUploadFiles(run: string, urls: unknown): Promise<ScriptUploadFiles> {
    const files = this.runFiles.get(run);
    if (!files) throw new Error('The script run ended');
    return files.uploadFiles(urls);
  }

  /** A cloud script's CDP connection, from the sandbox through `BrowserSessionCdp`: `/script/<run>/<cursor label>`; or
   * the Watch dialog's socket on a cloud tab, checked by its route (`serveBrowserWatch`). */
  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a CDP WebSocket', { status: 426 });
    const url = new URL(request.url);
    if (url.pathname === BROWSER_WATCH_INTERNAL_PATH) return this.watch.accept(request);
    const [, kind, run, label] = url.pathname.split('/');
    if (kind !== 'script' || !run) return new Response('Unknown browser session path', { status: 404 });
    const shim = await this.shim();
    const sockets = this.scripts.get(run) ?? new Set<WebSocket>();
    // The script's first command to a tab you hold stops it: that command and every later one is refused.
    const hold = { holds: (targetId: string) => this.held.has(targetId), refuse: () => { this.stopped.add(run); return SCRIPT_TAKEN; } };
    const { socket, response } = serveCdpSocket(shim, { cursor: { label: decodeURIComponent(label ?? '').slice(0, 64) || 'Agent' }, hold, policy: () => this.stopped.has(run) ? SCRIPT_TAKEN : null }, () => {
      sockets.delete(socket);
      if (!sockets.size && this.scripts.get(run) === sockets) this.scripts.delete(run);
      void this.used();
    });
    this.scripts.set(run, sockets.add(socket));
    return response;
  }

  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer): Promise<void> {
    if (this.watch.owns(socket)) await this.watch.message(socket, data).catch(() => { if (socket.readyState === 1) socket.close(1011, 'Watch message failed'); });
  }
  async webSocketClose(socket: WebSocket): Promise<void> {
    const left = this.watch.owns(socket) ? this.watch.closed(socket) : undefined;
    socket.close();
    await left;
  }
  async webSocketError(socket: WebSocket): Promise<void> {
    const left = this.watch.owns(socket) ? this.watch.closed(socket) : undefined;
    if (socket.readyState === 1) socket.close(1011, 'Watch socket failed');
    await left;
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

/** What the sandbox gets back from `BrowserSessionFiles`: a value, or the refusal as text, which the runner throws to
 * the script (as codemode's capabilities do), so no exception crosses into the sandbox. A module function, not a
 * method: every method of an entrypoint is callable from the sandbox. */
type FilesReply<Value> = { ok: true; value: Value } | { ok: false; error: string };
async function filesReply<Value>(operation: Promise<Value>): Promise<FilesReply<Value>> {
  try { return { ok: true, value: await operation }; }
  catch (error) { return { ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 4096) }; }
}

/** The sandbox's only way to the workspace drive: a script's `capture()` and `upload()`, for its own run only (`props`,
 * set by the session). The session holds what the run may do, and refuses once it ended. */
export class BrowserSessionFiles extends WorkerEntrypoint<Env, { session: string; run: string }> {
  capture(shot: unknown): Promise<FilesReply<{ captureId: string; url: string }>> {
    return filesReply(this.env.BROWSER_SESSION.getByName(this.ctx.props.session).scriptCapture(this.ctx.props.run, shot));
  }

  uploadFiles(urls: unknown): Promise<FilesReply<ScriptUploadFiles>> {
    return filesReply<ScriptUploadFiles>(this.env.BROWSER_SESSION.getByName(this.ctx.props.session).scriptUploadFiles(this.ctx.props.run, urls));
  }
}
