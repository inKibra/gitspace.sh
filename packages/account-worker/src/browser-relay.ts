import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { browserUnbase64, RuntimeBrowserTrustSchema, RuntimeAccountBrowserPairingSchema, RuntimeAccountBrowserRelayStatusSchema, verifyRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserAuthorization, type RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
import { RuntimeProjectBrowserPreferencesSchema, RuntimeProjectBrowserSettingsSchema, RuntimeAccountBrowserGrantSchema, type RuntimeProjectBrowserPreferences } from '@gitspace/protocol-runtime';
import { AccountBrowserRuntime, type AccountBrowserTransport } from './browser-runtime.js';
import type { BrowserChannel } from './browser-cdp.js';
import { browserRelayFiles } from '@gitspace/account-machine/browser-extension';
import { zipSync, strToU8 } from 'fflate';

export function browserRelayArchive(endpoint: string): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(browserRelayFiles(endpoint)).map(([name, content]) => [name, strToU8(content)])));
}
const identity = { pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), trust: RuntimeBrowserTrustSchema };
const Pairing = z.discriminatedUnion('state', [
  z.object({ ...identity, state: z.literal('awaiting-key'), code: z.string(), expiresAt: z.iso.datetime(), publicKey: z.null() }),
  z.object({ ...identity, state: z.literal('pending-confirmation'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
  z.object({ ...identity, state: z.literal('confirmed'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
]);
const Registry = z.object({ pairings: z.array(Pairing) });
const ProjectSettings = z.object({ revision: z.number().int().nonnegative(), defaultPairingId: z.string().uuid().nullable(), approvals: z.array(RuntimeProjectBrowserPreferencesSchema.shape.approvals.element.extend({ generation: z.number().int().nonnegative(), approvalId: z.string().uuid() })) });
const Proof = z.object({ pairing: z.literal('client'), pairingId: z.string().uuid(), clientNonce: z.string().regex(/^[a-f0-9]{64}$/), publicKey: z.string().max(128), proof: z.string().max(128), code: z.string().max(256).optional() });
const Reply = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), targetId: z.string().optional(), sessionId: z.string().optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), fenced: z.boolean().optional(), hello: z.boolean().optional(), Browser: z.string().optional() });
type Connection = { socket: WebSocket; product?: string; sequence: number; pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; cancelTimer(): void }>; listeners: Map<string, Set<Parameters<BrowserChannel['subscribe']>[0]>>; authorized: Set<string> };
function equalSecret(left: string, right: string) { const a = new TextEncoder().encode(left), b = new TextEncoder().encode(right); return a.length === b.length && timingSafeEqual(a, b); }
async function fingerprint(publicKey: string) { return [...new Uint8Array(await crypto.subtle.digest('SHA-256', browserUnbase64(publicKey)))].map(byte => byte.toString(16).padStart(2, '0')).join(''); }
const AdmissionProof = z.object({ pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), issuedAt: z.number().int(), nonce: z.string().regex(/^[a-f0-9]{64}$/), signature: z.string().max(128) });
const AdmissionWindows = z.object({
  prefixes: z.array(z.object({ prefix: z.string(), start: z.number(), count: z.number() })).max(1024),
  identities: z.array(z.object({ pairingId: z.string(), start: z.number(), nonces: z.array(z.string()).max(8) })).max(32),
});
const RevocationIntent = z.object({ pairingId: z.string().uuid(), groupId: z.string().uuid() });
function admissionPrefix(ip: string): { prefix: string; network: string } | null {
  if (z.ipv4().safeParse(ip).success) return { prefix: `${ip}/32`, network: `${ip.split('.').slice(0, 3).join('.')}.0/24` };
  if (!z.ipv6().safeParse(ip).success) return null;
  const normalized = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left = '', right] = normalized.split('::');
  const first = left ? left.split(':') : [], last = right ? right.split(':') : [];
  const groups = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill('0'), ...last];
  return { prefix: `${groups.slice(0, 4).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/64`, network: `${groups.slice(0, 3).map(group => Number.parseInt(group, 16).toString(16)).join(':')}::/48` };
}
/** Account-owned transport. Each independently confirmed Chrome owns its connection. */
export class AccountBrowserRelay implements AccountBrowserTransport {
  private readonly connections = new Map<string, Connection>();
  private readonly candidates = new Map<WebSocket, { budget: string; network: string | null }>();
  private readonly runtime: AccountBrowserRuntime;
  constructor(private readonly ctx: DurableObjectState, private readonly env: { ACCOUNT_ID: string }) { this.runtime = new AccountBrowserRuntime({ storage: ctx.storage, relay: this }); }
  private async registry() { return Registry.parse(await this.ctx.storage.get('browser.relay.pairings') ?? { pairings: [] }); }
  private async projectPreferences(projectId: string) { return ProjectSettings.parse(await this.ctx.storage.get(`browser.relay.project:${projectId}`) ?? { revision: 0, defaultPairingId: null, approvals: [] }); }
  async projectSettings(projectId: string) {
    const [preferences, registry] = await Promise.all([this.projectPreferences(projectId), this.registry()]);
    return RuntimeProjectBrowserSettingsSchema.parse({ projectId, revision: preferences.revision, defaultPairingId: preferences.defaultPairingId, browsers: registry.pairings.filter(pairing => pairing.state === 'confirmed').map(pairing => {
      const approval = preferences.approvals.find(item => item.pairingId === pairing.pairingId && item.generation === pairing.generation);
      return { pairingId: pairing.pairingId, generation: pairing.generation, name: approval?.name ?? `Chrome ${pairing.pairingId.slice(0, 8)}`, note: approval?.note ?? '', connected: !!this.connections.get(pairing.pairingId)?.product, approved: !!approval };
    }) });
  }
  async setProjectSettings(projectId: string, expectedRevision: number, value: RuntimeProjectBrowserPreferences) {
    const preferences = RuntimeProjectBrowserPreferencesSchema.parse(value);
    const error = await this.ctx.blockConcurrencyWhile(async () => {
      const current = await this.projectPreferences(projectId);
      if (current.revision !== expectedRevision) return 'Project Chrome settings revision conflict';
      const registry = await this.registry();
      const approvals: z.infer<typeof ProjectSettings>['approvals'] = [];
      for (const approval of preferences.approvals) {
        const pairing = registry.pairings.find(item => item.pairingId === approval.pairingId && item.state === 'confirmed');
        if (!pairing) return 'Browser fingerprint confirmation required';
        const prior = current.approvals.find(item => item.pairingId === approval.pairingId && item.generation === pairing.generation);
        approvals.push({ ...approval, generation: pairing.generation, approvalId: prior?.approvalId ?? crypto.randomUUID() });
      }
      const removed = current.approvals.filter(prior => !approvals.some(next => next.pairingId === prior.pairingId && next.generation === prior.generation));
      await this.ctx.storage.transaction(async tx => {
        await tx.put(`browser.relay.project:${projectId}`, { revision: current.revision + 1, defaultPairingId: preferences.defaultPairingId, approvals });
        if (removed.length) for (const stored of (await tx.list({ prefix: 'browser.account.group:' })).values()) {
          const group = RuntimeAccountBrowserGrantSchema.parse(stored), placement = group.placement;
          if (group.projectId === projectId && placement.kind === 'account-relay' && removed.some(item => item.pairingId === placement.pairingId)) {
            await tx.put(`browser.account.revoked:${group.groupId}`, true);
            await tx.put(`browser.relay.revoke:${placement.pairingId}:${group.groupId}`, { pairingId: placement.pairingId, groupId: group.groupId });
          }
        }
      });
      return null;
    });
    if (error) throw new Error(error);
    await this.retryRevocations();
    return this.projectSettings(projectId);
  }
  private async approved(projectId: string, pairingId: string, generation: number) {
    const approval = (await this.projectPreferences(projectId)).approvals.find(item => item.pairingId === pairingId && item.generation === generation);
    if (!approval) throw new Error('Chrome is not approved for this project. Ask the user to approve it in project Settings.');
    return approval;
  }
  private async dispatchApproval(authorization: RuntimeAccountBrowserAuthorization) {
    const { scope, command } = authorization.body, placement = scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    const approval = await this.approved(scope.projectId, placement.pairingId, placement.generation);
    if (placement.approvalId !== approval.approvalId) throw new Error('Project Chrome approval changed; previous browser authority is revoked');
    const groupId = command.type === 'execute' ? command.grant.body.groupId : command.groupId;
    if (groupId && await this.ctx.storage.get(`browser.account.revoked:${groupId}`)) throw new Error('Browser group revoked');
    return approval;
  }
  async pair(trust: RuntimeBrowserTrust, endpoint: string) {
    if (trust.accountId !== this.env.ACCOUNT_ID) throw new Error('Browser pairing account mismatch');
    const result = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry();
      registry.pairings = registry.pairings.filter(item => item.state !== 'awaiting-key' || Date.parse(item.expiresAt) > Date.now());
      if (registry.pairings.length >= 32) return null;
      const pairing = Pairing.parse({ pairingId: crypto.randomUUID(), generation: 1, state: 'awaiting-key', code: crypto.randomUUID() + crypto.randomUUID(), expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), publicKey: null, trust });
      registry.pairings.push(pairing); await this.ctx.storage.put('browser.relay.pairings', registry);
      return RuntimeAccountBrowserPairingSchema.parse({ code: pairing.code, expiresAt: pairing.expiresAt, pairingId: pairing.pairingId, generation: pairing.generation, trust, endpoint });
    });
    if (!result) throw new Error('Browser pairing capacity reached');
    return result;
  }
  async status() {
    const registry = await this.registry();
    return RuntimeAccountBrowserRelayStatusSchema.parse({ pairings: await Promise.all(registry.pairings.map(async pairing => ({ pairingId: pairing.pairingId, generation: pairing.generation, state: pairing.state, expiresAt: pairing.expiresAt, pairedKeyFingerprint: pairing.publicKey ? await fingerprint(pairing.publicKey) : null, connected: !!this.connections.get(pairing.pairingId)?.product, browser: pairing.state === 'confirmed' ? this.connections.get(pairing.pairingId)?.product ?? null : null }))) });
  }
  async confirm(pairingId: string, expectedFingerprint: string) {
    const confirmed = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing || pairing.state === 'awaiting-key' || !equalSecret(await fingerprint(pairing.publicKey), expectedFingerprint)) return false;
      pairing.state = 'confirmed';
      await this.ctx.storage.put('browser.relay.pairings', registry);
      return true;
    });
    if (!confirmed) throw new Error('Browser fingerprint mismatch');
    return this.status();
  }
  async placement(projectId: string, pairingId?: string) {
    const preferences = await this.projectPreferences(projectId);
    const selected = pairingId ?? preferences.defaultPairingId;
    if (!selected) throw new Error('No approved project default Chrome. Ask the user to choose one in project Settings or select an approved pairingId.');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === selected);
    if (!pairing || pairing.state !== 'confirmed') throw new Error('Browser fingerprint confirmation required');
    const approval = await this.approved(projectId, pairing.pairingId, pairing.generation);
    if (!this.connections.get(pairing.pairingId)?.product) throw new Error('Approved Chrome is unavailable: extension is not connected');
    return { kind: 'account-relay' as const, accountId: this.env.ACCOUNT_ID, pairingId: pairing.pairingId, generation: pairing.generation, approvalId: approval.approvalId };
  }
  async unpair(pairingId: string) {
    await this.ctx.blockConcurrencyWhile(async () => { const registry = await this.registry(); registry.pairings = registry.pairings.filter(item => item.pairingId !== pairingId); await this.ctx.storage.put('browser.relay.pairings', registry); this.connections.get(pairingId)?.socket.close(1008, 'Browser unpaired'); this.disconnect(pairingId); });
    return this.status();
  }
  async fetch(request: Request) {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket' || !/^chrome-extension:\/\/[a-p]{32}$/.test(request.headers.get('origin') ?? '') || new URL(request.url).search) return new Response('Forbidden', { status: 403 });
    const address = admissionPrefix(request.headers.get('cf-connecting-ip') ?? '');
    if (!address) return new Response('Client address required', { status: 403 });
    const { prefix, network } = address;
    const protocol = request.headers.get('sec-websocket-protocol');
    let admissionProof: z.infer<typeof AdmissionProof> | undefined;
    if (protocol) {
      try {
        if (protocol.length > 1024 || !/^gitspace-admission\.[A-Za-z0-9_-]+$/.test(protocol)) return new Response('Invalid admission proof', { status: 403 });
        admissionProof = AdmissionProof.parse(JSON.parse(atob(protocol.slice('gitspace-admission.'.length).replaceAll('-', '+').replaceAll('_', '/'))));
      } catch { return new Response('Invalid admission proof', { status: 403 }); }
    }
    const admission = await this.ctx.blockConcurrencyWhile(async () => {
      const now = Date.now(), registry = await this.registry();
      if (!registry.pairings.length) return { status: 403 } as const;
      const stored = AdmissionWindows.optional().parse(await this.ctx.storage.get('browser.relay.admission'));
      const windows = stored ?? { prefixes: [], identities: [] };
      windows.prefixes = windows.prefixes.filter(window => now - window.start < 60_000);
      windows.identities = windows.identities.filter(window => now - window.start < 60_000 && registry.pairings.some(pairing => pairing.pairingId === window.pairingId));
      if (admissionProof) {
        const proof = admissionProof, pairing = registry.pairings.find(item => item.pairingId === proof.pairingId);
        if (!pairing || pairing.state !== 'confirmed' || pairing.generation !== proof.generation || proof.issuedAt > now || now - proof.issuedAt > 30_000) return { status: 403 } as const;
        try {
          const key = await crypto.subtle.importKey('raw', browserUnbase64(pairing.publicKey), 'Ed25519', false, ['verify']);
          if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(proof.signature), new TextEncoder().encode(`gitspace-browser-relay-v2:admission:${proof.pairingId}:${proof.generation}:${proof.issuedAt}:${proof.nonce}`))) return { status: 403 } as const;
        } catch { return { status: 403 } as const; }
        let window = windows.identities.find(item => item.pairingId === pairing.pairingId);
        if (window?.nonces.includes(proof.nonce) || this.connections.has(pairing.pairingId)) return { status: 403 } as const;
        if (window && window.nonces.length >= 8) return { status: 429 } as const;
        if (!window) { window = { pairingId: pairing.pairingId, start: now, nonces: [] }; windows.identities.push(window); }
        window.nonces.push(proof.nonce);
        // Keep every consumed nonce beyond its proof's lifetime, including late-window arrivals.
        window.start = now;
      } else {
        if (!registry.pairings.some(pairing => pairing.state === 'awaiting-key' && Date.parse(pairing.expiresAt) > now)) return { status: 403 } as const;
        const limits = [{ prefix, limit: 8 }, { prefix: network, limit: 32 }];
        if (limits.some(item => (windows.prefixes.find(window => window.prefix === item.prefix)?.count ?? 0) >= item.limit)) return { status: 429 } as const;
        for (const item of limits) {
          let window = windows.prefixes.find(window => window.prefix === item.prefix);
          if (!window) {
            if (windows.prefixes.length >= 1024) {
              // Never evict the aggregate history protecting a live candidate network.
              const active = new Set([...this.candidates.values()].map(candidate => candidate.network));
              const evict = windows.prefixes.findIndex(window => window.prefix !== network && !active.has(window.prefix));
              windows.prefixes.splice(evict, 1);
            }
            window = { prefix: item.prefix, start: now, count: 0 }; windows.prefixes.push(window);
          }
          window.count++;
        }
      }
      await this.ctx.storage.put('browser.relay.admission', windows);
      return { status: 101 } as const;
    });
    if (admission.status !== 101) return new Response('Browser admission rejected', { status: admission.status });
    // Proven identities never compete with the unauthenticated candidate pool.
    const budget = admissionProof ? `identity:${admissionProof.pairingId}` : prefix;
    let pending = 0, aggregate = 0;
    const anonymous = new Map<string, WebSocket[]>();
    for (const [socket, value] of this.candidates) {
      if (value.budget === budget) pending++;
      if (value.network === network) aggregate++;
      if (value.network) { const entries = anonymous.get(value.network) ?? []; entries.push(socket); anonymous.set(value.network, entries); }
    }
    if (pending >= (admissionProof ? 1 : 4) || (!admissionProof && aggregate >= 16)) return new Response('Browser candidate capacity reached', { status: 429 });
    if (!admissionProof && [...anonymous.values()].reduce((total, entries) => total + entries.length, 0) >= 128) {
      // Bounded memory without letting existing anonymous networks exclude a new one.
      let largest: WebSocket[] = [];
      for (const entries of anonymous.values()) if (entries.length > largest.length) largest = entries;
      const oldest = largest[0];
      if (oldest) { this.candidates.delete(oldest); oldest.close(1008, 'Browser candidate replaced'); }
    }
    const pair = new WebSocketPair(), client = pair[0], socket = pair[1];
    socket.accept(); this.candidates.set(socket, { budget, network: admissionProof ? null : network });
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    let boundId: string | undefined, verifying = false;
    const timer = setTimeout(() => { if (!boundId || !this.connections.get(boundId)?.product) { this.candidates.delete(socket); socket.close(1008, 'Pairing timed out'); } }, 5000);
    socket.addEventListener('message', event => { void (async () => {
      if (typeof event.data !== 'string' || event.data.length > 2_000_000) throw new Error('Invalid browser frame');
      const raw: unknown = JSON.parse(event.data);
      if (!boundId) {
        if (verifying || !this.candidates.has(socket)) throw new Error('Pairing unavailable'); verifying = true;
        const proof = Proof.parse(raw);
        if (admissionProof && proof.pairingId !== admissionProof.pairingId) throw new Error('Admission identity mismatch');
        const key = await crypto.subtle.importKey('raw', browserUnbase64(proof.publicKey), 'Ed25519', false, ['verify']);
        if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(proof.proof), new TextEncoder().encode(`gitspace-browser-relay-v2:client:${nonce}:${proof.clientNonce}`))) throw new Error('Invalid pairing signature');
        const accepted = await this.ctx.blockConcurrencyWhile(async () => {
          const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === proof.pairingId);
          if (!pairing || !this.candidates.has(socket)) return false;
          if (pairing.state === 'awaiting-key') {
            if (Date.parse(pairing.expiresAt) <= Date.now() || !proof.code || !equalSecret(pairing.code, proof.code)) return false;
            registry.pairings = registry.pairings.map(item => item === pairing ? { ...pairing, state: 'pending-confirmation', publicKey: proof.publicKey, code: null, expiresAt: null } : item);
            await this.ctx.storage.put('browser.relay.pairings', registry);
          } else if (!equalSecret(pairing.publicKey, proof.publicKey)) return false;
          if (this.connections.has(pairing.pairingId)) return false;
          boundId = pairing.pairingId;
          this.connections.set(boundId, { socket, sequence: 0, pending: new Map(), listeners: new Map(), authorized: new Set() });
          return true;
        });
        if (!accepted) throw new Error('Pairing rejected');
        socket.send(JSON.stringify({ pairing: 'server' })); return;
      }
      const connection = this.connections.get(boundId);
      if (connection?.socket !== socket) throw new Error('Stale browser connection');
      const message = Reply.parse(raw);
      if (message.hello && message.Browser) {
        connection.product = message.Browser.slice(0, 100); this.candidates.delete(socket); clearTimeout(timer); socket.send(JSON.stringify({ ready: true }));
        this.ctx.waitUntil(this.retryRevocations(boundId));
        return;
      }
      if (!connection.product) throw new Error('Browser hello required');
      if (message.id !== undefined) { const pending = connection.pending.get(message.id); if (!pending) return; connection.pending.delete(message.id); pending.cancelTimer(); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); }
      else if (message.targetId) for (const listener of connection.listeners.get(message.targetId) ?? []) listener(message.fenced ? { method: 'disconnected' } : { method: message.method, params: message.params, sessionId: message.sessionId });
    })().catch(() => socket.close(1008, 'Invalid browser message')); });
    socket.addEventListener('close', () => { clearTimeout(timer); this.candidates.delete(socket); if (boundId && this.connections.get(boundId)?.socket === socket) this.disconnect(boundId); });
    socket.addEventListener('error', () => socket.close(1011, 'Browser transport error'));
    socket.send(JSON.stringify({ pairing: 'challenge', serverNonce: nonce }));
    return new Response(null, { status: 101, webSocket: client, ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}) });
  }
  private disconnect(pairingId: string) {
    const connection = this.connections.get(pairingId); if (!connection) return; this.connections.delete(pairingId);
    for (const pending of connection.pending.values()) { pending.cancelTimer(); pending.reject(new Error('Browser extension disconnected; effect outcome uncertain')); }
    for (const listeners of connection.listeners.values()) for (const listener of listeners) listener({ method: 'disconnected' });
  }
  private request(pairingId: string, command: Record<string, unknown>) {
    const connection = this.connections.get(pairingId);
    if (!connection?.product) throw new Error('Account Chrome extension is not connected');
    const id = ++connection.sequence, deferred = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { connection.pending.delete(id); deferred.reject(new Error('Browser relay timeout; effect outcome uncertain')); }, 30_000);
    connection.pending.set(id, { ...deferred, cancelTimer: () => clearTimeout(timer) }); connection.socket.send(JSON.stringify({ ...command, id })); return deferred.promise;
  }
  async execute(authorization: RuntimeAccountBrowserAuthorization) {
    const placement = authorization.body.scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === placement.pairingId);
    if (!pairing || pairing.state !== 'confirmed') throw new Error('Browser fingerprint confirmation required');
    const body = await verifyRuntimeAccountBrowserAuthorization(authorization, pairing.trust);
    if (placement.generation !== pairing.generation) throw new Error('Browser pairing changed');
    const approval = await this.dispatchApproval(authorization);
    if (!this.connections.get(placement.pairingId)?.product) throw new Error('Approved Chrome is unavailable: extension is not connected');
    const result = await this.runtime.execute(authorization, AbortSignal.timeout(Math.max(1, Date.parse(body.expiresAt) - Date.now())));
    return { ...result, browser: { pairingId: placement.pairingId, name: approval.name } };
  }
  private async authorize(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    signal.throwIfAborted(); const placement = authorization.body.scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    await this.dispatchApproval(authorization);
    const connection = this.connections.get(placement.pairingId);
    if (!connection) throw new Error('Account Chrome extension is not connected');
    if (!connection.authorized.has(authorization.body.scope.attemptId)) { await this.request(placement.pairingId, { operation: 'authorize', authorization }); connection.authorized.add(authorization.body.scope.attemptId); }
    return { pairingId: placement.pairingId, connection };
  }
  async tabs(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) { const { pairingId } = await this.authorize(authorization, signal); const command = authorization.body.command; if (command.type === 'manage') throw new Error('Tabs authorization required'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'tabs', groupId: command.type === 'execute' ? command.grant.body.groupId : command.groupId }); }
  async open(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    const { pairingId, connection } = await this.authorize(authorization, signal);
    const command = authorization.body.command; if (command.type !== 'execute') throw new Error('Browser execution authorization required');
    await this.dispatchApproval(authorization);
    const opened = z.object({ targetId: z.string(), sessionId: z.string() }).parse(await this.request(pairingId, { operation: 'open', grant: command.grant }));
    if (command.args.action !== 'tabs' && command.args.targetId && opened.targetId !== command.args.targetId) throw new Error('Browser target mismatch');
    let listeners = connection.listeners.get(opened.targetId); if (!listeners) { listeners = new Set(); connection.listeners.set(opened.targetId, listeners); }
    const registered = listeners;
    const channel: BrowserChannel = { send: async (method, params = {}, sessionId) => { if (Date.parse(command.grant.body.expiresAt) <= Date.now() || sessionId && sessionId !== opened.sessionId || this.connections.get(pairingId) !== connection) throw new Error('Browser channel expired or outside session'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'command', targetId: opened.targetId, sessionId: opened.sessionId, method, params }); }, subscribe: listener => { registered.add(listener); return () => { registered.delete(listener); }; }, close: async () => { registered.clear(); } };
    return { targetId: opened.targetId, channel };
  }
  private async retryRevocations(pairingId?: string) {
    const prefix = pairingId ? `browser.relay.revoke:${pairingId}:` : 'browser.relay.revoke:';
    for (const [key, stored] of await this.ctx.storage.list({ prefix })) {
      const intent = RevocationIntent.parse(stored);
      if (!this.connections.get(intent.pairingId)?.product) continue;
      try {
        await this.revoke(intent.groupId, intent.pairingId);
        await this.ctx.storage.delete(key);
      } catch { /* Authority stays revoked; retain the durable closure intent for the next hello. */ }
    }
  }
  async revoke(groupId: string, pairingId: string) { if (this.connections.has(pairingId)) await this.request(pairingId, { operation: 'revoke', groupId }); }
}
