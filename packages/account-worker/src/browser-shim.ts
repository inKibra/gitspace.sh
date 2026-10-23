import { z } from 'zod';
import type { BrowserChannel } from './browser-cdp.js';

type Params = Record<string, unknown>;
export interface CdpEvent { method: string; params?: Params; sessionId?: string }
/** Null allows a command; a string refuses it with that reason. Applies to every client command, scripts included. */
export type CdpPolicy = (method: string, params: Params, sessionId: string | undefined) => string | null;
export interface CdpShimOptions {
  policy?: CdpPolicy;
  /** Draws the ghost cursor on this client's pages, labeled with who acts (docs/APERTURE-DESIGN.md §6.4). */
  cursor?: { label: string };
}

/** Whole-browser cookie and cache commands; refused for every client, as Playwriter does even for trusted agents. */
export const WHOLE_BROWSER_COMMANDS: Readonly<Record<string, true>> = { 'Network.getAllCookies': true, 'Network.clearBrowserCookies': true, 'Network.clearBrowserCache': true, 'Storage.getCookies': true, 'Storage.setCookies': true, 'Storage.clearCookies': true, 'Storage.clearDataForOrigin': true, 'Storage.clearDataForStorageKey': true };

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
  private autoAttach = false;
  private discover = false;
  private closed = false;
  private readonly unsubscribe: () => void;

  constructor(private readonly upstream: BrowserChannel, private readonly emit: (event: CdpEvent) => void, private readonly options: CdpShimOptions) {
    this.unsubscribe = upstream.subscribe(event => { void this.route(event).catch(() => {}); });
  }

  private async route({ method, params = {}, sessionId }: { method?: string; params?: Params; sessionId?: string }): Promise<void> {
    if (this.closed || !method) return;
    if (method === 'disconnected') { this.emit({ method }); return; }
    if (sessionId) {
      if (!this.sessions.has(sessionId)) return;
      // A page's frames and workers attach under its session; they belong to the same client.
      if (method === 'Target.attachedToTarget' && typeof params.sessionId === 'string') this.sessions.set(params.sessionId, null);
      if (method === 'Target.detachedFromTarget' && typeof params.sessionId === 'string') this.sessions.delete(params.sessionId);
      this.emit({ method, params, sessionId });
      return;
    }
    // Top-level attaches are announced per client from its own attaches; the upstream's are everyone's.
    if (method === 'Target.attachedToTarget') return;
    if (method === 'Target.detachedFromTarget') {
      if (typeof params.sessionId === 'string' && this.sessions.delete(params.sessionId)) this.emit({ method, params });
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
    this.emit({ method: 'Target.attachedToTarget', params: { sessionId, targetInfo: { ...info, attached: true }, waitingForDebugger: false } });
    if (this.options.cursor) {
      // Installed for every later document and drawn on the current one; a page that refuses it just shows no cursor.
      void this.upstream.send('Page.addScriptToEvaluateOnNewDocument', { source: GHOST_CURSOR_SOURCE }, sessionId).catch(() => {});
      void this.upstream.send('Runtime.evaluate', { expression: GHOST_CURSOR_SOURCE }, sessionId).catch(() => {});
    }
    return sessionId;
  }

  async send(method: string, params: Params = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) throw new Error('Browser client closed');
    const refusal = WHOLE_BROWSER_COMMANDS[method] ? `${method} reaches the whole browser and is not allowed` : this.options.policy?.(method, params, sessionId) ?? null;
    if (refusal) throw new Error(refusal);
    if (sessionId) {
      if (!this.sessions.has(sessionId)) throw new Error(`Session ${sessionId} does not belong to this client`);
      const result = await this.upstream.send(method, params, sessionId);
      if (this.options.cursor) this.drawCursor(method, params, sessionId);
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
        if (this.autoAttach) for (const info of targetsOf(await this.upstream.send('Target.getTargets', {}))) if (isPage(info) && !attached.has(info.targetId)) await this.attachOnce(info);
        return {};
      }
      case 'Target.attachToTarget': {
        if (typeof params.targetId !== 'string') throw new Error('Target.attachToTarget needs a targetId');
        const info = (targetsOf(await this.upstream.send('Target.getTargets', {}))).find(target => target.targetId === params.targetId);
        if (!info) throw new Error(`No target ${params.targetId}`);
        return { sessionId: await this.attachOnce(info) };
      }
      case 'Target.detachFromTarget': {
        const id = params.sessionId;
        if (typeof id !== 'string' || !this.sessions.delete(id)) throw new Error('Session does not belong to this client');
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
      // Chrome announces an auto-attached page before it answers its creation; Playwright depends on that order.
      case 'Target.createTarget': {
        const result = await this.upstream.send(method, params);
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
      try { server.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), result: await view.send(message.method, message.params ?? {}, message.sessionId) })); }
      catch (error) { server.send(JSON.stringify({ id: message.id, ...(message.sessionId ? { sessionId: message.sessionId } : {}), error: { code: -32000, message: error instanceof Error ? error.message : String(error) } })); }
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
