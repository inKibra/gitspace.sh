import { env } from 'cloudflare:workers';
import { expect, test } from 'vitest';
import { servicesBlock } from '../src/workspace-service-urls.js';

test('the instructions list a workspace’s running services at their workspace URLs with the machine serving each, and say nothing with none', async () => {
  const projectId = `services-${crypto.randomUUID()}`;
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${projectId}`);
  await project.setProjectLifecycle((await project.bootstrap({ id: projectId, name: 'Services', repositoryReference: null, baseBranch: 'main', createdBy: 'machine' })).revision, 'active');
  expect(servicesBlock((await project.instructionContext('workspace')).services)).toBe('');
  const now = new Date().toISOString(), leaseExpiresAt = new Date(Date.now() + 600_000).toISOString();
  const route = (hostname: string, workspaceId: string, port: number) => ({ hostname, workspaceId, serviceName: 'web', source: 'declared' as const, machineId: 'machine-1', ingress: `http://127.0.0.1:${port}`, portName: 'http', port, generation: 1, leaseExpiresAt, health: 'healthy' as const });
  const web = `web--workspace--${env.TENANT_ID}-srv.gssh.dev`;
  await project.leaseHostedRoute(route(web, 'workspace', 5173), { hostname: web, workspaceId: 'workspace', machineId: 'machine-1', machineLabel: 'Darktop', serviceName: 'web', source: 'declared', portName: 'http', setAt: now, setBy: 'start' });
  // Another workspace's service and a machine URL are not this workspace's service URLs.
  await project.leaseHostedRoute(route(`web--other--${env.TENANT_ID}-srv.gssh.dev`, 'other', 5174), null);
  await project.leaseHostedRoute(route(`web--machine-1--workspace--${env.TENANT_ID}-srv.gssh.dev`, 'workspace', 5173), null);
  expect(servicesBlock((await project.instructionContext('workspace')).services)).toBe(`Services of this workspace (open these URLs in the cloud browser; it cannot reach localhost):\n- web: https://${web} (port 5173 on Darktop)`);
});
