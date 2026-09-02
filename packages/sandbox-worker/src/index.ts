import { getSandbox, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { sandboxObjectId, type SandboxMachineRecord } from './provision.js';

export * from './provision.js';

interface ManagedEnrollment { userId: string; machineId: string; environment: Record<string, string> }
const ENROLLMENT_KEY = 'gitspace:managed-enrollment';
const MACHINE_KEY = 'gitspace:machine-record';

export class GitSpaceSandbox extends CloudflareSandbox<Env> {
  async enrollMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    await this.ctx.storage.put(ENROLLMENT_KEY, input);
    return this.startMachine(input);
  }

  async statusMachine(): Promise<SandboxMachineRecord> {
    const input = await this.requireEnrollment();
    const previous = await this.ctx.storage.get<SandboxMachineRecord>(MACHINE_KEY);
    const process = await this.getProcess('gitspace-machine');
    if (process?.status === 'running' && previous?.rpcEndpoint) return { ...previous, state: 'online', error: null };
    return this.record(input, 'offline', null, 'Managed Cloudflare Sandbox is not running.', previous?.desiredState === 'online' ? 'online' : 'offline');
  }

  async resumeMachine(): Promise<SandboxMachineRecord> {
    const input = await this.requireEnrollment();
    return this.startMachine(input);
  }

  async sleepMachine(): Promise<SandboxMachineRecord> {
    const input = await this.requireEnrollment();
    await this.stop('SIGTERM');
    return this.record(input, 'offline', null, 'Managed Cloudflare Sandbox sleeping.', 'offline');
  }

  async destroyMachine(): Promise<{ machineId: string }> {
    const input = await this.requireEnrollment();
    await this.destroy();
    return { machineId: input.machineId };
  }

  private async startMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    const readiness = await this.exec('git --version && bun --version');
    if (!readiness.success || readiness.exitCode !== 0) throw new Error(readiness.stderr.trim() || 'Cloudflare Sandbox failed its GitSpace readiness probe');
    const exposed = await this.exposePort(8081, { hostname: this.env.SANDBOX_HOSTNAME, name: 'gitspace-rpc' });
    const rpcEndpoint = new URL('/rpc', exposed.url).toString();
    const existing = await this.getProcess('gitspace-machine');
    const process = existing?.status === 'running' ? existing : await this.startProcess('bun /opt/gitspace/host.js', {
      processId: 'gitspace-machine',
      autoCleanup: false,
      env: { ...input.environment, GITSPACE_PUBLIC_RPC_URL: rpcEndpoint },
    });
    await process.waitForLog(/GitSpace RPC ready/u, 120_000);
    await process.waitForPort(8081, { mode: 'tcp' });
    const probe = await this.exec('bun /opt/gitspace/rpc-probe.js http://127.0.0.1:8081/rpc');
    if (!probe.success || probe.exitCode !== 0) throw new Error(probe.stderr.trim() || 'GitSpace machine RPC probe failed');
    return this.record(input, 'online', rpcEndpoint, 'Managed Cloudflare Sandbox. GitSpace machine runtime enrolled and ready.', 'online');
  }

  private async requireEnrollment(): Promise<ManagedEnrollment> {
    const input = await this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY);
    if (!input) throw new Error('Sandbox machine is not enrolled');
    return input;
  }
  private async record(input: ManagedEnrollment, state: 'online' | 'offline', rpcEndpoint: string | null, notes: string, desiredState: 'online' | 'offline'): Promise<SandboxMachineRecord> {
    const previous = await this.ctx.storage.get<SandboxMachineRecord>(MACHINE_KEY);
    const record: SandboxMachineRecord = {
      id: input.machineId,
      label: `Cloudflare ${input.machineId.slice('sandbox-'.length)}`,
      state,
      rpcEndpoint,
      kind: 'sandbox',
      provider: 'cloudflare-sandbox',
      notes,
      desiredState,
      lifecycleRevision: (previous?.lifecycleRevision ?? 0) + 1,
      operationId: null,
      error: null,
    };
    await this.ctx.storage.put(MACHINE_KEY, record);
    return record;
  }
}
async function sandbox(env: Env, userId: string, machineId: string): Promise<GitSpaceSandbox> {
  const namespace = env.Sandbox as DurableObjectNamespace<GitSpaceSandbox>;
  return getSandbox(namespace, await sandboxObjectId(userId, machineId), { normalizeId: true, labels: { userId, machineId, product: 'gitspace' } });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const lifecycle = /^\/v1\/sandboxes\/([^/]+)\/(status|sleep|resume|destroy)$/u.exec(url.pathname);
    const rpc = /^\/v1\/sandboxes\/([^/]+)\/rpc$/u.exec(url.pathname);
    try {
      if (rpc && request.method === 'POST') {
        const userId = request.headers.get('x-gitspace-user-id');
        if (!userId) throw new Error('Sandbox user id is required');
        const stub = await sandbox(env, userId, rpc[1]!);
        return stub.containerFetch('http://localhost/rpc', {
          method: 'POST',
          headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
          body: await request.arrayBuffer(),
        }, 8081);
      }
      if (url.pathname === '/v1/sandboxes' && request.method === 'POST') {
        const body = await request.json() as Partial<ManagedEnrollment>;
        if (typeof body.userId !== 'string' || typeof body.machineId !== 'string' || !body.environment || typeof body.environment !== 'object' || Array.isArray(body.environment)) throw new Error('Sandbox request is invalid');
        const machine = await (await sandbox(env, body.userId, body.machineId)).enrollMachine({ userId: body.userId, machineId: body.machineId, environment: body.environment });
        return Response.json({ status: 'ok', machine });
      }
      if (lifecycle && request.method === 'POST') {
        const userId = request.headers.get('x-gitspace-user-id');
        if (!userId) throw new Error('Sandbox user id is required');
        const stub = await sandbox(env, userId, lifecycle[1]!);
        const action = lifecycle[2];
        const value = action === 'status' ? await stub.statusMachine() : action === 'sleep' ? await stub.sleepMachine() : action === 'resume' ? await stub.resumeMachine() : await stub.destroyMachine();
        return Response.json({ status: 'ok', value });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json({ status: 'error', error: error instanceof Error ? error.message : 'Sandbox lifecycle failed' }, { status: 400 });
    }
  },
} satisfies ExportedHandler<Env>;
