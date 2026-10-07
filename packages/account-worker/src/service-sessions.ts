import { z } from 'zod';
const StoredSessionSchema = z.object({ accountId: z.string(), hostname: z.string(), deviceId: z.string(), expiresAt: z.number(), state: z.string().optional(), returnTo: z.string().optional() });
export const ServiceSessionSchema = z.object({ sessionId: z.string().uuid(), deviceId: z.string(), hostname: z.string(), expiresAt: z.number() });
export type ServiceSession = z.infer<typeof ServiceSessionSchema>;
export type ServiceDeviceAuthority = { expiresAt: number | null };
export const SERVICE_COOKIE = '__Host-gitspace-service';
export const SERVICE_STATE_COOKIE = '__Host-gitspace-service-state';
const AUTHORITY_CACHE_MS = 5_000;
function devicePrefix(deviceId: string): string { return `service-device:${encodeURIComponent(deviceId)}:`; }
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
    const candidate = StoredSessionSchema.safeParse(await this.storage.get(`service-ticket:${ticket}`));
    if (!candidate.success) return null;
    const authority = await this.currentAuthority(candidate.data.deviceId);
    if (!authority) return null;
    return this.storage.transaction(async tx => {
      const key = `service-ticket:${ticket}`;
      const value = StoredSessionSchema.safeParse(await tx.get(key));
      if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname || value.data.expiresAt <= Date.now() || !state || value.data.state !== state || !value.data.returnTo || !safeServiceReturn(value.data.returnTo) || await tx.get(`service-revoked:${value.data.deviceId}`)) return null;
      await tx.delete([key, `${devicePrefix(value.data.deviceId)}${key}`]);
      const token = crypto.randomUUID();
      const sessionKey = `service-session:${token}`;
      await tx.put(sessionKey, { accountId: this.accountId, hostname, deviceId: value.data.deviceId, expiresAt: Math.min(Date.now() + 15 * 60_000, authority.expiresAt ?? Infinity) });
      await tx.put(`${devicePrefix(value.data.deviceId)}${sessionKey}`, sessionKey);
      return { token, returnTo: value.data.returnTo };
    });
  }
  async validate(token: string | null, hostname: string): Promise<ServiceSession | null> {
    if (!token) return null;
    const value = StoredSessionSchema.safeParse(await this.storage.get(`service-session:${token}`));
    if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname || value.data.expiresAt <= Date.now()) return null;
    const authority = await this.currentAuthority(value.data.deviceId);
    if (!authority || await this.storage.get(`service-revoked:${value.data.deviceId}`) || !await this.storage.get(`service-session:${token}`)) return null;
    return { sessionId: token, deviceId: value.data.deviceId, hostname, expiresAt: Math.min(value.data.expiresAt, authority.expiresAt ?? Infinity) };
  }
  async logout(token: string | null, hostname: string): Promise<string | null> {
    if (!token) return null;
    return this.storage.transaction(async tx => {
      const key = `service-session:${token}`;
      const value = StoredSessionSchema.safeParse(await tx.get(key));
      if (!value.success || value.data.accountId !== this.accountId || value.data.hostname !== hostname) return null;
      await tx.delete([key, `${devicePrefix(value.data.deviceId)}${key}`]);
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
        if (!value.success || value.data.deviceId !== deviceId) continue;
        await this.storage.delete([key, `${devicePrefix(deviceId)}${key}`]);
        if (prefix === 'service-session:') removed.push(key.slice(prefix.length));
      }
    }
    for (const key of (await this.storage.list({ prefix: devicePrefix(deviceId) })).keys()) await this.storage.delete(key);
    return removed;
  }
  async sweep(): Promise<string[]> {
    const removed: string[] = [];
    for (const prefix of ['service-ticket:', 'service-session:']) {
      for (const [key, raw] of await this.storage.list({ prefix })) {
        const value = StoredSessionSchema.safeParse(raw);
        if (value.success && value.data.accountId === this.accountId && value.data.expiresAt > Date.now() && await this.currentAuthority(value.data.deviceId)) continue;
        await this.storage.delete(value.success ? [key, `${devicePrefix(value.data.deviceId)}${key}`] : [key]);
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
        next = Math.min(next, value.success ? value.data.expiresAt : Date.now(), Date.now() + AUTHORITY_CACHE_MS);
      }
    }
    return next === Infinity ? null : next;
  }
}
