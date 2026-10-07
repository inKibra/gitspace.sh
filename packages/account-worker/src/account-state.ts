import { DurableObject } from 'cloudflare:workers';
import { RuntimeBrowserAuthorityCertificateBodySchema, signRuntimeBrowserAuthorityCertificate, type RuntimeBrowserAuthorityCertificateBody } from '@gitspace/protocol-runtime';
import { runtimeBrowserKey, runtimeBrowserPublicKey } from './runtime-browser.js';
import { ServiceAssertionBodySchema, signServiceAssertion, type ServiceAssertionBody } from '@gitspace/protocol/service-access';
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
