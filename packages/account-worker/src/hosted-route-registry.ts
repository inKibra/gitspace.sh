import { DurableObject } from 'cloudflare:workers';
import type { HostedServiceRoute } from '@gitspace/protocol';

interface HostedRouteRow extends Record<string, SqlStorageValue> {
  tenant: string;
  route_json: string;
  lease_expires_at: string;
}

export interface ResolvedHostedRoute extends HostedServiceRoute {
  tenant: string;
}

export class HostedRouteRegistryDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(`
        CREATE TABLE IF NOT EXISTS active_route (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          tenant TEXT NOT NULL,
          route_json TEXT NOT NULL,
          lease_expires_at TEXT NOT NULL
        )
      `);
    });
  }

  lease(tenant: string, route: HostedServiceRoute): ResolvedHostedRoute {
    if (route.leaseExpiresAt <= new Date().toISOString()) throw new Error('Hosted route lease must expire in the future');
    this.ctx.storage.sql.exec(
      `INSERT INTO active_route(id, tenant, route_json, lease_expires_at) VALUES (1, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET tenant=excluded.tenant, route_json=excluded.route_json, lease_expires_at=excluded.lease_expires_at`,
      tenant,
      JSON.stringify(route),
      route.leaseExpiresAt,
    );
    return { tenant, ...route };
  }

  get(now = new Date().toISOString()): ResolvedHostedRoute | null {
    const row = this.ctx.storage.sql.exec<HostedRouteRow>(
      'SELECT tenant, route_json, lease_expires_at FROM active_route WHERE id=1 AND lease_expires_at>?',
      now,
    ).toArray()[0];
    return row ? { tenant: row.tenant, ...JSON.parse(row.route_json) as HostedServiceRoute } : null;
  }

  release(tenant: string, machineId: string): boolean {
    return this.ctx.storage.sql.exec(
      `DELETE FROM active_route
       WHERE id=1 AND tenant=? AND json_extract(route_json, '$.machineId')=?
       RETURNING id`,
      tenant,
      machineId,
    ).toArray().length > 0;
  }
}
