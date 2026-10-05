import { mkdir, rm, readFile, writeFile, chmod, lstat, readdir } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { BrowserRelayStatus } from '@gitspace/protocol';
import { canonicalJson, type RuntimeBrowserArguments, type RuntimeBrowserSignedGrant, type RuntimeBrowserAuthorization } from '@gitspace/protocol-runtime';
import { ExecutorEffectUncertain, type RuntimeBrowserRelay, type RuntimeBrowserRelayChannel } from '@gitspace/runtime-machine';
import { browserRelayExtension, browserRelayPopup, relayCommandAllowed } from './browser-relay-extension.js';

interface BrowserRelaySupervisorOptions { environmentRoot: string; machineId: string; privateRoot?: string; enabled: boolean; port?: number; onError?: (error: unknown) => void }
interface RelaySocketState { nonce: string; verifying: boolean; authenticated: boolean; timer?: NodeJS.Timeout }
type RelaySocket = Bun.ServerWebSocket<RelaySocketState>;
interface Channel { grant: RuntimeBrowserSignedGrant; targetId: string; sessionId: string; listeners: Set<(message: unknown) => void> }

/** Paired transport forwards signed authority; the extension independently admits every browser effect. */
export class BrowserRelaySupervisor implements RuntimeBrowserRelay {
  readonly extensionPath: string;
  readonly endpoint: string;
  readonly chromeExtensionPath: string;
  private server: Bun.Server<RelaySocketState> | null = null;
  private extension: RelaySocket | null = null;
  private pairingCode: string | null = null;
  private candidate: RelaySocket | null = null;
  private upgrading = false;
  private pairedPublicKey: string | null = null;
  private pairingWrite: Promise<void> | null = null;
  private readonly privateRoot: string;
  private readonly authorizations = new Map<string, RuntimeBrowserAuthorization>();
  private browserProduct: string | null = null;
  private readonly channels = new Map<string, Channel>();
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private sequence = 0;
  private lastError: string | null = null;
  constructor(private readonly options: BrowserRelaySupervisorOptions) {
    this.privateRoot = resolve(options.privateRoot ?? join(homedir(), '.gitspace-browser-relay', createHash('sha256').update(options.machineId).digest('hex')));
    const inside = relative(resolve(options.environmentRoot), this.privateRoot);
    if (!inside || (!inside.startsWith('..') && !inside.startsWith('/'))) throw new Error('Browser relay storage must be outside the environment root');
    this.extensionPath = join(this.privateRoot, 'extension');
    const distro = process.env.WSL_DISTRO_NAME?.trim();
    this.chromeExtensionPath = distro ? `\\\\wsl.localhost\\${distro}${this.extensionPath.replaceAll('/', '\\')}` : this.extensionPath;
    this.endpoint = `http://127.0.0.1:${options.port ?? 9_224}`;
  }
  async status(): Promise<BrowserRelayStatus & { connected: boolean }> {
    const installed = await Bun.file(join(this.extensionPath, 'manifest.json')).exists();
    const connected = this.extension !== null && this.browserProduct !== null;
    const state = this.lastError ? 'error' : connected ? 'connected' : this.server ? 'waiting' : 'stopped';
    const [browserName, browserVersion] = this.browserProduct?.split('/') ?? [];
    return { state, connected, installed, owned: this.server !== null, machineId: this.options.machineId, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint,
      pairingCode: connected ? null : this.pairingCode, browserName: browserName ?? null, browserVersion: browserVersion ?? null,
      pairedKeyFingerprint: this.pairedPublicKey ? createHash('sha256').update(Buffer.from(this.pairedPublicKey, 'base64')).digest('hex') : null,
      message: !this.options.enabled ? 'Browser relay requires a user-owned physical machine.' : state === 'waiting' ? this.pairedPublicKey ? 'Waiting for the paired browser extension to reconnect.' : 'Copy pairing details from GitSpace into the Browser Relay extension popup.' : this.lastError };
  }
  private files(): Record<string, string> {
    return {
      'background.js': browserRelayExtension(this.endpoint),
      'popup.js': browserRelayPopup(),
      'popup.html': '<!doctype html><html><body><p>Extension public key fingerprint (SHA-256)</p><code id="fingerprint" style="display:block;overflow-wrap:anywhere">Loading identity…</code><form id="pair"><label>Pairing details from GitSpace <input id="code" autocomplete="off" required></label><button>Pair</button></form><button id="reset" type="button">Reset identity</button><p id="status" role="status"></p><script src="popup.js"></script></body></html>',
      'manifest.json': JSON.stringify({ manifest_version: 3, name: 'GitSpace Browser Relay', version: '4.0.0', minimum_chrome_version: '124', permissions: ['debugger', 'tabs', 'tabGroups', 'alarms', 'storage'], host_permissions: [`${this.endpoint}/*`], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html' } }, null, 2),
    };
  }
  private async verifyInstallation(): Promise<void> {
    for (const directory of [this.privateRoot, this.extensionPath]) if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new Error('Unsafe relay installation directory');
    const files = this.files();
    if (canonicalJson((await readdir(this.extensionPath)).sort()) !== canonicalJson(Object.keys(files).sort())) throw new Error('Browser relay installation changed; run setup to reinstall');
    for (const [name, expected] of Object.entries(files)) {
      const path = join(this.extensionPath, name);
      if (!(await lstat(path)).isFile() || (await lstat(path)).isSymbolicLink()
        || createHash('sha256').update(await readFile(path)).digest('hex') !== createHash('sha256').update(expected).digest('hex')) throw new Error('Browser relay installation changed; run setup to reinstall');
    }
  }
  async setup(): Promise<BrowserRelayStatus> {
    if (!this.options.enabled) throw new Error('Browser relay requires a user-owned physical machine');
    await this.stop();
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.privateRoot)).isSymbolicLink()) throw new Error('Unsafe relay storage');
    await chmod(this.privateRoot, 0o700);
    await rm(this.extensionPath, { recursive: true, force: true });
    await mkdir(this.extensionPath, { mode: 0o700 });
    for (const [name, content] of Object.entries(this.files())) await writeFile(join(this.extensionPath, name), content, { mode: 0o600 });
    return this.start();
  }
  async start(): Promise<BrowserRelayStatus> {
    if (!this.options.enabled) throw new Error('Browser relay requires a user-owned physical machine');
    if (this.server) return this.status();
    await this.verifyInstallation();
    try {
      const path = join(this.privateRoot, 'pairing-public-key');
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) throw new Error('Unsafe relay pairing record');
      this.pairedPublicKey = await readFile(path, 'utf8');
      await crypto.subtle.importKey('raw', Uint8Array.from(Buffer.from(this.pairedPublicKey, 'base64')), 'Ed25519', false, ['verify']);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; this.pairedPublicKey = null; }
    this.pairingCode = this.pairedPublicKey ? null : crypto.randomUUID() + crypto.randomUUID();
    this.lastError = null;
    this.server = Bun.serve<RelaySocketState>({ hostname: '127.0.0.1', port: Number(new URL(this.endpoint).port),
      fetch: async (request, server) => {
        const url = new URL(request.url);
        if (url.host !== new URL(this.endpoint).host || url.pathname !== '/extension') return new Response('Forbidden', { status: 403 });
        const origin = request.headers.get('origin');
        if (!origin || !/^chrome-extension:\/\/[a-p]{32}$/.test(origin) || url.search) return new Response('Forbidden', { status: 403 });
        if (this.extension || this.candidate || this.upgrading) return new Response('Already paired or pairing', { status: 409 });
        this.upgrading = true;
        try {
          await this.verifyInstallation();
          if (this.server !== server) return new Response('Relay stopped', { status: 409 });
          return server.upgrade(request, { data: { nonce: Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join(''), verifying: false, authenticated: false } }) ? undefined : new Response('WebSocket required', { status: 400 });
        } catch (error) {
          this.lastError = error instanceof Error ? error.message : String(error);
          this.options.onError?.(error);
          return new Response('Relay installation unavailable', { status: 403 });
        } finally { this.upgrading = false; }
      }, websocket: {
        open: socket => {
          if (this.extension || this.candidate) { socket.close(1008, 'Pairing occupied'); return; }
          this.candidate = socket;
          socket.data.timer = setTimeout(() => socket.close(1008, 'Pairing or hello timed out'), 5000);
          socket.send(JSON.stringify({ pairing: 'challenge', serverNonce: socket.data.nonce }));
        },
        message: async (socket, raw) => {
          try {
            if (raw.length > 2_000_000) throw new Error('Relay frame exceeds limit');
            const message = JSON.parse(String(raw));
            if (!socket.data.authenticated) {
              if (socket !== this.candidate || socket.data.verifying || message.pairing !== 'client' || typeof message.clientNonce !== 'string' || !/^[a-f0-9]{64}$/.test(message.clientNonce) || typeof message.proof !== 'string' || typeof message.publicKey !== 'string') throw new Error('Invalid pairing proof');
              socket.data.verifying = true;
              if (this.pairedPublicKey ? message.publicKey !== this.pairedPublicKey : !this.pairingCode || message.code !== this.pairingCode) throw new Error('Invalid pairing identity');
              const key = await crypto.subtle.importKey('raw', Uint8Array.from(Buffer.from(message.publicKey, 'base64')), 'Ed25519', false, ['verify']);
              if (!await crypto.subtle.verify('Ed25519', key, Uint8Array.from(Buffer.from(message.proof, 'base64')), new TextEncoder().encode(`gitspace-browser-relay-v2:client:${socket.data.nonce}:${message.clientNonce}`))) throw new Error('Invalid pairing signature');
              if (socket !== this.candidate || this.extension || socket.readyState !== 1) throw new Error('Pairing no longer available');
              if (!this.pairedPublicKey) {
                const write = writeFile(join(this.privateRoot, 'pairing-public-key'), message.publicKey, { mode: 0o600, flag: 'wx' });
                this.pairingWrite = write;
                try { await write; } finally { if (this.pairingWrite === write) this.pairingWrite = null; }
                this.pairedPublicKey = message.publicKey;
                this.pairingCode = null;
              }
              if (socket !== this.candidate || socket.readyState !== 1) throw new Error('Pairing no longer available');
              socket.data.authenticated = true; this.extension = socket;
              socket.send(JSON.stringify({ pairing: 'server' }));
              return;
            }
            if (socket !== this.extension || message.pairing) throw new Error('Invalid authenticated connection');
            if (message.hello && typeof message.Browser === 'string' && message.Browser.trim()) { clearTimeout(socket.data.timer); this.candidate = null; this.browserProduct = message.Browser.slice(0, 100); socket.send(JSON.stringify({ ready: true })); return; }
            if (!this.browserProduct) throw new Error('Relay hello required');
            if (typeof message.id === 'number') {
              const pending = this.pending.get(message.id); if (!pending) return;
              clearTimeout(pending.timer); this.pending.delete(message.id);
              if (message.error) pending.reject(new Error(String(message.error.message).slice(0, 500))); else pending.resolve(message.result);
            } else if (typeof message.targetId === 'string') {
              const channel = this.channels.get(message.targetId); if (!channel) return;
              if (message.fenced) { this.channels.delete(message.targetId); for (const listener of channel.listeners) listener({ method: 'Inspector.detached', params: { reason: 'Target left workspace scope' } }); return; }
              if (message.sessionId !== channel.sessionId || !['Page.frameNavigated', 'Page.loadEventFired', 'DOM.documentUpdated', 'Inspector.detached'].includes(message.method)) return;
              for (const listener of channel.listeners) listener({ method: message.method, params: message.params, sessionId: message.sessionId });
            }
          } catch (error) { this.options.onError?.(error); socket.close(1008, 'Invalid relay message'); }
        },
        close: socket => { clearTimeout(socket.data.timer); if (socket === this.candidate) this.candidate = null; if (socket === this.extension) { this.extension = null; this.browserProduct = null; this.disconnect(); } },
      } });
    return this.status();
  }
  private disconnect(): void {
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ExecutorEffectUncertain('Browser extension disconnected after dispatch')); }
    this.pending.clear();
    for (const channel of this.channels.values()) for (const listener of channel.listeners) listener({ method: 'Inspector.detached', params: { reason: 'Relay disconnected' } });
    this.channels.clear(); this.authorizations.clear();
  }
  private request(command: Record<string, unknown>): Promise<unknown> {
    if (!this.extension || !this.browserProduct) return Promise.reject(new Error('Browser extension is not paired'));
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.pending.delete(id); reject(new ExecutorEffectUncertain('Browser command timed out after dispatch; outcome uncertain')); }, 30_000);
    this.pending.set(id, { resolve, reject, timer });
    try { this.extension.send(JSON.stringify({ ...command, id })); }
    catch (error) { clearTimeout(timer); this.pending.delete(id); reject(new ExecutorEffectUncertain('Browser command transport failed after dispatch', { cause: error })); }
    return promise;
  }
  async authorize(authorization: RuntimeBrowserAuthorization, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.request({ operation: 'authorize', authorization });
    signal.throwIfAborted();
    for (const [id, entry] of this.authorizations) if (Date.parse(entry.body.expiresAt) <= Date.now()) this.authorizations.delete(id);
    const command = authorization.body.command;
    if (command.type === 'execute') this.authorizations.set(command.grant.body.groupId, authorization);
  }
  async tabs(groupId: string, signal: AbortSignal): Promise<Array<{ targetId: string; title: string; url: string }>> {
    signal.throwIfAborted();
    const result = await this.request({ operation: 'tabs', groupId });
    signal.throwIfAborted();
    if (!Array.isArray(result) || result.length > 500) throw new Error('Invalid relay tabs');
    return result.map(tab => {
      if (!tab || typeof tab.targetId !== 'string' || typeof tab.title !== 'string' || typeof tab.url !== 'string') throw new Error('Invalid relay tab metadata');
      return { targetId: tab.targetId, title: tab.title.slice(0, 500), url: tab.url };
    });
  }
  async prepare(_args: RuntimeBrowserArguments, groupId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    await this.request({ operation: 'prepare', groupId });
    signal.throwIfAborted();
  }
  async open(grant: RuntimeBrowserSignedGrant, args: RuntimeBrowserArguments, signal: AbortSignal): Promise<RuntimeBrowserRelayChannel & { targetId: string }> {
    signal.throwIfAborted();
    const body = grant.body;
    if (Date.parse(body.expiresAt) <= Date.now() || body.source !== 'relay') throw new Error('Invalid relay grant');
    const authorization = this.authorizations.get(body.groupId);
    if (!authorization || Date.parse(authorization.body.expiresAt) <= Date.now() || authorization.body.command.type !== 'execute' || canonicalJson(authorization.body.command.grant) !== canonicalJson(grant) || canonicalJson(authorization.body.command.args) !== canonicalJson(args)) throw new Error('Relay group operation was not authorized');
    const result = await this.request({ operation: 'open', grant });
    if (!result || typeof result !== 'object' || !('targetId' in result) || typeof result.targetId !== 'string' || !('sessionId' in result) || typeof result.sessionId !== 'string') throw new Error('Invalid relay attachment');
    if ('targetId' in args && args.targetId && result.targetId !== args.targetId) throw new Error('Relay returned a different target');
    const previous = this.channels.get(result.targetId);
    const channel: Channel = previous ?? { grant, targetId: result.targetId, sessionId: result.sessionId, listeners: new Set() };
    channel.grant = grant;
    channel.sessionId = result.sessionId;
    this.channels.set(result.targetId, channel);
    return {
      targetId: channel.targetId,
      send: async (method, params = {}, sessionId) => {
        if (this.channels.get(channel.targetId) !== channel || Date.parse(channel.grant.body.expiresAt) <= Date.now()) throw new Error('Browser channel expired or revoked');
        if (!relayCommandAllowed(channel.grant.body, channel.targetId, channel.sessionId, method, params, sessionId)) throw new Error('Command outside workspace grant');
        return this.request({ operation: 'command', targetId: channel.targetId, method, params, sessionId: channel.sessionId });
      },
      subscribe: listener => { channel.listeners.add(listener); return () => { channel.listeners.delete(listener); }; },
      close: async () => { channel.listeners.clear(); },
    };
  }
  async revoke(groupId: string): Promise<void> {
    for (const [id, channel] of this.channels) if (channel.grant.body.groupId === groupId) this.channels.delete(id);
    this.authorizations.delete(groupId);
    if (this.extension) await this.request({ operation: 'revoke', groupId });
  }
  async unpair(): Promise<BrowserRelayStatus> {
    if (!this.options.enabled) throw new Error('Browser relay requires a user-owned physical machine');
    const write = this.pairingWrite;
    await this.stop();
    await write?.catch(() => {});
    await rm(join(this.privateRoot, 'pairing-public-key'), { force: true });
    this.pairedPublicKey = null;
    return this.start();
  }
  async stop(): Promise<BrowserRelayStatus> { const server = this.server; this.server = null; this.candidate?.close(); this.candidate = null; this.extension = null; this.browserProduct = null; this.pairingCode = null; this.disconnect(); await server?.stop(true); return this.status(); }
  async test(): Promise<BrowserRelayStatus> { const status = await this.status(); if (!status.connected) throw new Error('Browser extension is not paired'); return status; }
}
