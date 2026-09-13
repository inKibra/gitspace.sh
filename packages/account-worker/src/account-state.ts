import { DurableObject } from 'cloudflare:workers';
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
export interface SandboxRollout {
  id: string;
  image: string;
  startedAt: number;
  prepared: boolean;
  recovering: boolean;
  machines: Array<{ userId: string; machineId: string }>;
}
export class AccountStateDO extends DurableObject<Env> {
 constructor(ctx: DurableObjectState, env: Env) {
   super(ctx, env);
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS sandbox_rollout (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), state_json TEXT NOT NULL)');
   this.ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS account_identity (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), created_at INTEGER NOT NULL)');
   this.ctx.storage.sql.exec('INSERT OR IGNORE INTO account_identity(singleton,created_at) VALUES(1,?)', Date.now());
 }
 get(userId: string): AccountRecord | null {
   if (userId !== this.env.ACCOUNT_ID) return null;
   const createdAt = this.ctx.storage.sql.exec<{ created_at: number }>('SELECT created_at FROM account_identity WHERE singleton=1').one().created_at;
   return { userId, handle: this.env.TENANT_ID, status: 'active', reason: null, createdAt, updatedAt: createdAt, tenantHostname: new URL(this.env.RELAY_URL).hostname, tenantRelease: null, tenantProvisionedAt: createdAt, lastError: null };
 }
 getByHandle(handle: string): AccountRecord | null { return handle === this.env.TENANT_ID ? this.get(this.env.ACCOUNT_ID) : null; }
 sandboxRollout(): SandboxRollout | null {
    const row = this.ctx.storage.sql.exec<{ state_json: string }>('SELECT state_json FROM sandbox_rollout WHERE singleton = 1').toArray()[0];
    return row ? JSON.parse(row.state_json) as SandboxRollout : null;
  }
private saveSandboxRollout(rollout: SandboxRollout): void {
    this.ctx.storage.sql.exec('INSERT INTO sandbox_rollout (singleton, state_json) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET state_json = excluded.state_json', JSON.stringify(rollout));
  }
beginSandboxRollout(id: string, image: string): SandboxRollout {
    const existing = this.sandboxRollout();
    if (existing) {
      if (existing.id !== id || existing.image !== image) throw new Error('Another sandbox rollout is active');
      if (existing.prepared) return existing;
      if (existing.recovering) throw new Error('Sandbox rollout recovery is in progress');
      return existing;
    }
    const rollout: SandboxRollout = { id, image, startedAt: Date.now(), prepared: false, recovering: false, machines: [] };
    this.saveSandboxRollout(rollout);
    return rollout;
  }
sandboxRolloutAccounts(): Array<{ userId: string }> {
    return [{ userId: this.env.ACCOUNT_ID }];
  }
recordSandboxPrepared(id: string, machines: SandboxRollout['machines']): void {
    const rollout = this.sandboxRollout();
    if (!rollout || rollout.id !== id) throw new Error('Rollout identity does not match');
    for (const machine of machines) {
      if (!rollout.machines.some(existing => existing.userId === machine.userId && existing.machineId === machine.machineId)) rollout.machines.push(machine);
    }
    this.saveSandboxRollout(rollout);
  }
markSandboxRolloutPrepared(id: string): SandboxRollout {
    const rollout = this.sandboxRollout();
    if (!rollout || rollout.id !== id || rollout.recovering) throw new Error('Rollout identity or phase does not match');
    rollout.prepared = true;
    this.saveSandboxRollout(rollout);
    return rollout;
  }
finishSandboxRollout(id: string): void {
    const rollout = this.sandboxRollout();
    if (!rollout || rollout.id !== id || !rollout.prepared || !rollout.recovering) throw new Error('Rollout has not finished preparing and resuming');
    this.ctx.storage.sql.exec('DELETE FROM sandbox_rollout WHERE singleton = 1');
  }
beginSandboxRolloutRecovery(id: string, finishing: boolean): void {
    const rollout = this.sandboxRollout();
    if (!rollout || rollout.id !== id) throw new Error('Rollout identity does not match');
    if (finishing && !rollout.prepared) throw new Error('Rollout has not finished preparing');
    rollout.recovering = true;
    if (!finishing) rollout.prepared = false;
    this.saveSandboxRollout(rollout);
  }
cancelSandboxRollout(id: string): void {
    const rollout = this.sandboxRollout();
    if (!rollout || rollout.id !== id || !rollout.recovering) throw new Error('Rollout identity or phase does not match');
    this.ctx.storage.sql.exec('DELETE FROM sandbox_rollout WHERE singleton = 1');
  }
}
