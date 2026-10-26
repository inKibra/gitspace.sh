import { z } from 'zod';
import type { BrowserChannel } from './browser-cdp.js';
import { SERVICE_COOKIE } from './service-sessions.js';

type Params = Record<string, unknown>;
export interface CdpEvent { method: string; params?: Params; sessionId?: string }
/** Null allows a command; a string refuses it with that reason. Applies to every client command, scripts included. */
export type CdpPolicy = (method: string, params: Params, sessionId: string | undefined) => string | null;
export interface CdpShimOptions {
  policy?: CdpPolicy;
  /** Take over (docs/APERTURE-DESIGN.md §7.2): while `holds` says you hold a tab, every command of this client that
   * reaches it is refused with what `refuse` answers, and that tab's events are held back from the client. */
  hold?: { holds(targetId: string): boolean; refuse(targetId: string): string };
  /** Draws the ghost cursor on this client's pages, labeled with who acts (docs/APERTURE-DESIGN.md §6.4). */
  cursor?: { label: string };
  /** Runs before a client's navigation (`Page.navigate`, `Target.createTarget`) reaches the browser. */
  navigating?: (url: string) => Promise<void>;
}

const WHOLE_BROWSER = 'reaches the whole browser', COOKIES = 'reads or sets cookies';
/** Cookie and cache commands, refused for every client, as Playwriter does even for trusted agents: no client reads
 * the browser's cookies, its service session cookie included. */
const REFUSED_COMMANDS: Readonly<Record<string, string>> = {
  'Network.getAllCookies': WHOLE_BROWSER, 'Network.clearBrowserCookies': WHOLE_BROWSER, 'Network.clearBrowserCache': WHOLE_BROWSER,
  'Storage.getCookies': WHOLE_BROWSER, 'Storage.setCookies': WHOLE_BROWSER, 'Storage.clearCookies': WHOLE_BROWSER, 'Storage.clearDataForOrigin': WHOLE_BROWSER, 'Storage.clearDataForStorageKey': WHOLE_BROWSER,
  'Network.getCookies': COOKIES, 'Network.setCookie': COOKIES, 'Network.setCookies': COOKIES, 'Network.deleteCookies': COOKIES,
};
const SERVICE_COOKIE_VALUE = new RegExp(`${SERVICE_COOKIE}=[^;\\s]*`, 'gu');
/** Blanks the service session cookie wherever a network event shows it: request headers (`Cookie`, raw header text)
 * and cookie lists (`associatedCookies`). Changes `value` in place; every client gets the same event. */
function hideServiceCookie(value: unknown): unknown {
  if (typeof value === 'string') return value.includes(SERVICE_COOKIE) ? value.replace(SERVICE_COOKIE_VALUE, `${SERVICE_COOKIE}=`) : value;
  if (Array.isArray(value)) { for (let index = 0; index < value.length; index++) value[index] = hideServiceCookie(value[index]); return value; }
  if (typeof value === 'object' && value !== null) {
    const named = 'name' in value && value.name === SERVICE_COOKIE;
    for (const [key, entry] of Object.entries(value)) Reflect.set(value, key, named && key === 'value' ? '' : hideServiceCookie(entry));
  }
  return value;
}

/** One browser connection shared by several CDP clients (agent tools and scripts). The upstream allows one connection,
 * so each client gets its own virtual browser on it: its own sessions, contexts and auto-attach, and only its own
 * sessions' events. Requires an upstream with target discovery on (`open`). */
export class CdpBrowserShim {
  private constructor(private readonly upstream: BrowserChannel, private readonly options: CdpShimOptions) {}

  static async open(upstream: BrowserChannel, options: CdpShimOptions = {}): Promise<CdpBrowserShim> {
    await upstream.send('Target.setDiscoverTargets', { discover: true });
    return new CdpBrowserShim(upstream, options);
  }

  /** A client that receives its events through `emit`; `options` override the shim's (another cursor label). */
  client(emit: (event: CdpEvent) => void, options: CdpShimOptions = {}): CdpShimClient {
    return new CdpShimClient(this.upstream, emit, { ...this.options, ...options });
  }
}

export class CdpShimClient {
  /** Each session this client owns, with the page it attached (null for a page's frames and workers). */
  private readonly sessions = new Map<string, string | null>();
  private readonly contexts = new Set<string>();
  /** Attaches in flight by target, so the creation reply and the creation event never attach one page twice. */
  private readonly attaching = new Map<string, Promise<string>>();
  /** What Playwright's `newCDPSession` makes: a browser-level session of this client's own, and on it, per page, an
   * alias of the client's session on that page (`aliases`: alias → that session and the browser session it is on). A
   * page has one session per client (your Chrome gives a tab exactly one), so a second CDP session on a page is an
   * alias: its commands go through the page's session, and it gets no events of its own. */
  private readonly browserSessions = new Set<string>();
  private readonly aliases = new Map<string, { session: string; browser: string }>();
  private autoAttach = false;
  private discover = false;
  private closed = false;
  /** The page each of this client's sessions works on, its frames' and workers' sessions included, for `held`. */
  private readonly pages = new Map<string, string>();
  private readonly unsubscribe: () => void;

  constructor(private readonly upstream: BrowserChannel, private readonly emit: (event: CdpEvent) => void, private readonly options: CdpShimOptions) {
    this.unsubscribe = upstream.subscribe(event => { void this.route(event).catch(() => {}); });
  }

  private async route({ method, params = {}, sessionId }: { method?: string; params?: Params; sessionId?: string }): Promise<void> {
    if (this.closed || !method) return;
    if (method.startsWith('Network.') || method.startsWith('Fetch.')) hideServiceCookie(params);
    if (method === 'disconnected') { this.emit({ method }); return; }
    if (sessionId) {
      if (!this.sessions.has(sessionId)) return;
      const page = this.pages.get(sessionId);
      // A page's frames and workers attach under its session; they belong to the same client.
      if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') { this.sessions.set(params.sessionId, null); if (page !== undefined) this.pages.set(params.sessionId, page); }
      if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') this.forget(params.sessionId);
      // What happens on a tab you hold is yours: only detaches reach the client.
      else if (page !== undefined && this.options.hold?.holds(page)) return;
      this.emit({ method, params, sessionId });
      return;
    }
    // Top-level attaches are announced per client from its own attaches; the upstream's are everyone's.
    if (method === 'Target.attachedToTarget') return;
    if (method === 'Target.detachedFromTarget') {
      if (typeof params.sessionId === 'string' && this.sessions.has(params.sessionId)) { this.forget(params.sessionId); this.emit({ method, params }); }
      return;
    }
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged' || method === 'Target.targetDestroyed') {
      if (this.discover) this.emit({ method, params });
      const info = params.targetInfo;
      if (method === 'Target.targetCreated' && this.autoAttach && isPage(info)) await this.attachOnce(info);
      return;
    }
    this.emit({ method, params });
  }

  private attachOnce(info: Params & { targetId: string }): Promise<string> {
    const owned = [...this.sessions].find(([, targetId]) => targetId === info.targetId)?.[0];
    if (owned) return Promise.resolve(owned);
    let pending = this.attaching.get(info.targetId);
    if (!pending) {
      pending = this.attach(info).finally(() => this.attaching.delete(info.targetId));
      this.attaching.set(info.targetId, pending);
    }
    return pending;
  }

  /** Attaches this client to a page and announces it, as Chrome announces an auto-attached target. */
  private async attach(info: Params & { targetId: string }): Promise<string> {
    const { sessionId } = sessionOf(await this.upstream.send('Target.attachToTarget', { targetId: info.targetId, flatten: true }));
    if (this.closed) { void this.upstream.send('Target.detachFromTarget', { sessionId }).catch(() => {}); return sessionId; }
    this.sessions.set(sessionId, info.targetId);
    this.pages.set(sessionId, info.targetId);
    this.emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false } });
    if (this.options.cursor) {
      // Installed for every later document and drawn on the current one; a page that refuses it just shows no cursor.
      void this.upstream.send('Page.addScriptToEvaluateOnNewDocument', { source: GHOST_CURSOR_SOURCE }, sessionId).catch(() => {});
      void this.upstream.send('Runtime.evaluate', { expression: GHOST_CURSOR_SOURCE }, sessionId).catch(() => {});
    }
    return sessionId;
  }

  /** A session's detach: it and the aliases of it go, and each alias's browser session hears so. */
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.pages.delete(sessionId);
    for (const [alias, { session, browser }] of this.aliases) if (session === sessionId) {
      this.aliases.delete(alias);
      this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: alias }, sessionId: browser });
    }
  }

  private async target(targetId: unknown): Promise<Params & { targetId: string }> {
    if (typeof targetId !== 'string') throw new Error('Target.attachToTarget needs a targetId');
    const info = targetsOf(await this.upstream.send('Target.getTargets', {})).find(target => target.targetId === targetId);
    if (!info) throw new Error(`No target ${targetId}`);
    return info;
  }

  /** A browser session of this client's own: it only attaches to pages (as aliases) and detaches them. */
  private async onBrowserSession(method: string, params: Params, browser: string): Promise<unknown> {
    if (method === 'Target.attachToTarget') {
      const session = await this.attachOnce(await this.target(params.targetId));
      const alias = `${session}.${crypto.randomUUID()}`;
      this.aliases.set(alias, { session, browser });
      return { sessionId: alias };
    }
    if (method === 'Target.detachFromTarget' && typeof params.sessionId === 'string' && this.aliases.get(params.sessionId)?.browser === browser) {
      this.aliases.delete(params.sessionId);
      return {};
    }
    throw new Error(`${method} is not available on a browser session`);
  }

  async send(method: string, params: Params = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) throw new Error('Browser client closed');
    const session = sessionId === undefined ? undefined : this.aliases.get(sessionId)?.session ?? sessionId;
    // The tab a command reaches: its session's page, or the target a browser-level command names.
    const page = session !== undefined && !this.browserSessions.has(session) ? this.pages.get(session) : typeof params.targetId === 'string' ? params.targetId : undefined;
    if (page !== undefined && this.options.hold?.holds(page)) throw new Error(this.options.hold.refuse(page));
    if (sessionId && this.browserSessions.has(sessionId)) return this.onBrowserSession(method, params, sessionId);
    const refused = REFUSED_COMMANDS[method];
    const refusal = refused ? `${method} ${refused} and is not allowed` : this.options.policy?.(method, params, session) ?? null;
    if (refusal) throw new Error(refusal);
    if ((method === 'Page.navigate' || method === 'Target.createTarget') && typeof params.url === 'string') await this.options.navigating?.(params.url);
    if (session) {
      if (!this.sessions.has(session)) throw new Error(`Session ${session} does not belong to this client`);
      const result = await this.upstream.send(method, params, session);
      if (this.options.cursor) this.drawCursor(method, params, session);
      return result;
    }
    switch (method) {
      case 'Target.setDiscoverTargets': {
        this.discover = params.discover === true;
        // Chrome reports every existing target when discovery starts.
        if (this.discover) for (const targetInfo of targetsOf(await this.upstream.send('Target.getTargets', {}))) this.emit({ method: 'Target.targetCreated', params: { targetInfo } });
        return {};
      }
      case 'Target.setAutoAttach': {
        this.autoAttach = params.autoAttach === true;
        // Attached by this client, not by anyone: other clients' attachments share the connection.
        const attached = new Set(this.sessions.values());
        if (this.autoAttach) for (const info of targetsOf(await this.upstream.send('Target.getTargets', {}))) if (isPage(info) && !attached.has(info.targetId) && !this.options.hold?.holds(info.targetId)) await this.attachOnce(info);
        return {};
      }
      case 'Target.attachToTarget': return { sessionId: await this.attachOnce(await this.target(params.targetId)) };
      case 'Target.attachToBrowserTarget': {
        const sessionId = `browser.${crypto.randomUUID()}`;
        this.browserSessions.add(sessionId);
        return { sessionId };
      }
      case 'Target.detachFromTarget': {
        const id = params.sessionId;
        if (typeof id !== 'string' || !this.sessions.has(id)) throw new Error('Session does not belong to this client');
        this.forget(id);
        await this.upstream.send(method, { sessionId: id });
        this.emit({ method: 'Target.detachedFromTarget', params: { sessionId: id } });
        return {};
      }
      case 'Target.createBrowserContext': {
        const result = await this.upstream.send(method, params);
        if (result && typeof result === 'object' && 'browserContextId' in result && typeof result.browserContextId === 'string') this.contexts.add(result.browserContextId);
        return result;
      }
      case 'Target.disposeBrowserContext': {
        if (typeof params.browserContextId !== 'string' || !this.contexts.delete(params.browserContextId)) throw new Error('Browser context does not belong to this client');
        return this.upstream.send(method, params);
      }
      // Chrome announces an auto-attached page before it answers its creation; Playwright depends on that order. Each
      // page gets its own window, where it is the front tab: headless Chrome does not draw a tab behind another, and
      // under Playwright's focus emulation such a page gets an animation frame about once a second, so each action
      // waited 1–2 s for its element to hold still. On your Chrome the relay opens the tab in the group and ignores this.
      case 'Target.createTarget': {
        const result = await this.upstream.send(method, { ...params, newWindow: true });
        const targetId = result && typeof result === 'object' && 'targetId' in result && typeof result.targetId === 'string' ? result.targetId : null;
        const info = targetId && this.autoAttach ? targetsOf(await this.upstream.send('Target.getTargets', {})).find(target => target.targetId === targetId) : undefined;
        if (info) await this.attachOnce(info);
        return result;
      }
      // A client ends its own view; the shared browser stays open for the others.
      case 'Browser.close': await this.close(); return {};
      default: return this.upstream.send(method, params);
    }
  }

  private drawCursor(method: string, params: Params, sessionId: string): void {
    const label = JSON.stringify(this.options.cursor?.label ?? 'Agent');
    let call: string | null = null;
    if (method === 'Input.dispatchMouseEvent' && typeof params.x === 'number' && typeof params.y === 'number') call = `window.__gitspaceCursor?.move(${params.x},${params.y},${JSON.stringify(params.type)},${label})`;
    if (method === 'Input.insertText' || (method === 'Input.dispatchKeyEvent' && params.type === 'keyDown')) call = `window.__gitspaceCursor?.typing(${label})`;
    // The overlay installs itself first where the document lacks it: your Chrome refuses a script's scripts for new
    // documents, so after a navigation only this puts the cursor back.
    if (call) void this.upstream.send('Runtime.evaluate', { expression: `${GHOST_CURSOR_SOURCE}\n${call}` }, sessionId).catch(() => {});
  }

  /** Detaches this client's sessions and disposes the contexts it made; pages in shared contexts stay. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    await Promise.allSettled([
      ...[...this.sessions.keys()].map(sessionId => this.upstream.send('Target.detachFromTarget', { sessionId })),
      ...[...this.contexts].map(browserContextId => this.upstream.send('Target.disposeBrowserContext', { browserContextId })),
    ]);
    this.sessions.clear();
    this.contexts.clear();
    this.aliases.clear();
    this.browserSessions.clear();
  }
}

function isPage(info: unknown): info is Params & { targetId: string } {
  return !!info && typeof info === 'object' && 'type' in info && info.type === 'page' && 'targetId' in info && typeof info.targetId === 'string';
}
function sessionOf(result: unknown): { sessionId: string } {
  if (!result || typeof result !== 'object' || !('sessionId' in result) || typeof result.sessionId !== 'string') throw new Error('Target.attachToTarget returned no session');
  return { sessionId: result.sessionId };
}
function targetsOf(result: unknown): (Params & { targetId: string })[] {
  if (!result || typeof result !== 'object' || !('targetInfos' in result) || !Array.isArray(result.targetInfos)) return [];
  return result.targetInfos.filter((info): info is Params & { targetId: string } => !!info && typeof info === 'object' && typeof info.targetId === 'string');
}

const CdpRequest = z.object({ id: z.number().int(), method: z.string().min(1).max(256), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().max(256).optional() });

/** A CDP WebSocket served by one client of `shim`, as a script's Playwright connects to it: each command goes to the
 * client, and its replies and events come back. `closed` runs when the socket closes, as the client lets go of its
 * sessions. Returns the server end and the upgrade response. */
export function serveCdpSocket(shim: CdpBrowserShim, options: CdpShimOptions, closed: () => void): { socket: WebSocket; response: Response } {
  const [client, server] = Object.values(new WebSocketPair());
  server.accept();
  const view = shim.client(event => { if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify(event)); }, options);
  server.addEventListener('message', event => {
    void (async () => {
      const message = CdpRequest.parse(JSON.parse(typeof event.data === 'string' ? event.data : ''));
      // A reply to a connection that closed meanwhile (its run ended) goes nowhere.
      let reply: Record<string, unknown>;
      try { reply = { result: await view.send(message.method, message.params ?? {}, message.sessionId) }; }
      catch (error) { reply = { error: { code: -32000, message: error instanceof Error ? error.message : String(error) } }; }
      if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), ...reply }));
    })().catch(() => server.close(1008, 'Invalid CDP message'));
  });
  server.addEventListener('close', () => { void view.close(); closed(); });
  return { socket: server, response: new Response(null, { status: 101, webSocket: client }) };
}

/** The ghost cursor: an overlay in a closed shadow root that ignores the pointer and is hidden from accessibility, so it
 * never changes the page or what an agent reads. It eases to each point, pulses on press, shows typing, and fades after
 * five idle seconds. */
export const GHOST_CURSOR_SOURCE = `(() => {
  if (window.__gitspaceCursor) return;
  let host, root, pointer, tag, hide;
  const ensure = () => {
    if (host && host.isConnected) return true;
    if (!document.documentElement) return false;
    host = document.createElement('gitspace-cursor');
    host.setAttribute('aria-hidden', 'true');
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;pointer-events:none';
    root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = '<style>.c{position:fixed;left:0;top:0;transition:transform 160ms cubic-bezier(.2,.8,.2,1),opacity 300ms;opacity:0;pointer-events:none}.c.on{opacity:1}.a{transition:transform 140ms ease-out;transform-origin:3px 3px}.p .a{transform:scale(.82)}.t{position:absolute;left:18px;top:18px;font:600 11px/1 system-ui,sans-serif;color:#fff;background:#3b6cf6;border-radius:9px;padding:3px 7px;white-space:nowrap}.k .t:after{content:" typing…"}</style><div class="c"><svg class="a" width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l15 8-6.5 1.6L9 18z" fill="#3b6cf6" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg><span class="t"></span></div>';
    pointer = root.querySelector('.c');
    tag = root.querySelector('.t');
    document.documentElement.appendChild(host);
    return true;
  };
  const show = (label) => {
    if (!ensure()) return;
    tag.textContent = label;
    pointer.classList.add('on');
    clearTimeout(hide);
    hide = setTimeout(() => pointer.classList.remove('on', 'k'), 5000);
  };
  window.__gitspaceCursor = {
    move(x, y, type, label) {
      show(label);
      pointer.style.transform = 'translate(' + x + 'px,' + y + 'px)';
      if (type === 'mousePressed') pointer.classList.add('p');
      if (type === 'mouseReleased') setTimeout(() => pointer.classList.remove('p'), 140);
    },
    typing(label) { show(label); pointer.classList.add('k'); },
  };
})();`;
