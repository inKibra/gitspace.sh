import { waitUntil } from 'cloudflare:workers';
import {
  credentialProtocolBase64,
  decodeSignedRpcHeader,
  deviceGrantExpiresAt,
  MAX_DELEGATION_DEPTH,
  SIGNED_REQUEST_EXPIRED_CODE,
  SIGNED_REQUEST_EXPIRED_MESSAGE,
  SIGNED_REQUEST_MAX_AGE_MS,
  signedControlRequestSchema,
  verifyCredentialAuthorityGrant,
  verifyDeviceGrantRecord,
  verifyManagedDeviceGrant,
  verifyRelayAuthorization,
  verifyRpcDigestSignature,
  verifyRpcSignature,
  verifySignedControlRequest,
  type CredentialAuthorityGrant,
  type DeviceCapability,
  type DeviceGrantRecord,
  type SignedCredentialAuthorityGrant,
  type VerifiedDevice,
} from '@gitspace/protocol';
import type { AccountAuthorization, AccountRecord } from './account-state.js';
import type { CredentialVaultResult } from './application.js';

/**
 * Per-request authentication runs in the isolate against one cached copy of the
 * tenant's device registry and account state. A copy older than the refresh period
 * is still served while one single-flight load replaces it; once the last
 * successful load is older than the stale limit, authentication fails closed.
 */
const DEVICE_AUTHORITY_REFRESH_MS = 30_000;
const DEVICE_AUTHORITY_MAX_STALE_MS = 120_000;
/** A load that never settled (its request context ended) stops being joined. */
const LOAD_ABANDON_MS = 10_000;
const MEMO_LIMIT = 4_096;

export const DEVICE_AUTHORITY_UNAVAILABLE = 'DEVICE_AUTHORITY_UNAVAILABLE';
export const DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE = 'Device authority is unavailable; retry shortly';

export type MachineCapability = 'storage.provision' | 'storage.access' | 'space.control' | 'credential.access';

/** One enrolled machine as the vault stores it; `grant` is the root-paired grant, null for managed machines. */
export interface MachineCredential {
  machineId: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  capabilities: string[];
  generation: number;
  grant: SignedCredentialAuthorityGrant | null;
}

/** The vault's read model for per-request authentication. */
export interface DeviceRegistrySnapshot {
  userId: string;
  rootPublicKey: string;
  machines: MachineCredential[];
  devices: DeviceGrantRecord[];
}

export interface DeviceAuthoritySnapshot {
  registry: DeviceRegistrySnapshot | null;
  account: { authorization: AccountAuthorization; record: AccountRecord | null };
}

/** Raw stored rows; verification never trusts them without checking signatures and currency. */
export interface DeviceRegistry {
  readonly userId: string;
  readonly rootPublicKey: string;
  machine(machineId: string): MachineCredential | null;
  device(deviceId: string): DeviceGrantRecord | null;
}

/** `miss` marks a rejection that a newer registry (a just-enrolled credential) could overturn. */
export type DeviceVerdict<T> =
  | { status: 'ok'; value: T }
  | { status: 'error'; error: { code: string; message: string }; miss: boolean };

interface Remembered<T> { value: T; until: number }
interface VerifiedGrant { grant: CredentialAuthorityGrant; managed: boolean }
/** Verification results by credential identity; a revocation anywhere in a chain changes the key. */
interface Memo {
  machines: Map<string, Remembered<boolean>>;
  devices: Map<string, Remembered<VerifiedDevice | null>>;
  grants: Map<string, Remembered<VerifiedGrant | null>>;
}

function reject(code: string, message: string, miss = false): DeviceVerdict<never> {
  return { status: 'error', error: { code, message }, miss };
}

/**
 * The credential checks the vault used to run per request, as pure functions of a
 * registry. The vault runs them over its own rows for the requests it still owns
 * (pairing, invitations, MCP setup); the worker runs them over its cached snapshot.
 */
export class DeviceVerifier {
  private readonly rootKey: Uint8Array | null;

  constructor(private readonly registry: DeviceRegistry | null, private readonly memo: Memo | null = null) {
    this.rootKey = registry ? credentialProtocolBase64.decode(registry.rootPublicKey) : null;
  }

  private readonly resolve = (deviceId: string): DeviceGrantRecord | null => {
    const record = this.registry?.device(deviceId) ?? null;
    return record?.invite.invite.userId === this.registry?.userId ? record : null;
  };

  /** Identity of the canonical issuer chain (`id:generation` per link, so a revocation changes it) and its earliest expiry. */
  private chain(deviceId: string | null): { key: string; expiresAt: number } {
    let key = '';
    let expiresAt = Infinity;
    for (let depth = 0; deviceId !== null && depth <= MAX_DELEGATION_DEPTH; depth++) {
      const record = this.resolve(deviceId);
      key += `/${deviceId}:${record?.generation ?? '-'}`;
      if (!record) break;
      expiresAt = Math.min(expiresAt, deviceGrantExpiresAt(record) ?? Infinity);
      deviceId = record.invite.issuer.kind === 'device' ? record.invite.issuer.deviceId : null;
    }
    return { key, expiresAt };
  }

  private remember<T>(memo: Map<string, Remembered<T>> | undefined, key: string, now: number, compute: () => Remembered<T>): T {
    const cached = memo?.get(key);
    if (cached && now < cached.until) return cached.value;
    const computed = compute();
    if (memo) {
      if (memo.size >= MEMO_LIMIT) memo.clear();
      memo.set(key, computed);
    }
    return computed.value;
  }

  /** An enrolled machine whose root-paired grant (if any) still verifies, including issuer revocation and expiry. */
  machine(machineId: string, now: number): MachineCredential | null {
    const row = this.registry?.machine(machineId) ?? null;
    const rootKey = this.rootKey;
    const grant = row?.grant;
    if (!row || !grant || !rootKey) return row;
    const chain = this.chain(grant.grant.issuerDeviceId ?? null);
    const valid = this.remember(this.memo?.machines, `${machineId}:${row.generation}${chain.key}`, now, () => {
      const verified = verifyCredentialAuthorityGrant(grant, rootKey, now, this.resolve);
      return { value: verified !== null, until: verified ? Math.min(verified.expiresAt ?? Infinity, chain.expiresAt) : Infinity };
    });
    return valid ? row : null;
  }

  /** A browser or client grant that verifies now, through its whole issuer chain. */
  device(deviceId: string, now: number): VerifiedDevice | null {
    const rootKey = this.rootKey;
    const record = this.resolve(deviceId);
    if (!record || !rootKey) return null;
    const chain = this.chain(deviceId);
    return this.remember(this.memo?.devices, chain.key, now, () => {
      const verified = verifyDeviceGrantRecord(record, rootKey, now, this.resolve);
      return { value: verified, until: verified ? chain.expiresAt : Infinity };
    });
  }

  /** `maxAgeMs` is the clock window: `SIGNED_UPLOAD_MAX_AGE_MS` only for a buffered `data.put`. */
  authorizeControl(request: unknown, capability: MachineCapability, maxAgeMs: number, now: number): DeviceVerdict<{ machineId: string; generation: number }> {
    if (!this.registry) return reject('VAULT_UNCONFIGURED', 'Vault is not configured', true);
    const parsed = signedControlRequestSchema.safeParse(request);
    if (!parsed.success || parsed.data.userId !== this.registry.userId) return reject('INVALID_REQUEST', 'Control request is invalid');
    const machine = this.machine(parsed.data.machineId, now);
    if (!machine || !verifySignedControlRequest(parsed.data, credentialProtocolBase64.decode(machine.signingPublicKey))) {
      return reject('DEVICE_UNAUTHORIZED', 'Device is not authorized', true);
    }
    if (!machine.capabilities.includes(capability)) return reject('ACCESS_DENIED', `Device lacks ${capability}`);
    if (Math.abs(now - parsed.data.timestamp) > maxAgeMs) return reject(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE);
    return { status: 'ok', value: { machineId: machine.machineId, generation: machine.generation } };
  }

  /** A subscription admitted at `generation` stays live while that exact credential holds the capability. */
  controlSubscription(input: { userId: string; machineId: string; generation: number }, capability: MachineCapability, now: number): boolean {
    const machine = this.machine(input.machineId, now);
    return input.userId === this.registry?.userId && machine?.generation === input.generation && machine.capabilities.includes(capability);
  }

  /**
   * Signed device request (`x-gitspace-device`). `body: null` authenticates only the
   * signed digest; the receiver of the streamed body checks it.
   */
  authorizeRequest(input: {
    header: string | null;
    method: string;
    target: string;
    body: Uint8Array | null;
    capabilities: readonly DeviceCapability[];
    browserOnly?: boolean;
    accountScope: boolean;
  }, now: number): DeviceVerdict<{ device: VerifiedDevice; bodySha256: string }> {
    if (!this.registry) return reject('RPC_FORBIDDEN', 'Account credential authority does not own this tenant', true);
    const header = input.header ? decodeSignedRpcHeader(input.header) : null;
    if (!header) return reject('RPC_UNAUTHORIZED', 'Device signature is missing or invalid');
    const device = this.device(header.deviceId, now);
    if (!device) {
      const unknown = this.resolve(header.deviceId) === null;
      return input.method === 'GET'
        ? reject('RPC_DEVICE_UNKNOWN', 'Device grant is unknown, expired or revoked', unknown)
        : reject('RPC_UNAUTHORIZED', 'Device signature is invalid or its grant is revoked', unknown);
    }
    const signed = input.body === null
      ? verifyRpcDigestSignature(header, { method: input.method, path: input.target }, device.signingPublicKey)
      : verifyRpcSignature(header, { method: input.method, path: input.target, body: input.body }, device.signingPublicKey);
    if (!signed) return reject('RPC_UNAUTHORIZED', 'Device signature is invalid or its grant is revoked');
    if ((input.browserOnly && device.kind !== 'browser') || (input.accountScope && device.scope.kind !== 'user')
      || !input.capabilities.every((capability) => device.capabilities.includes(capability))) {
      return reject('RPC_FORBIDDEN', 'Device is out of scope or lacks permission');
    }
    if (Math.abs(now - header.timestamp) > SIGNED_REQUEST_MAX_AGE_MS) return reject(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE);
    return { status: 'ok', value: { device, bodySha256: header.bodySha256 } };
  }

  /**
   * A machine grant is current when it verifies (root-paired, or a self-signed claim
   * matching a managed row exactly) and names the stored keys, generation and capability.
   */
  authorizeRelayGrant(input: SignedCredentialAuthorityGrant, capability: 'space.control' | 'storage.access', now: number): DeviceVerdict<{ grant: CredentialAuthorityGrant }> {
    const rootKey = this.rootKey;
    if (!this.registry || !rootKey) return reject('VAULT_UNCONFIGURED', 'Vault is not configured', true);
    const chain = this.chain(input.grant.issuerDeviceId ?? null);
    const verified = this.remember(this.memo?.grants, `${JSON.stringify(input)}${chain.key}`, now, () => {
      const rooted = verifyCredentialAuthorityGrant(input, rootKey, now, this.resolve);
      const managed = rooted ? null : verifyManagedDeviceGrant(input, now);
      const grant = rooted ?? managed;
      return { value: grant ? { grant, managed: managed !== null } : null, until: grant ? Math.min(grant.expiresAt ?? Infinity, rooted ? chain.expiresAt : Infinity) : Infinity };
    });
    if (!verified || verified.grant.userId !== this.registry.userId) return reject('DEVICE_UNAUTHORIZED', 'Device grant is invalid');
    const { grant } = verified;
    const row = this.registry.machine(grant.machineId);
    const superseded = row === null || row.generation < grant.generation;
    if (verified.managed && (!row || row.grant !== null || JSON.stringify(row.capabilities) !== JSON.stringify(grant.capabilities))) {
      return reject('DEVICE_UNAUTHORIZED', 'Device grant is not a current managed device credential', superseded);
    }
    const machine = this.machine(grant.machineId, now);
    if (!machine || machine.generation !== grant.generation
      || machine.signingPublicKey !== grant.signingPublicKey
      || machine.exchangePublicKey !== grant.exchangePublicKey
      || !grant.capabilities.includes(capability)
      || !machine.capabilities.includes(capability)) {
      return reject('DEVICE_UNAUTHORIZED', 'Device grant is revoked, superseded, or lacks the required capability', superseded);
    }
    return { status: 'ok', value: { grant } };
  }

  /** `GitSpace` relay authorization signed by an enrolled machine's own key. */
  authorizeMachineRelay(header: string | null, target: string, machineId: string, now: number): DeviceVerdict<{ machineId: string }> {
    const machine = this.machine(machineId, now);
    if (!machine || machine.capabilities.length === 0) return reject('DEVICE_UNAUTHORIZED', 'Machine is not enrolled', machine === null);
    const verified = verifyRelayAuthorization({ header, signingPublicKey: machine.signingPublicKey, target, now, maxSkewMs: SIGNED_REQUEST_MAX_AGE_MS });
    if (verified.status === 'error') return verified.error.expired ? reject(SIGNED_REQUEST_EXPIRED_CODE, SIGNED_REQUEST_EXPIRED_MESSAGE) : reject('DEVICE_UNAUTHORIZED', verified.error.message, true);
    return { status: 'ok', value: { machineId } };
  }

  /** Account-scoped browser write authority, bounded by the earliest expiry in its issuer chain. */
  serviceDeviceAuthority(deviceId: string, now: number): { expiresAt: number | null } | null {
    const device = this.device(deviceId, now);
    if (!device || device.kind !== 'browser' || device.scope.kind !== 'user' || !device.capabilities.includes('rpc.write')) return null;
    const expiresAt = Math.min(device.expiresAt ?? Infinity, this.chain(deviceId).expiresAt);
    return { expiresAt: expiresAt === Infinity ? null : expiresAt };
  }
}

/** One loaded snapshot: verification plus the account state read with it. */
export class DeviceAuthorityView extends DeviceVerifier {
  constructor(registry: DeviceRegistry | null, memo: Memo, readonly account: DeviceAuthoritySnapshot['account']) {
    super(registry, memo);
  }
}

function snapshotRegistry(snapshot: DeviceRegistrySnapshot): DeviceRegistry {
  const machines = new Map(snapshot.machines.map((machine) => [machine.machineId, machine]));
  const devices = new Map(snapshot.devices.map((record) => [record.binding.deviceId, record]));
  return {
    userId: snapshot.userId,
    rootPublicKey: snapshot.rootPublicKey,
    machine: (machineId) => machines.get(machineId) ?? null,
    device: (deviceId) => devices.get(deviceId) ?? null,
  };
}

interface Entry { id: number; startedAt: number; view: DeviceAuthorityView }

export class DeviceAuthorityCache {
  private entry: Entry | null = null;
  private started = 0;
  private invalidatedThrough = 0;
  private inflight: { id: number; startedAt: number; promise: Promise<void> } | null = null;
  private queued: Promise<void> | null = null;
  private readonly memo: Memo = { machines: new Map(), devices: new Map(), grants: new Map() };
  private readonly now: () => number;
  private readonly keepAlive: (promise: Promise<unknown>) => void;

  constructor(private readonly load: () => Promise<DeviceAuthoritySnapshot>, options: { now?: () => number; keepAlive?: (promise: Promise<unknown>) => void } = {}) {
    this.now = options.now ?? (() => Date.now());
    this.keepAlive = options.keepAlive ?? (() => {});
  }

  /** Neither invalidated by a credential change nor older than the stale limit. */
  private usable(entry: Entry): boolean {
    return entry.id > this.invalidatedThrough && this.now() - entry.startedAt < DEVICE_AUTHORITY_MAX_STALE_MS;
  }

  /** The current view, refreshed in the background once it is older than the refresh period; null when none is usable. */
  async current(): Promise<DeviceAuthorityView | null> {
    const entry = this.entry;
    if (!entry || !this.usable(entry)) return this.refreshed(Math.max(entry?.id ?? 0, this.invalidatedThrough));
    if (this.now() - entry.startedAt >= DEVICE_AUTHORITY_REFRESH_MS) this.refresh(entry.id).catch(() => {});
    return entry.view;
  }

  /**
   * A view loaded after this call began, or the current usable view if that load
   * fails. Used when a credential is missing: it may have just enrolled.
   */
  async refreshed(after = this.started): Promise<DeviceAuthorityView | null> {
    await this.refresh(after).catch(() => {});
    const entry = this.entry;
    return entry && this.usable(entry) ? entry.view : null;
  }

  /** The vault changed a credential: views loaded before now are never served again. */
  invalidate(): void {
    this.invalidatedThrough = this.started;
  }

  /** Coalesces onto a load started after `after`; at most one more is queued behind a running one. */
  private refresh(after: number): Promise<void> {
    if (this.inflight && this.now() - this.inflight.startedAt > LOAD_ABANDON_MS) {
      this.inflight = null;
      this.queued = null;
    }
    const inflight = this.inflight;
    if (!inflight) return this.start();
    if (inflight.id > after) return inflight.promise;
    this.queued ??= inflight.promise.catch(() => {}).then(() => {
      this.queued = null;
      return this.start();
    });
    return this.queued;
  }

  private start(): Promise<void> {
    const id = ++this.started;
    const startedAt = this.now();
    const promise = this.load().then((snapshot) => {
      if (this.entry && this.entry.id > id) return;
      this.entry = { id, startedAt, view: new DeviceAuthorityView(snapshot.registry ? snapshotRegistry(snapshot.registry) : null, this.memo, snapshot.account) };
    }).finally(() => {
      if (this.inflight?.id === id) this.inflight = null;
    });
    this.inflight = { id, startedAt, promise };
    this.keepAlive(promise.catch(() => {}));
    return promise;
  }
}

async function loadDeviceAuthority(env: Env): Promise<DeviceAuthoritySnapshot> {
  const state = env.ACCOUNT_STATE.getByName('account');
  const [registry, authorization, record] = await Promise.all([
    env.CREDENTIALS.getByName(env.ACCOUNT_ID).deviceRegistrySnapshot(),
    state.authorization(env.ACCOUNT_ID),
    state.get(env.ACCOUNT_ID),
  ]);
  // A vault that does not own this tenant authorizes nothing here.
  const owned = registry?.userId === env.ACCOUNT_ID && registry.rootPublicKey === env.AUTH_PUBLIC_KEY;
  return { registry: owned ? registry : null, account: { authorization, record } };
}

let shared: DeviceAuthorityCache | null = null;

/** The isolate's cache. Worker requests and Durable Objects of this tenant share it. */
export function deviceAuthority(env: Env): DeviceAuthorityCache {
  shared ??= new DeviceAuthorityCache(() => loadDeviceAuthority(env), { keepAlive: waitUntil });
  return shared;
}

/** Called by the vault after it changes a credential; other isolates converge within one refresh. */
export function invalidateDeviceAuthority(): void {
  shared?.invalidate();
}

export function deviceAuthorityUnavailable(): CredentialVaultResult<never> {
  return { status: 'error', error: { code: DEVICE_AUTHORITY_UNAVAILABLE, message: DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE } };
}

/** Runs `check` on the cached view, once more on a fresh load when the credential may have just enrolled. */
export async function withDeviceAuthority<T>(env: Env, check: (view: DeviceAuthorityView, now: number) => DeviceVerdict<T>): Promise<CredentialVaultResult<T>> {
  const cache = deviceAuthority(env);
  const view = await cache.current();
  if (!view) return deviceAuthorityUnavailable();
  let verdict = check(view, Date.now());
  if (verdict.status === 'error' && verdict.miss) {
    const fresh = await cache.refreshed();
    if (fresh) verdict = check(fresh, Date.now());
  }
  return verdict.status === 'ok' ? verdict : { status: 'error', error: verdict.error };
}
