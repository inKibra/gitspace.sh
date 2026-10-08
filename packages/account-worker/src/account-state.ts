import { DurableObject } from 'cloudflare:workers';
import { RuntimeBrowserAuthorityCertificateBodySchema, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserAuthorityCertificateBody } from '@gitspace/protocol-runtime';
import { runtimeBrowserKey, runtimeBrowserPublicKey } from './runtime-browser.js';
import { ServiceAssertionBodySchema, signServiceAssertion, type ServiceAssertionBody } from '@gitspace/protocol/service-access';
import { z } from 'zod';
import { tenantPlatformJson } from './tenant-platform.js';

// A successful platform observation is authoritative for at most 60 seconds.
// Refresh on use after 15 seconds; outage retries coalesce and wait 5 seconds.
// The original observation time survives reconstruction and is never extended
// by a failed refresh. A new tenant has no authorization until platform confirms it.
const AUTHORITY_REFRESH_MS = 15_000;
const AUTHORITY_MAX_STALE_MS = 60_000;
const AUTHORITY_RETRY_MS = 5_000;
const authoritySchema = z.object({
  accountId: z.string(), tenantId: z.string(), platformUrl: z.string(),
  checkedAt: z.number().finite(), retryAt: z.number().finite(),
  status: z.string().min(1).nullable(),
});
const platformControlSchema = z.object({ control: z.object({ status: z.string().min(1) }) });
export type AccountAuthorization =
  | { status: 'active'; checkedAt: number; refreshAt: number; expiresAt: number }
  | { status: 'blocked' }
  | { status: 'unavailable' };

export interface AccountRecord {
  userId: string;
  handle: string;
  status: 'active' | 'suspended' | 'quarantined';
  reason: string | null;
  createdAt: number;
  updatedAt: number;
  tenantHostname: string;
  tenantRelease: string | null;
  tenantProvisionedAt: number | null;
  lastError: string | null;
}
export class AccountStateDO extends DurableObject<Env> {
 private authorityCheck: Promise<AccountAuthorization> | null = null;

 async authorization(userId: string): Promise<AccountAuthorization> {
   if (userId !== this.env.ACCOUNT_ID) return { status: 'blocked' };
   if (this.authorityCheck) return this.authorityCheck;
   this.authorityCheck = this.readAuthority();
   try { return await this.authorityCheck; }
   finally { this.authorityCheck = null; }
 }

 private async readAuthority(): Promise<AccountAuthorization> {
   const now = Date.now();
   const parsed = authoritySchema.safeParse(await this.ctx.storage.get('platform-authority'));
   let cached = parsed.success && parsed.data.accountId === this.env.ACCOUNT_ID
     && parsed.data.tenantId === this.env.TENANT_ID && parsed.data.platformUrl === this.env.PLATFORM_URL
     && parsed.data.checkedAt <= now && parsed.data.retryAt <= now + AUTHORITY_REFRESH_MS
     ? parsed.data : null;
   if (!cached || now >= cached.retryAt) {
     try {
       const state = platformControlSchema.parse(await tenantPlatformJson<unknown>(this.env, '/state', { signal: AbortSignal.timeout(2_000) }));
       cached = { accountId: this.env.ACCOUNT_ID, tenantId: this.env.TENANT_ID, platformUrl: this.env.PLATFORM_URL, checkedAt: now, retryAt: now + AUTHORITY_REFRESH_MS, status: state.control.status };
     } catch {
       cached = {
         accountId: this.env.ACCOUNT_ID, tenantId: this.env.TENANT_ID, platformUrl: this.env.PLATFORM_URL,
         checkedAt: cached?.checkedAt ?? now, retryAt: Date.now() + AUTHORITY_RETRY_MS, status: cached?.status ?? null,
       };
     }
     await this.ctx.storage.put('platform-authority', cached);
   }
   const expiresAt = cached.checkedAt + AUTHORITY_MAX_STALE_MS;
   if (cached.status === null || Date.now() >= expiresAt) return { status: 'unavailable' };
   return cached.status === 'active'
     ? { status: 'active', checkedAt: cached.checkedAt, refreshAt: Math.min(cached.retryAt, expiresAt), expiresAt }
     : { status: 'blocked' };
 }

 constructor(ctx: DurableObjectState, env: Env) {
   super(ctx, env);
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), created_at INTEGER NOT NULL)');
   this.ctx.storage.sql.exec('INSERT OR IGNORE INTO account_identity(singleton,created_at) VALUES(1,?)', Date.now());
 }
 get(userId: string): AccountRecord | null {
   if (userId !== this.env.ACCOUNT_ID) return null;
   const createdAt = this.ctx.storage.sql.exec<{ created_at: number }>('SELECT created_at FROM account_identity WHERE singleton=1').one().created_at;
   return { userId, handle: this.env.TENANT_ID, status: 'active', reason: null, createdAt, updatedAt: createdAt, tenantHostname: new URL(this.env.RELAY_URL).hostname, tenantRelease: null, tenantProvisionedAt: createdAt, lastError: null };
 }
 getByHandle(handle: string): AccountRecord | null { return handle === this.env.TENANT_ID ? this.get(this.env.ACCOUNT_ID) : null; }
 async browserTrust() {
   return { accountId: this.env.ACCOUNT_ID, ...await runtimeBrowserPublicKey(this.ctx.storage) };
 }
 async signServiceRequest(raw: ServiceAssertionBody) {
   const body = ServiceAssertionBodySchema.parse(raw);
   const now = Date.now();
   if (body.accountId !== this.env.ACCOUNT_ID || body.caller.accountId !== this.env.ACCOUNT_ID || body.issuedAt > now + 5000 || body.expiresAt <= now || body.expiresAt - body.issuedAt > 60_000) throw new Error('Invalid service assertion');
   return signServiceAssertion(body, (await runtimeBrowserKey(this.ctx.storage)).privateKey);
 }
 async certifyBrowserAuthority(raw: RuntimeBrowserAuthorityCertificateBody) {
   const body = RuntimeBrowserAuthorityCertificateBodySchema.parse(raw);
   const now = Date.now();
   if (body.accountId !== this.env.ACCOUNT_ID || Date.parse(body.issuedAt) > now + 5000 || Date.parse(body.expiresAt) <= now || Date.parse(body.expiresAt) > now + 24 * 60 * 60_000) throw new Error('Invalid workspace browser authority');
   return signRuntimeBrowserAuthorityCertificate(body, (await runtimeBrowserKey(this.ctx.storage)).privateKey);
 }
}
