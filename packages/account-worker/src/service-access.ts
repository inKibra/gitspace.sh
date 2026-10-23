import { SERVICE_ASSERTION_HEADER, ServiceCallerSchema, stripGitSpaceCredentials, type ServiceCaller } from '@gitspace/protocol/service-access';
import type { HostedRouteTarget } from './hosted-route-registry.js';
import { forwardTunnelRequest, INTERNAL_SIGNED_TARGET, INTERNAL_SERVICE_SESSION } from './relay-request.js';
import { ServiceSessionSchema, sameServiceCaller, type ServiceSession } from './service-sessions.js';

export function isHostedServiceHostname(env: Pick<Env, 'TENANT_ID'>, hostname: string): boolean {
  return hostname.endsWith(`--${env.TENANT_ID}-srv.gssh.dev`);
}

/** A CDP `Fetch` URL pattern covering every hosted service URL. Its wildcards also match paths, so it only narrows. */
export function hostedServiceUrlPattern(env: Pick<Env, 'TENANT_ID'>): string {
  return `*://*--${env.TENANT_ID}-srv.gssh.dev/*`;
}

/** Whether `hostname` is a hosted service of `workspace` with a live route: the services its cloud browser may reach.
 * `scope` is the browser group's workspace, which must be that workspace. */
export async function isWorkspaceServiceHostname(env: Env, workspace: { projectId: string; workspaceId: string }, hostname: string, scope: { projectId: string; workspaceId: string }): Promise<boolean> {
  if (!isHostedServiceHostname(env, hostname) || scope.projectId !== workspace.projectId || scope.workspaceId !== workspace.workspaceId) return false;
  const route = await env.HOSTED_ROUTES.getByName(hostname).get();
  return !!route && route.tenant === env.ACCOUNT_ID && route.workspaceId === scope.workspaceId && Date.parse(route.leaseExpiresAt) > Date.now();
}

/** Internal callers supply identity established by their owner, never request headers. A caller that already resolved the hostname passes its target. */
export async function fetchInternalService(env: Env, rawCaller: ServiceCaller, request: Request, session?: ServiceSession, resolved?: HostedRouteTarget): Promise<Response> {
  const caller = ServiceCallerSchema.parse(rawCaller);
  const url = new URL(request.url);
  if (caller.accountId !== env.ACCOUNT_ID || !isHostedServiceHostname(env, url.hostname) || !['https:', 'http:'].includes(url.protocol) || url.port || url.username || url.password) return new Response('Service access denied', { status: 403 });
  const registry = env.HOSTED_ROUTES.getByName(url.hostname);
  const route = resolved ? resolved.route : await registry.get();
  if (!route || route.tenant !== env.ACCOUNT_ID || Date.parse(route.leaseExpiresAt) <= Date.now()) {
    const offline = resolved ? resolved.offline : await registry.offline();
    return offline && offline.tenant === env.ACCOUNT_ID ? new Response(`Service is offline on ${offline.machine}`, { status: 503 }) : new Response('Service route unavailable', { status: 404 });
  }
  if ((caller.kind === 'cloud' || caller.kind === 'ingress') && caller.workspaceId !== route.workspaceId) return new Response('Service workspace mismatch', { status: 403 });
  const target = `${url.pathname}${url.search}`;
  const headers = new Headers(request.headers);
  headers.delete(INTERNAL_SERVICE_SESSION);
  if (session) {
    const metadata = ServiceSessionSchema.parse(session);
    if (!sameServiceCaller(metadata.caller, caller) || metadata.hostname !== url.hostname || metadata.expiresAt <= Date.now()) return new Response('Service session mismatch', { status: 403 });
    headers.set(INTERNAL_SERVICE_SESSION, JSON.stringify(metadata));
  }
  stripGitSpaceCredentials(headers);
  headers.delete('x-gitspace-device');
  headers.delete('x-gitspace-machine-grant');
  headers.delete('x-gitspace-websocket-probe');
  headers.set('x-forwarded-host', url.hostname);
  headers.set(INTERNAL_SIGNED_TARGET, target);
  headers.set(SERVICE_ASSERTION_HEADER, await env.ACCOUNT_STATE.getByName(env.ACCOUNT_ID).signServiceRequest({ version: 1, accountId: env.ACCOUNT_ID, hostname: url.hostname, machineId: route.machineId, caller, method: request.method, target, issuedAt: Date.now(), expiresAt: Date.now() + 30_000, nonce: crypto.randomUUID() }));
  url.pathname = `/tunnel/${encodeURIComponent(route.machineId)}${url.pathname}`;
  return forwardTunnelRequest(new Request(url, { method: request.method, headers, body: request.body, redirect: 'manual', signal: request.signal }), env, { machineId: route.machineId, path: target });
}
