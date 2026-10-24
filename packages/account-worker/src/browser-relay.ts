import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { browserUnbase64, RuntimeBrowserTrustSchema, RuntimeAccountBrowserPairingSchema, RuntimeAccountBrowserRelayStatusSchema, RuntimeAccountBrowserGrantSchema, verifyRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserSignedGrant, type RuntimeBrowserTrust } from '@gitspace/protocol-runtime';
import { BROWSER_EXTENSION_PROTOCOL, browserExtensionUpdateRequired, RuntimeBrowserExtensionSchema, RuntimeBrowserGroupReportSchema, RuntimeBrowserNameSchema, RuntimeProjectBrowserPreferencesSchema, RuntimeProjectBrowserSettingsSchema, RuntimeAccountBrowserGroupRowSchema, type RuntimeBrowserGroupReport, type RuntimeBrowsersDocumentGroup, type RuntimeProjectBrowserPreferences } from '@gitspace/protocol-runtime';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import { AccountBrowserRuntime, type AccountBrowserTransport } from './browser-runtime.js';
import type { BrowserChannel } from './browser-cdp.js';
import { CdpBrowserShim, serveCdpSocket } from './browser-shim.js';
import { RelayBrowser } from './relay-browser.js';
import { extensionFiles } from '@gitspace/browser-extension';
import { zipSync, strToU8 } from 'fflate';

export function browserRelayArchive(endpoint: string): Uint8Array {
  return zipSync(Object.fromEntries(Object.entries(extensionFiles(endpoint)).map(([name, content]) => [name, strToU8(content)])));
}
/** `name` is the Chrome's one name; pairings stored before names moved to the pairing have none (see `names`). */
const identity = { pairingId: z.string().uuid(), generation: z.number().int().nonnegative(), trust: RuntimeBrowserTrustSchema, extension: RuntimeBrowserExtensionSchema.nullable().optional(), name: RuntimeBrowserNameSchema.optional() };
const Pairing = z.discriminatedUnion('state', [
  z.object({ ...identity, state: z.literal('awaiting-key'), code: z.string(), expiresAt: z.iso.datetime(), publicKey: z.null() }),
  z.object({ ...identity, state: z.literal('pending-confirmation'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
  z.object({ ...identity, state: z.literal('confirmed'), code: z.null(), expiresAt: z.null(), publicKey: z.string() }),
]);
const Registry = z.object({ pairings: z.array(Pairing) });
const ProjectSettings = z.object({ revision: z.number().int().nonnegative(), defaultPairingId: z.string().uuid().nullable(), approvals: z.array(RuntimeProjectBrowserPreferencesSchema.shape.approvals.element.extend({ generation: z.number().int().nonnegative(), approvalId: z.string().uuid(),
  /** LEGACY: approvals stored before names moved to the pairing carry the name; read only as an unnamed pairing's
   * fallback and dropped on the project's next write. Remove once every stored approval has been rewritten. */
  name: z.string().optional() })) });
type StoredPairing = z.infer<typeof Pairing>;
const Proof = z.object({ pairing: z.literal('client'), pairingId: z.string().uuid(), clientNonce: z.string().regex(/^[a-f0-9]{64}$/), publicKey: z.string().max(128), proof: z.string().max(128), code: z.string().max(256).optional() });
const Reply = z.object({ id: z.number().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), targetId: z.string().optional(), sessionId: z.string().optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), fenced: z.boolean().optional(), hello: z.boolean().optional(), Browser: z.string().optional(), protocol: z.number().int().nonnegative().optional(), extension: z.string().max(40).optional(), group: RuntimeBrowserGroupReportSchema.optional() });
/** Where a workspace's groups are kept for its `gitspace.browsers` document. */
export type BrowserWorkspaces = { getByName(name: string): { browserGroupReported(identity: { projectId: string; workspaceId: string }, group: RuntimeBrowsersDocumentGroup): Promise<void> } };
type Connection = { socket: WebSocket; product: string; sequence: number; pending: Map<number, { resolve(value: unknown): void; reject(error: Error): void; cancelTimer(): void }>; listeners: Map<string, Set<Parameters<BrowserChannel['subscribe']>[0]>>; authorized: Set<string> };
/** A script running on a Chrome (`browser.run`): its authority, the connection it began on, and its CDP connection
 * once the script connects. */
type ScriptRun = { authorization: RuntimeAccountBrowserAuthorization; grant: RuntimeAccountBrowserSignedGrant; pairingId: string; attemptId: string; deadline: number; connection: Connection; browser?: RelayBrowser; socket?: WebSocket };
/** The first extension protocol that shows tab previews. */
const PREVIEW_PROTOCOL = 3;
const PreviewReply = z.object({ image: z.string().max(600_000).nullable(), reason: z.string().max(256).nullable() });
const NO_CHROME = 'No Chrome is paired with this account. Ask the user to pair one in Plugins → Browsers.';
const UNCONFIRMED = 'A Chrome is paired with this account but its fingerprint is not confirmed yet. Ask the user to confirm it in Plugins → Browsers.';
const APPROVE_HINT = 'Ask the user to approve one in Plugins → Browsers or in this workspace’s Browser tab.';
/** Where a script's CDP connection reaches the relay object, from the browser session's sandbox binding only. */
export const BROWSER_SCRIPT_PATH = '/browser-relay/script/';
/** Every Chrome extension socket. Its attachment holds the socket's whole pairing state, so the relay hibernates between frames. */
const BROWSER_SOCKET_TAG = 'browser';
/** An admitted socket must finish pairing, through the extension's hello, within this long. */
const PAIRING_DEADLINE_MS = 5000;
const BrowserSocket = z.object({
  /** The server challenge the pairing proof signs. */
  nonce: z.string(),
  budget: z.string(),
  network: z.string().nullable(),
  /** The identity an admission proof admitted; the pairing proof must name it. */
  admittedPairingId: z.string().uuid().nullable(),
  deadline: z.number(),
  /** Set once the pairing proof is accepted. */
  pairingId: z.string().uuid().optional(),
  /** Set by the extension's hello; until then the socket is a candidate. */
  product: z.string().optional(),
});
type BrowserSocketState = z.infer<typeof BrowserSocket>;
function closeOpenSocket(socket: WebSocket, code: number, reason: string) { if (socket.readyState === 1) socket.close(code, reason); }
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
  /** Request state for each ready Chrome, rebuilt from its socket after the relay wakes from hibernation. */
  private readonly connections = new Map<string, Connection>();
  /** Sockets whose single pairing proof is being verified. */
  private readonly verifying = new WeakSet<WebSocket>();
  /** Scripts running on a Chrome, by token: each lives in memory until its run ends, its deadline passes or its Chrome
   * disconnects. */
  private readonly scripts = new Map<string, ScriptRun>();
  private readonly runtime: AccountBrowserRuntime;
  constructor(private readonly ctx: DurableObjectState, private readonly env: { ACCOUNT_ID: string; SPACE_AUTHORITY: BrowserWorkspaces }) { this.runtime = new AccountBrowserRuntime({ storage: ctx.storage, relay: this }); }
  /** Whether the host's socket is a Chrome extension socket. */
  owns(socket: WebSocket) { return this.ctx.getTags(socket).includes(BROWSER_SOCKET_TAG); }
  private sockets() {
    const open: { socket: WebSocket; state: BrowserSocketState }[] = [];
    for (const socket of this.ctx.getWebSockets(BROWSER_SOCKET_TAG)) {
      const state = BrowserSocket.safeParse(socket.deserializeAttachment());
      if (socket.readyState === 1 && state.success) open.push({ socket, state: state.data });
    }
    return open;
  }
  /** Sockets still pairing. One past its deadline is closed here, so it neither waits on a timer nor holds a budget. */
  private candidates() {
    return this.sockets().filter(({ socket, state }) => {
      if (state.product) return false;
      if (state.deadline > Date.now()) return true;
      socket.close(1008, 'Pairing timed out');
      return false;
    });
  }
  /** The socket bound to a pairing, ready or still saying hello. */
  private bound(pairingId: string) { return this.sockets().find(({ state }) => state.pairingId === pairingId); }
  /** The ready Chrome for a pairing. */
  private connection(pairingId: string): Connection | undefined {
    const bound = this.bound(pairingId), product = bound?.state.product;
    if (!bound || !product) return undefined;
    const cached = this.connections.get(pairingId);
    if (cached?.socket === bound.socket) { cached.product = product; return cached; }
    if (cached) this.disconnect(pairingId);
    // Request ids continue past any reply still in flight from before the relay hibernated.
    const connection: Connection = { socket: bound.socket, product, sequence: Date.now(), pending: new Map(), listeners: new Map(), authorized: new Set() };
    this.connections.set(pairingId, connection);
    return connection;
  }
  private async registry() { return Registry.parse(await this.ctx.storage.get('browser.relay.pairings') ?? { pairings: [] }); }
  private async projectPreferences(projectId: string) { return ProjectSettings.parse(await this.ctx.storage.get(`browser.relay.project:${projectId}`) ?? { revision: 0, defaultPairingId: null, approvals: [] }); }
  /** Each pairing's name: its own, else (LEGACY: pairings named before names moved from project approvals to the
   * pairing; remove with `ProjectSettings`' `name`) the first stored approval's, else `Chrome <id prefix>`. */
  private async names(pairings: StoredPairing[]) {
    const legacy = new Map<string, string>();
    if (pairings.some(pairing => !pairing.name)) for (const stored of (await this.ctx.storage.list({ prefix: 'browser.relay.project:' })).values()) {
      for (const approval of ProjectSettings.parse(stored).approvals) if (approval.name && !legacy.has(approval.pairingId)) legacy.set(approval.pairingId, approval.name);
    }
    return (pairing: StoredPairing) => pairing.name ?? legacy.get(pairing.pairingId) ?? `Chrome ${pairing.pairingId.slice(0, 8)}`;
  }
  /** A Chrome as refusals name it, so the agent can pass its `pairingId` or tell the user which Chrome to open. */
  private describe(pairing: StoredPairing, name: (pairing: StoredPairing) => string) { return `"${name(pairing)}" (${pairing.pairingId}, ${this.connection(pairing.pairingId) ? 'online' : 'offline'})`; }
  async projectSettings(projectId: string) {
    const [preferences, registry] = await Promise.all([this.projectPreferences(projectId), this.registry()]);
    const confirmed = registry.pairings.filter(pairing => pairing.state === 'confirmed'), name = await this.names(confirmed);
    return RuntimeProjectBrowserSettingsSchema.parse({ projectId, revision: preferences.revision, defaultPairingId: preferences.defaultPairingId, browsers: confirmed.map(pairing => {
      const approval = preferences.approvals.find(item => item.pairingId === pairing.pairingId && item.generation === pairing.generation);
      return { pairingId: pairing.pairingId, generation: pairing.generation, name: name(pairing), note: approval?.note ?? '', connected: !!this.connection(pairing.pairingId), approved: !!approval };
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
        approvals.push({ pairingId: approval.pairingId, note: approval.note, generation: pairing.generation, approvalId: prior?.approvalId ?? crypto.randomUUID() });
      }
      const removed = current.approvals.filter(prior => !approvals.some(next => next.pairingId === prior.pairingId && next.generation === prior.generation));
      // LEGACY: a name this write drops from an approval moves to its unnamed pairing first; remove with
      // `ProjectSettings`' `name`.
      const named = registry.pairings.filter(pairing => !pairing.name && current.approvals.some(item => item.pairingId === pairing.pairingId && item.name));
      for (const pairing of named) pairing.name = current.approvals.find(item => item.pairingId === pairing.pairingId && item.name)?.name;
      await this.ctx.storage.transaction(async tx => {
        await tx.put(`browser.relay.project:${projectId}`, { revision: current.revision + 1, defaultPairingId: preferences.defaultPairingId, approvals });
        if (named.length) await tx.put('browser.relay.pairings', registry);
        if (removed.length) for (const stored of (await tx.list({ prefix: 'browser.account.group:' })).values()) {
          const group = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = group.placement;
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
    if (approval) return approval;
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    throw new Error(`${pairing ? this.describe(pairing, await this.names([pairing])) : `Chrome ${pairingId}`} is not approved for this project. ${APPROVE_HINT}`);
  }
  /** Why a Chrome the project approved cannot take the call now. */
  private offline(pairing: StoredPairing, name: (pairing: StoredPairing) => string, others: StoredPairing[]) {
    const alternatives = others.filter(other => other.pairingId !== pairing.pairingId);
    const why = pairing.extension?.updateRequired ? 'its GitSpace extension is too old to connect. Ask the user to update the extension in that Chrome' : 'its GitSpace extension is not connected. Ask the user to open that Chrome';
    return new Error(`"${name(pairing)}" (${pairing.pairingId}) is approved but offline: ${why}${alternatives.length ? `, or pass another approved pairingId: ${alternatives.map(other => this.describe(other, name)).join(', ')}` : ''}.`);
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
    const registry = await this.registry(), name = await this.names(registry.pairings);
    return RuntimeAccountBrowserRelayStatusSchema.parse({ pairings: await Promise.all(registry.pairings.map(async pairing => ({ pairingId: pairing.pairingId, generation: pairing.generation, name: name(pairing), state: pairing.state, expiresAt: pairing.expiresAt, pairedKeyFingerprint: pairing.publicKey ? await fingerprint(pairing.publicKey) : null, connected: !!this.connection(pairing.pairingId), extension: pairing.extension ?? null, browser: pairing.state === 'confirmed' ? this.connection(pairing.pairingId)?.product ?? null : null }))) });
  }
  /** Names a paired Chrome; the name shows wherever the Chrome appears, in every project. */
  async rename(pairingId: string, name: string) {
    const value = RuntimeBrowserNameSchema.parse(name);
    const renamed = await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing) return false;
      pairing.name = value;
      await this.ctx.storage.put('browser.relay.pairings', registry);
      return true;
    });
    if (!renamed) throw new Error('Unknown browser pairing');
    return this.status();
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
  /** The Chrome a relay call uses: `pairingId`, else the project default, else the only approved Chrome. Each refusal
   * says what the agent can do about it (pass a pairingId, or ask the user to pair, approve or open a Chrome). */
  async placement(projectId: string, pairingId?: string) {
    const [preferences, registry] = await Promise.all([this.projectPreferences(projectId), this.registry()]);
    const confirmed = registry.pairings.filter(item => item.state === 'confirmed');
    if (!confirmed.length) throw new Error(registry.pairings.some(item => item.state === 'pending-confirmation') ? UNCONFIRMED : NO_CHROME);
    const name = await this.names(confirmed), list = (pairings: StoredPairing[]) => pairings.map(item => this.describe(item, name)).join(', ');
    const approved = confirmed.filter(item => preferences.approvals.some(approval => approval.pairingId === item.pairingId && approval.generation === item.generation));
    if (!approved.length) throw new Error(`No Chrome is approved for this project. Paired: ${list(confirmed)}. ${APPROVE_HINT}`);
    const selected = pairingId ?? preferences.defaultPairingId ?? (approved.length === 1 ? approved[0]?.pairingId : undefined);
    if (!selected) throw new Error(`Several Chromes are approved for this project and none is its default: ${list(approved)}. Pass the pairingId of the one to use.`);
    const pairing = approved.find(item => item.pairingId === selected);
    if (!pairing) throw new Error(`${pairingId ? `Chrome ${pairingId}` : 'The project default Chrome'} is not approved for this project. Approved: ${list(approved)}. Pass one of their pairingIds, or ask the user to approve that Chrome in Plugins → Browsers or in this workspace’s Browser tab.`);
    if (!this.connection(pairing.pairingId)) throw this.offline(pairing, name, approved);
    const approval = await this.approved(projectId, pairing.pairingId, pairing.generation);
    return { kind: 'account-relay' as const, accountId: this.env.ACCOUNT_ID, pairingId: pairing.pairingId, generation: pairing.generation, approvalId: approval.approvalId };
  }
  async unpair(pairingId: string) {
    await this.ctx.blockConcurrencyWhile(async () => { const registry = await this.registry(); registry.pairings = registry.pairings.filter(item => item.pairingId !== pairingId); await this.ctx.storage.put('browser.relay.pairings', registry); this.bound(pairingId)?.socket.close(1008, 'Browser unpaired'); this.disconnect(pairingId); });
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
        if (window?.nonces.includes(proof.nonce) || this.bound(pairing.pairingId)) return { status: 403 } as const;
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
              const active = new Set(this.candidates().map(({ state }) => state.network));
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
    for (const { socket, state } of this.candidates()) {
      if (state.budget === budget) pending++;
      if (state.network === network) aggregate++;
      if (state.network) { const entries = anonymous.get(state.network) ?? []; entries.push(socket); anonymous.set(state.network, entries); }
    }
    if (pending >= (admissionProof ? 1 : 4) || (!admissionProof && aggregate >= 16)) return new Response('Browser candidate capacity reached', { status: 429 });
    if (!admissionProof && [...anonymous.values()].reduce((total, entries) => total + entries.length, 0) >= 128) {
      // Bounded memory without letting existing anonymous networks exclude a new one.
      let largest: WebSocket[] = [];
      for (const entries of anonymous.values()) if (entries.length > largest.length) largest = entries;
      largest[0]?.close(1008, 'Browser candidate replaced');
    }
    const [client, socket] = Object.values(new WebSocketPair());
    const nonce = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    socket.serializeAttachment({ nonce, budget, network: admissionProof ? null : network, admittedPairingId: admissionProof?.pairingId ?? null, deadline: Date.now() + PAIRING_DEADLINE_MS } satisfies BrowserSocketState);
    this.ctx.acceptWebSocket(socket, [BROWSER_SOCKET_TAG]);
    socket.send(JSON.stringify({ pairing: 'challenge', serverNonce: nonce }));
    return new Response(null, { status: 101, webSocket: client, ...(protocol ? { headers: { 'sec-websocket-protocol': protocol } } : {}) });
  }
  /** The host relay forwards every message on a socket it `owns`. */
  async webSocketMessage(socket: WebSocket, data: string | ArrayBuffer) {
    try { await this.receive(socket, data); }
    catch { closeOpenSocket(socket, 1008, 'Invalid browser message'); }
  }
  webSocketClose(socket: WebSocket) {
    this.release(socket);
    socket.close();
  }
  webSocketError(socket: WebSocket) {
    this.release(socket);
    closeOpenSocket(socket, 1011, 'Browser transport error');
  }
  private release(socket: WebSocket) {
    const state = BrowserSocket.safeParse(socket.deserializeAttachment());
    const pairingId = state.success ? state.data.pairingId : undefined;
    if (pairingId && this.connections.get(pairingId)?.socket === socket) this.disconnect(pairingId);
  }
  private async receive(socket: WebSocket, data: string | ArrayBuffer) {
    const state = BrowserSocket.parse(socket.deserializeAttachment());
    if (typeof data !== 'string' || data.length > 2_000_000) throw new Error('Invalid browser frame');
    if (!state.product && state.deadline <= Date.now()) return socket.close(1008, 'Pairing timed out');
    const raw: unknown = JSON.parse(data);
    if (!state.pairingId) {
      if (this.verifying.has(socket)) throw new Error('Pairing unavailable');
      this.verifying.add(socket);
      const proof = Proof.parse(raw);
      if (state.admittedPairingId && proof.pairingId !== state.admittedPairingId) throw new Error('Admission identity mismatch');
      const key = await crypto.subtle.importKey('raw', browserUnbase64(proof.publicKey), 'Ed25519', false, ['verify']);
      if (!await crypto.subtle.verify('Ed25519', key, browserUnbase64(proof.proof), new TextEncoder().encode(`gitspace-browser-relay-v2:client:${state.nonce}:${proof.clientNonce}`))) throw new Error('Invalid pairing signature');
      const accepted = await this.ctx.blockConcurrencyWhile(async () => {
        const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === proof.pairingId);
        if (!pairing || socket.readyState !== 1) return false;
        if (pairing.state === 'awaiting-key') {
          if (Date.parse(pairing.expiresAt) <= Date.now() || !proof.code || !equalSecret(pairing.code, proof.code)) return false;
          registry.pairings = registry.pairings.map(item => item === pairing ? { ...pairing, state: 'pending-confirmation', publicKey: proof.publicKey, code: null, expiresAt: null } : item);
          await this.ctx.storage.put('browser.relay.pairings', registry);
        } else if (!equalSecret(pairing.publicKey, proof.publicKey)) return false;
        if (this.bound(pairing.pairingId)) return false;
        socket.serializeAttachment({ ...state, pairingId: pairing.pairingId } satisfies BrowserSocketState);
        return true;
      });
      if (!accepted) throw new Error('Pairing rejected');
      socket.send(JSON.stringify({ pairing: 'server' }));
      return;
    }
    const message = Reply.parse(raw);
    if (message.hello && message.Browser) {
      const extension = { version: message.extension ?? null, protocol: message.protocol ?? 0, updateRequired: browserExtensionUpdateRequired(message.protocol ?? 0) };
      await this.recordExtension(state.pairingId, extension);
      if (extension.updateRequired) {
        socket.send(JSON.stringify({ updateRequired: { protocol: extension.protocol, minimum: BROWSER_EXTENSION_PROTOCOL - 1 } }));
        return socket.close(1008, 'Extension update required');
      }
      socket.serializeAttachment({ ...state, product: message.Browser.slice(0, 100) } satisfies BrowserSocketState);
      socket.send(JSON.stringify({ ready: true, protocol: BROWSER_EXTENSION_PROTOCOL }));
      this.ctx.waitUntil(this.retryRevocations(state.pairingId));
      return;
    }
    if (!state.product) throw new Error('Browser hello required');
    const connection = this.connection(state.pairingId);
    if (connection?.socket !== socket) throw new Error('Stale browser connection');
    if (message.group) { const report = message.group; this.ctx.waitUntil(this.groupReported(state.pairingId, report).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_group_report_failed', groupId: report.groupId, error: String(error) })))); return; }
    if (message.id !== undefined) { const pending = connection.pending.get(message.id); if (!pending) return; connection.pending.delete(message.id); pending.cancelTimer(); if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result); }
    else if (message.targetId) for (const listener of connection.listeners.get(message.targetId) ?? []) listener(message.fenced ? { method: 'disconnected' } : { method: message.method, params: message.params, sessionId: message.sessionId });
  }
  /** Keeps what a pairing's extension last reported; written only when it changes. */
  private async recordExtension(pairingId: string, extension: z.infer<typeof RuntimeBrowserExtensionSchema>) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const registry = await this.registry(), pairing = registry.pairings.find(item => item.pairingId === pairingId);
      if (!pairing || JSON.stringify(pairing.extension ?? null) === JSON.stringify(extension)) return;
      pairing.extension = extension;
      await this.ctx.storage.put('browser.relay.pairings', registry);
    });
  }
  /** A paired Chrome reported one of its workspace groups. The workspace keeps the tabs, each marked usable when it is
   * on the grant's origins or on the site you consented to by dragging it in, and the scripts running there. */
  private async groupReported(pairingId: string, report: RuntimeBrowserGroupReport) {
    const stored = await this.ctx.storage.get(`browser.account.group:${report.groupId}`);
    if (!stored || await this.ctx.storage.get(`browser.account.revoked:${report.groupId}`)) return;
    const grant = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = grant.placement;
    if (placement.kind !== 'account-relay' || placement.pairingId !== pairingId) return;
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === pairingId);
    if (!pairing) return;
    const usable = (url: string, site: string | null) => {
      if (url === 'about:blank') return true;
      try { const { protocol, hostname } = new URL(url); return ['http:', 'https:'].includes(protocol) && [...grant.origins, ...(site ? [site] : [])].some(origin => browserOriginMatches(origin, hostname)); } catch { return false; }
    };
    await this.env.SPACE_AUTHORITY.getByName(`${this.env.ACCOUNT_ID}:${grant.workspaceId}`).browserGroupReported({ projectId: grant.projectId, workspaceId: grant.workspaceId }, {
      pairingId, browser: (await this.names([pairing]))(pairing), groupId: grant.groupId, groupName: grant.groupName, origins: grant.origins, expiresAt: grant.expiresAt, reportedAt: new Date().toISOString(),
      tabs: report.tabs.map(tab => ({ ...tab, usable: usable(tab.url, tab.site) })), running: report.running,
    });
  }
  /** An archived or deleted workspace's groups lose their authority now; each Chrome closes the agent's tabs and lets
   * yours go now or when it next connects. */
  async retireWorkspace(projectId: string, workspaceId: string) {
    await this.ctx.storage.transaction(async tx => {
      for (const stored of (await tx.list({ prefix: 'browser.account.group:' })).values()) {
        const group = RuntimeAccountBrowserGroupRowSchema.parse(stored), placement = group.placement;
        if (group.projectId !== projectId || group.workspaceId !== workspaceId || placement.kind !== 'account-relay' || await tx.get(`browser.account.revoked:${group.groupId}`)) continue;
        await tx.put(`browser.account.revoked:${group.groupId}`, true);
        await tx.put(`browser.relay.revoke:${placement.pairingId}:${group.groupId}`, { pairingId: placement.pairingId, groupId: group.groupId });
      }
    });
    await this.retryRevocations();
  }
  private disconnect(pairingId: string) {
    const connection = this.connections.get(pairingId); if (!connection) return; this.connections.delete(pairingId);
    for (const pending of connection.pending.values()) { pending.cancelTimer(); pending.reject(new Error('Browser extension disconnected; effect outcome uncertain')); }
    for (const listeners of connection.listeners.values()) for (const listener of listeners) listener({ method: 'disconnected' });
    for (const [token, run] of this.scripts) if (run.connection === connection) this.dropScript(token, run, 1011, 'Chrome disconnected');
  }
  private request(pairingId: string, command: Record<string, unknown>) {
    const connection = this.connection(pairingId);
    if (!connection) throw new Error('Account Chrome extension is not connected');
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
    await this.dispatchApproval(authorization);
    const name = (await this.names([pairing]))(pairing);
    if (!this.connection(placement.pairingId)) throw this.offline(pairing, () => name, []);
    const result = await this.runtime.execute(authorization, AbortSignal.timeout(Math.max(1, Date.parse(body.expiresAt) - Date.now())));
    return { ...result, browser: { pairingId: placement.pairingId, name } };
  }
  private async authorize(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    signal.throwIfAborted(); const placement = authorization.body.scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    await this.dispatchApproval(authorization);
    const connection = this.connection(placement.pairingId);
    if (!connection) throw new Error('Account Chrome extension is not connected');
    if (!connection.authorized.has(authorization.body.scope.attemptId)) { await this.request(placement.pairingId, { operation: 'authorize', authorization }); connection.authorized.add(authorization.body.scope.attemptId); }
    return { pairingId: placement.pairingId, connection };
  }
  async tabs(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) { const { pairingId } = await this.authorize(authorization, signal); const command = authorization.body.command; if (command.type === 'manage') throw new Error('Tabs authorization required'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'tabs', groupId: command.type === 'execute' ? command.grant.body.groupId : command.groupId }); }
  /** One tab's preview (`manage` `preview`). The extension captures only a tab of the group the agent is already
   * using, so a preview never attaches Chrome's debugger on its own. */
  async preview(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<z.infer<typeof PreviewReply>> {
    const { scope, command } = authorization.body, placement = scope.placement;
    if (command.type !== 'manage' || command.action !== 'preview' || !command.groupId || !command.targetId || placement.kind !== 'account-relay') throw new Error('Preview authorization required');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === placement.pairingId);
    if ((pairing?.extension?.protocol ?? 0) < PREVIEW_PROTOCOL) return { image: null, reason: 'Update the GitSpace extension in Chrome to see previews' };
    const { pairingId } = await this.authorize(authorization, signal);
    return PreviewReply.parse(await this.request(pairingId, { operation: 'preview', groupId: command.groupId, targetId: command.targetId }));
  }
  async open(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal) {
    const { pairingId, connection } = await this.authorize(authorization, signal);
    const command = authorization.body.command; if (command.type !== 'execute') throw new Error('Browser execution authorization required');
    await this.dispatchApproval(authorization);
    const opened = z.object({ targetId: z.string(), sessionId: z.string() }).parse(await this.request(pairingId, { operation: 'open', grant: command.grant }));
    if (command.args.action !== 'tabs' && command.args.action !== 'run' && command.args.targetId && opened.targetId !== command.args.targetId) throw new Error('Browser target mismatch');
    let listeners = connection.listeners.get(opened.targetId); if (!listeners) { listeners = new Set(); connection.listeners.set(opened.targetId, listeners); }
    const registered = listeners;
    const channel: BrowserChannel = { send: async (method, params = {}, sessionId) => { if (Date.parse(command.grant.body.expiresAt) <= Date.now() || sessionId && sessionId !== opened.sessionId || this.connection(pairingId) !== connection) throw new Error('Browser channel expired or outside session'); await this.dispatchApproval(authorization); return this.request(pairingId, { operation: 'command', targetId: opened.targetId, sessionId: opened.sessionId, method, params }); }, subscribe: listener => { registered.add(listener); return () => { registered.delete(listener); }; }, close: async () => { registered.clear(); } };
    return { targetId: opened.targetId, channel };
  }
  /** Begins a script on a Chrome (`browser.run`, docs/APERTURE-DESIGN.md §6.1). The run's authority is checked as for
   * a single step, the extension stores it by attempt, and the returned token admits the script's CDP connection
   * (`BROWSER_SCRIPT_PATH`) until the run ends or its deadline passes. */
  async scriptBegin(authorization: RuntimeAccountBrowserAuthorization): Promise<{ token: string }> {
    const now = Date.now();
    for (const [token, run] of this.scripts) if (run.deadline <= now) await this.endScript(token, run, 'Script run expired');
    const { scope, command } = authorization.body, placement = scope.placement;
    if (placement.kind !== 'account-relay') throw new Error('Account relay placement required');
    if (command.type !== 'execute' || command.args.action !== 'run') throw new Error('Browser script authorization required');
    const pairing = (await this.registry()).pairings.find(item => item.pairingId === placement.pairingId);
    if (!pairing || pairing.state !== 'confirmed') throw new Error('Browser fingerprint confirmation required');
    const body = await verifyRuntimeAccountBrowserAuthorization(authorization, pairing.trust);
    if (placement.generation !== pairing.generation) throw new Error('Browser pairing changed');
    await this.dispatchApproval(authorization);
    const connection = this.connection(placement.pairingId);
    if (!connection) throw this.offline(pairing, await this.names([pairing]), []);
    const claim = `browser.account.claim:${scope.projectId}:${scope.workspaceId}:${scope.attemptId}`;
    if (await this.ctx.storage.get(claim)) throw new Error('Browser authorization already consumed');
    await this.ctx.storage.put(claim, body.expiresAt);
    await this.runtime.recordGroup(scope, RuntimeAccountBrowserGrantSchema.parse(command.grant.body));
    await this.request(placement.pairingId, { operation: 'authorize', authorization });
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map(byte => byte.toString(16).padStart(2, '0')).join('');
    this.scripts.set(token, { authorization, grant: command.grant, pairingId: placement.pairingId, attemptId: scope.attemptId, deadline: Math.min(Date.parse(body.expiresAt), Date.parse(body.dispatch.deadlineAt)), connection });
    return { token };
  }
  /** Ends a script: its CDP connection closes and the extension refuses its attempt from now on. */
  async scriptEnd(token: string): Promise<void> {
    const run = this.scripts.get(token);
    if (run) await this.endScript(token, run, 'Script ended');
  }
  /** A script's CDP connection, from its sandbox through `BrowserSessionCdp`: `BROWSER_SCRIPT_PATH<token>/<cursor
   * label>`. Public requests never reach this path (index.ts forwards only `/ws` and `/tunnel/` to the relay object);
   * the token admits one connection, only while its run is live. The script sees the workspace group as a browser,
   * with the ghost cursor on its tabs. */
  async scriptFetch(request: Request): Promise<Response> {
    if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a CDP WebSocket', { status: 426 });
    const [token = '', label = ''] = new URL(request.url).pathname.slice(BROWSER_SCRIPT_PATH.length).split('/');
    const run = this.liveScript(token);
    if (!run || run.browser) return new Response('Unknown or ended script run', { status: 404 });
    const browser = new RelayBrowser({
      product: run.connection.product, grant: run.grant, attemptId: run.attemptId,
      request: async message => {
        if (this.liveScript(token) !== run) throw new Error('The script run ended');
        await this.dispatchApproval(run.authorization);
        return this.request(run.pairingId, message);
      },
      listen: (targetId, listener) => {
        let listeners = run.connection.listeners.get(targetId);
        if (!listeners) { listeners = new Set(); run.connection.listeners.set(targetId, listeners); }
        const registered = listeners.add(listener);
        return () => { registered.delete(listener); };
      },
    });
    run.browser = browser;
    const shim = await CdpBrowserShim.open(browser);
    if (this.scripts.get(token) !== run) return new Response('Unknown or ended script run', { status: 404 });
    const { socket, response } = serveCdpSocket(shim, { cursor: { label: decodeURIComponent(label).slice(0, 64) || 'Agent' } }, () => { void browser.close(); });
    run.socket = socket;
    return response;
  }
  /** A running script, or none once its run ended, its deadline passed or its Chrome reconnected. */
  private liveScript(token: string): ScriptRun | undefined {
    const run = this.scripts.get(token);
    if (!run) return undefined;
    if (run.deadline > Date.now() && this.connections.get(run.pairingId) === run.connection) return run;
    this.ctx.waitUntil(this.endScript(token, run, 'Script run expired'));
    return undefined;
  }
  private async endScript(token: string, run: ScriptRun, reason: string): Promise<void> {
    this.dropScript(token, run, 1000, reason);
    // The extension refuses the attempt from now on and lets the run's tabs go; they stay in the workspace group.
    if (this.connections.get(run.pairingId) === run.connection) await this.request(run.pairingId, { operation: 'release', attemptId: run.attemptId }).catch((error: unknown) => console.warn(JSON.stringify({ event: 'browser_script_release_failed', pairingId: run.pairingId, error: String(error) })));
  }
  private dropScript(token: string, run: ScriptRun, code: number, reason: string): void {
    this.scripts.delete(token);
    void run.browser?.close();
    if (run.socket) closeOpenSocket(run.socket, code, reason);
  }
  private async retryRevocations(pairingId?: string) {
    const prefix = pairingId ? `browser.relay.revoke:${pairingId}:` : 'browser.relay.revoke:';
    for (const [key, stored] of await this.ctx.storage.list({ prefix })) {
      const intent = RevocationIntent.parse(stored);
      if (!this.connection(intent.pairingId)) continue;
      try {
        await this.revoke(intent.groupId, intent.pairingId);
        await this.ctx.storage.delete(key);
      } catch { /* Authority stays revoked; retain the durable closure intent for the next hello. */ }
    }
  }
  async revoke(groupId: string, pairingId: string) { if (this.connection(pairingId)) await this.request(pairingId, { operation: 'revoke', groupId }); }
}
