import { z } from 'zod';
import type { ServiceCaller } from '@gitspace/protocol/service-access';
const StoredDeviceSessionSchema = z.object({ accountId: z.string(), hostname: z.string(), deviceId: z.string(), expiresAt: z.number(), state: z.string().optional(), returnTo: z.string().optional() });
/** A cloud browser's session, minted by its workspace's browser session object for one of that workspace's hostnames. */
const StoredCloudSessionSchema = z.object({ accountId: z.string(), hostname: z.string(), cloud: z.object({ projectId: z.string().min(1), workspaceId: z.string().min(1) }), expiresAt: z.number() });
const StoredSessionSchema = z.union([StoredDeviceSessionSchema, StoredCloudSessionSchema]);
type StoredSession = z.infer<typeof StoredSessionSchema>;
/** Who a session forwards its requests as: the approving browser device, or a workspace's cloud browser. */
export const ServiceSessionCallerSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('device'), accountId: z.string().min(1), deviceId: z.string().min(1) }),
  z.object({ kind: z.literal('cloud'), accountId: z.string().min(1), projectId: z.string().min(1), workspaceId: z.string().min(1) }),
]);
export type ServiceSessionCaller = z.infer<typeof ServiceSessionCallerSchema>;
export const ServiceSessionSchema = z.object({ sessionId: z.string().uuid(), caller: ServiceSessionCallerSchema, hostname: z.string(), expiresAt: z.number() });
export type ServiceSession = z.infer<typeof ServiceSessionSchema>;
export type ServiceDeviceAuthority = { expiresAt: number | null };
export type ServiceWorkspace = { projectId: string; workspaceId: string };
export const SERVICE_COOKIE = '__Host-gitspace-service';
export const SERVICE_STATE_COOKIE = '__Host-gitspace-service-state';
/** How long a session lasts from its approval or, for a cloud browser, from each mint; never past its device's grant.
 * Only a browser enrolled in this account can approve one. */
export const SERVICE_SESSION_MS = 8 * 60 * 60_000;
const AUTHORITY_CACHE_MS = 5_000;
function devicePrefix(deviceId: string): string { return `service-device:${encodeURIComponent(deviceId)}:`; }
function cloudPrefix(workspace: ServiceWorkspace): string { return `service-cloud:${encodeURIComponent(workspace.projectId)}:${encodeURIComponent(workspace.workspaceId)}:`; }
/** The index entry that lets a session go with its device or workspace. A workspace's cloud browser holds one session per hostname. */
function sessionIndex(key: string, value: StoredSession): string {
  return 'cloud' in value ? `${cloudPrefix(value.cloud)}${encodeURIComponent(value.hostname)}` : `${devicePrefix(value.deviceId)}${key}`;
}
/** Whether `caller` is the one `session` was issued to. */
export function sameServiceCaller(session: ServiceSessionCaller, caller: ServiceCaller): boolean {
  if (session.accountId !== caller.accountId) return false;
  return session.kind === 'device'
    ? caller.kind === 'device' && caller.deviceId === session.deviceId
    : caller.kind === 'cloud' && caller.projectId === session.projectId && caller.workspaceId === session.workspaceId;
}
export function serviceCookie(request: Request, name: string): string | null {
  const values = (request.headers.get('cookie') ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${name}=`));
  return values.length === 1 ? values[0]!.slice(name.length + 1) : null;
}
export function safeServiceReturn(value: string): boolean {
  const origin = 'https://service.invalid';
  try {
    const decoded = decodeURIComponent(value);
    if (/[\u0000-\u0020\u007f\\]/u.test(value) || /[\u0000-\u001f\u007f\\]/u.test(decoded)) return false;
    const parsed = new URL(value, origin);
    const normalized = new URL(decoded, origin);
    return value.startsWith('/') && !value.startsWith('//') && !decoded.startsWith('//')
      && parsed.origin === origin && normalized.origin === origin
      && !normalized.pathname.startsWith('/__gitspace/') && normalized.pathname !== '/__gitspace';
  } catch { return false; }
}
export class ServiceSessions {
  private readonly authorityCache = new Map<string, { until: number; authority: ServiceDeviceAuthority | null }>();
  constructor(private readonly storage: DurableObjectStorage, private readonly accountId: string,
    private readonly authority: (deviceId: string) => Promise<ServiceDeviceAuthority | null>) {}
  private async currentAuthority(deviceId: string): Promise<ServiceDeviceAuthority | null> {
    if (await this.storage.get(`service-revoked:${deviceId}`)) return null;
    const now = Date.now();
    const cached = this.authorityCache.get(deviceId);
    if (cached && cached.until > now) return cached.authority;
    const authority = await this.authority(deviceId);
    if (this.authorityCache.size >= 256) this.authorityCache.clear();
    const until = Math.min(now + AUTHORITY_CACHE_MS, authority?.expiresAt ?? Infinity);
    this.authorityCache.set(deviceId, { until, authority });
    return until > Date.now() ? authority : null;
  }
  async approve(input: { hostname: string; deviceId: string; state: string; returnTo: string }) {
    if (!safeServiceReturn(input.returnTo) || !z.string().uuid().safeParse(input.state).success) throw new Error('Invalid service approval');
    const authority = await this.currentAuthority(input.deviceId);
    if (!authority) throw new Error('Service browser authority is unavailable');
    const ticket = crypto.randomUUID();
    await this.storage.transaction(async tx => {
      if (await tx.get(`service-revoked:${input.deviceId}`)) throw new Error('Service browser authority was revoked');
      const key = `service-ticket:${ticket}`;
      await tx.put(key, { ...input, accountId: this.accountId, expiresAt: Math.min(Date.now() + 60_000, authority.expiresAt ?? Infinity) });
      await tx.put(`${devicePrefix(input.deviceId)}${key}`, key);
    });
    return ticket;
  }
  async redeem(ticket: string, hostname: string, state: string | null) {
    const candidate = StoredDeviceSessionSchema.safeParse(await this.storage.get(`service-ticket:${ticket}`));
    if (!candidate.success) return null;
    const authority = await this.currentAuthority(candidate.data.deviceId);
    if (!authority) return null;
    return this.storage.transaction(async tx => {
      const key = `service-ticket:${ticket}`;
      const value = StoredDeviceSessionSchema.safeParse(await tx.get(key));
      if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname || value.data.expiresAt <= Date.now() || !state || value.data.state !== state || !value.data.returnTo || !safeServiceReturn(value.data.returnTo) || await tx.get(`service-revoked:${value.data.deviceId}`)) return null;
      await tx.delete([key, `${devicePrefix(value.data.deviceId)}${key}`]);
      const token = crypto.randomUUID();
      const sessionKey = `service-session:${token}`;
      await tx.put(sessionKey, { accountId: this.accountId, hostname, deviceId: value.data.deviceId, expiresAt: Math.min(Date.now() + SERVICE_SESSION_MS, authority.expiresAt ?? Infinity) });
      await tx.put(`${devicePrefix(value.data.deviceId)}${sessionKey}`, sessionKey);
      return { token, returnTo: value.data.returnTo };
    });
  }
  /** The cloud browser's session for one of its workspace's hostnames, which the caller has checked: the one it holds,
   * now lasting another 8 hours from this mint, or a new one. Keeping the token keeps its open WebSockets. */
  cloud(hostname: string, workspace: ServiceWorkspace): Promise<{ token: string; expiresAt: number }> {
    return this.storage.transaction(async tx => {
      const index = `${cloudPrefix(workspace)}${encodeURIComponent(hostname)}`;
      const held = z.string().uuid().safeParse(await tx.get(index));
      const current = held.success ? StoredSessionSchema.safeParse(await tx.get(`service-session:${held.data}`)) : null;
      const live = held.success && current?.success && 'cloud' in current.data && current.data.hostname === hostname && current.data.expiresAt > Date.now();
      const token = live ? held.data : crypto.randomUUID();
      if (held.success && !live) await tx.delete(`service-session:${held.data}`);
      const expiresAt = Date.now() + SERVICE_SESSION_MS;
      await tx.put(`service-session:${token}`, { accountId: this.accountId, hostname, cloud: { projectId: workspace.projectId, workspaceId: workspace.workspaceId }, expiresAt } satisfies StoredSession);
      await tx.put(index, token);
      return { token, expiresAt };
    });
  }
  /** Ends a workspace's cloud browser sessions: its browser closed, or the workspace left active use. */
  revokeCloud(workspace: ServiceWorkspace): Promise<string[]> {
    return this.storage.transaction(async tx => {
      const removed: string[] = [];
      for (const [index, token] of await tx.list({ prefix: cloudPrefix(workspace) })) {
        const held = z.string().uuid().safeParse(token);
        if (held.success) { await tx.delete(`service-session:${held.data}`); removed.push(held.data); }
        await tx.delete(index);
      }
      return removed;
    });
  }
  async validate(token: string | null, hostname: string): Promise<ServiceSession | null> {
    if (!token) return null;
    const value = StoredSessionSchema.safeParse(await this.storage.get(`service-session:${token}`));
    if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname || value.data.expiresAt <= Date.now()) return null;
    if ('cloud' in value.data) return { sessionId: token, caller: { kind: 'cloud', accountId: this.accountId, ...value.data.cloud }, hostname, expiresAt: value.data.expiresAt };
    const { deviceId } = value.data;
    const authority = await this.currentAuthority(deviceId);
    if (!authority || await this.storage.get(`service-revoked:${deviceId}`) || !await this.storage.get(`service-session:${token}`)) return null;
    return { sessionId: token, caller: { kind: 'device', accountId: this.accountId, deviceId }, hostname, expiresAt: Math.min(value.data.expiresAt, authority.expiresAt ?? Infinity) };
  }
  async logout(token: string | null, hostname: string): Promise<string | null> {
    if (!token) return null;
    return this.storage.transaction(async tx => {
      const key = `service-session:${token}`;
      const value = StoredSessionSchema.safeParse(await tx.get(key));
      if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname) return null;
      await tx.delete([key, sessionIndex(key, value.data)]);
      return token;
    });
  }
  async revokeDevice(deviceId: string): Promise<string[]> {
    this.authorityCache.delete(deviceId);
    await this.storage.put(`service-revoked:${deviceId}`, true);
    const removed: string[] = [];
    // Scan flat records too: sessions written before device indexes require no migration.
    for (const prefix of ['service-ticket:', 'service-session:']) {
      for (const [key, raw] of await this.storage.list({ prefix })) {
        const value = StoredSessionSchema.safeParse(raw);
        if (!value.success || !('deviceId' in value.data) || value.data.deviceId !== deviceId) continue;
        await this.storage.delete([key, `${devicePrefix(deviceId)}${key}`]);
        if (prefix === 'service-session:') removed.push(key.slice(prefix.length));
      }
    }
    for (const key of (await this.storage.list({ prefix: devicePrefix(deviceId) })).keys()) await this.storage.delete(key);
    return removed;
  }
  /** Removes expired sessions and those whose device lost its authority, read afresh: the relay sweeps when the vault
   * changes a credential and when a session's expiry is due. */
  async sweep(): Promise<string[]> {
    this.authorityCache.clear();
    const removed: string[] = [];
    for (const prefix of ['service-ticket:', 'service-session:']) {
      for (const [key, raw] of await this.storage.list({ prefix })) {
        const value = StoredSessionSchema.safeParse(raw);
        if (value.success && value.data.accountId === this.accountId && value.data.expiresAt > Date.now() && ('cloud' in value.data || await this.currentAuthority(value.data.deviceId))) continue;
        await this.storage.delete(value.success ? [key, sessionIndex(key, value.data)] : [key]);
        if (prefix === 'service-session:') removed.push(key.slice(prefix.length));
      }
    }
    return removed;
  }
  async nextExpiry(): Promise<number | null> {
    let next = Infinity;
    for (const prefix of ['service-ticket:', 'service-session:']) {
      for (const raw of (await this.storage.list({ prefix })).values()) {
        const value = StoredSessionSchema.safeParse(raw);
        // Each lasts until it expires; a device's revocation or credential change sweeps it when it happens.
        next = Math.min(next, value.success ? value.data.expiresAt : Date.now());
      }
    }
    return next === Infinity ? null : next;
  }
}
