import { z } from 'zod';
import type { RuntimeAccountBrowserSignedGrant } from '@gitspace/protocol-runtime';
import type { BrowserChannel } from './browser-cdp.js';

type Params = Record<string, unknown>;
type Listener = Parameters<BrowserChannel['subscribe']>[0];

/** The only browser context a script sees on your Chrome: the workspace group. */
export const RELAY_BROWSER_CONTEXT = 'gitspace-group';
const ONE_CONTEXT = 'Your Chrome has one context, the workspace group';
/** Browser-level commands answered without effect: a script never changes your Chrome's downloads or windows, and
 * target discovery and auto-attach are the shim's, per client. */
const WITHOUT_EFFECT: Readonly<Record<string, true>> = { 'Browser.setDownloadBehavior': true, 'Browser.setWindowBounds': true, 'Target.setDiscoverTargets': true, 'Target.setAutoAttach': true };
const Tab = z.object({ targetId: z.string(), title: z.string(), url: z.string() });
const Opened = z.object({ targetId: z.string(), sessionId: z.string() });

/** How one script run reaches your Chrome: the extension's run operations, and its events by tab. */
export type RelayRunLink = {
  /** Chrome's product from the extension's hello, such as `Chrome/131.0.6778.86`. */
  product: string;
  grant: RuntimeAccountBrowserSignedGrant;
  attemptId: string;
  /** Sends one operation to the extension and returns its reply; refused once the run ended. */
  request(message: Params): Promise<unknown>;
  /** The extension's events for one tab; `disconnected` when the tab leaves the workspace's reach. */
  listen(targetId: string, listener: Listener): () => void;
};

/** Your Chrome as a whole browser for one script (docs/APERTURE-DESIGN.md §6.1). Playwright connects to a browser;
 * `chrome.debugger` attaches to single tabs. This answers browser-level commands over the extension's run operations:
 * the workspace group is the only context, its tabs are the only targets, a new target is a new agent tab in the group,
 * and a tab's commands go to the extension under its lease session, the session the script sees. `CdpBrowserShim`
 * sits on top, as it does on the cloud browser. */
export class RelayBrowser implements BrowserChannel {
  /** Tabs this run attached, by lease session. */
  private readonly attached = new Map<string, { targetId: string; unlisten(): void }>();
  private readonly listeners = new Set<Listener>();
  /** Commands your Chrome has not answered yet, and when the last tab event came: why a script that stopped at its
   * time limit was waiting (`waiting`). */
  private readonly unanswered = new Map<number, { method: string; sentAt: number }>();
  private sent = 0;
  private lastEventAt: number | null = null;

  constructor(private readonly link: RelayRunLink) {}

  /** What the script waited on: the oldest command your Chrome has not answered, else how long no tab event came. */
  waiting(now = Date.now()): string {
    const oldest = [...this.unanswered.values()].sort((left, right) => left.sentAt - right.sentAt)[0];
    if (oldest) return `your Chrome had not answered ${oldest.method} for ${Math.round((now - oldest.sentAt) / 1000)} s`;
    return this.lastEventAt === null ? 'no command was waiting on your Chrome and no event came from its tabs' : `no command was waiting on your Chrome and its tabs sent no event for ${Math.round((now - this.lastEventAt) / 1000)} s`;
  }

  async send(method: string, params: Params = {}, sessionId?: string): Promise<unknown> {
    // Browser-domain commands concern the whole browser even on a tab's session (Playwright asks a page for its
    // window), so they are answered here and never reach your Chrome.
    if (sessionId && !method.startsWith('Browser.')) {
      const tab = this.attached.get(sessionId);
      if (!tab) throw new Error(`Session ${sessionId} is not attached`);
      const result = await this.command(tab.targetId, sessionId, method, params);
      // A page that closed itself is gone, as after `Target.closeTarget`.
      if (method === 'Page.close') { this.gone(sessionId, tab.targetId); this.emit({ method: 'Target.targetDestroyed', params: { targetId: tab.targetId } }); }
      return result;
    }
    if (WITHOUT_EFFECT[method]) return {};
    switch (method) {
      case 'Browser.getVersion': return { protocolVersion: '1.3', product: this.link.product, revision: '', userAgent: '', jsVersion: '' };
      case 'Browser.getWindowForTarget': return { windowId: 1, bounds: { left: 0, top: 0, width: 1280, height: 720, windowState: 'normal' } };
      case 'Target.getTargets': return { targetInfos: await this.targets() };
      case 'Target.getTargetInfo': {
        // Without a target, the browser itself, as Playwright asks once it auto-attaches.
        if (params.targetId === undefined) return { targetInfo: { targetId: 'gitspace-browser', type: 'browser', title: '', url: '', attached: true, canAccessOpener: false } };
        const targetInfo = (await this.targets()).find(target => target.targetId === params.targetId);
        if (!targetInfo) throw new Error('No such tab in the workspace group');
        return { targetInfo };
      }
      case 'Target.attachToTarget': {
        if (typeof params.targetId !== 'string') throw new Error('Target.attachToTarget needs a targetId');
        return { sessionId: await this.attach(params.targetId) };
      }
      case 'Target.detachFromTarget': {
        // The tab stays attached in your Chrome until the run ends; only this script lets it go now.
        if (typeof params.sessionId === 'string') this.detach(params.sessionId);
        return {};
      }
      case 'Target.createTarget': {
        if (params.browserContextId !== undefined && params.browserContextId !== RELAY_BROWSER_CONTEXT) throw new Error(ONE_CONTEXT);
        const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
        const opened = Opened.parse(await this.link.request({ operation: 'open', grant: this.link.grant, attemptId: this.link.attemptId, url }));
        this.track(opened.targetId, opened.sessionId);
        return { targetId: opened.targetId };
      }
      case 'Target.closeTarget': {
        const targetId = params.targetId;
        const sessionId = [...this.attached].find(([, tab]) => tab.targetId === targetId)?.[0];
        if (typeof targetId !== 'string' || !sessionId) throw new Error('Target.closeTarget needs a tab this script attached');
        // The extension closes only tabs the agent added; your own tabs stay.
        const result = await this.command(targetId, sessionId, method, { targetId });
        this.gone(sessionId, targetId);
        this.emit({ method: 'Target.targetDestroyed', params: { targetId } });
        return result;
      }
      case 'Target.createBrowserContext':
      case 'Target.disposeBrowserContext': throw new Error(ONE_CONTEXT);
      default: throw new Error(`${method} is not available on your Chrome`);
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Lets go of this run's tabs; they stay in the workspace group. */
  async close(): Promise<void> {
    for (const sessionId of [...this.attached.keys()]) this.detach(sessionId);
    this.listeners.clear();
  }

  private async command(targetId: string, sessionId: string, method: string, params: Params): Promise<unknown> {
    const id = ++this.sent;
    this.unanswered.set(id, { method, sentAt: Date.now() });
    try { return await this.link.request({ operation: 'command', targetId, sessionId, method, params, attemptId: this.link.attemptId }); }
    finally { this.unanswered.delete(id); }
  }

  /** The group's tabs as page targets of the one context. */
  private async targets() {
    const tabs = z.array(Tab).parse(await this.link.request({ operation: 'tabs', groupId: this.link.grant.body.groupId, attemptId: this.link.attemptId }));
    const attached = new Set([...this.attached.values()].map(tab => tab.targetId));
    return tabs.map(tab => ({ targetId: tab.targetId, type: 'page', title: tab.title, url: tab.url, attached: attached.has(tab.targetId), canAccessOpener: false, browserContextId: RELAY_BROWSER_CONTEXT }));
  }

  private async attach(targetId: string): Promise<string> {
    const known = [...this.attached].find(([, tab]) => tab.targetId === targetId)?.[0];
    if (known) return known;
    const opened = Opened.parse(await this.link.request({ operation: 'open', grant: this.link.grant, attemptId: this.link.attemptId, targetId }));
    if (opened.targetId !== targetId) throw new Error('Browser target mismatch');
    this.track(targetId, opened.sessionId);
    return opened.sessionId;
  }

  /** Forwards a tab's events under its lease session; a tab that closes or leaves the group detaches. */
  private track(targetId: string, sessionId: string): void {
    if (this.attached.has(sessionId)) return;
    const unlisten = this.link.listen(targetId, event => {
      this.lastEventAt = Date.now();
      if (event.method === 'disconnected') this.gone(sessionId, targetId);
      else if (event.method) this.emit({ method: event.method, params: event.params, sessionId });
    });
    this.attached.set(sessionId, { targetId, unlisten });
  }

  private detach(sessionId: string): void {
    this.attached.get(sessionId)?.unlisten();
    this.attached.delete(sessionId);
  }

  /** A tab the script can no longer use, announced as Chrome announces a closed one. */
  private gone(sessionId: string, targetId: string): void {
    if (!this.attached.has(sessionId)) return;
    this.detach(sessionId);
    this.emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId } });
  }

  private emit(event: Parameters<Listener>[0]): void {
    for (const listener of this.listeners) listener(event);
  }
}
