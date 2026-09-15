import { getSandbox, Sandbox as CloudflareSandbox } from '@cloudflare/sandbox';
import { sandboxObjectId, type SandboxMachineRecord } from './provision.js';

export * from './provision.js';

interface ManagedEnrollment { userId: string; machineId: string; environment: Record<string, string> }
interface ProviderEnv extends Env { PROVIDER_ACCOUNT_ID?: string; PROVIDER_IMAGE?: string }
const ENROLLMENT_KEY = 'gitspace:managed-enrollment';
const MACHINE_KEY = 'gitspace:machine-record';
const IMAGE_STATE_KEY = 'gitspace:image-state';
interface ImageState {
  operationId: string | null;
  prepared: boolean;
  checkpointPrepared: boolean;
  runtimeStarted: boolean | null;
  inherited: boolean;
  retired: boolean;
  transferOperationId: string | null;
  discardReceipt: { machineId: string; operationId: string | null; recoveryOperationId: string; stopped: true } | null;
}


export class GitSpaceSandbox extends CloudflareSandbox<ProviderEnv> {
  private machineStart: Promise<SandboxMachineRecord> | null = null;
  private providerControl: Promise<unknown> = Promise.resolve();

  private controlled<T>(action: () => Promise<T>): Promise<T> {
    const result = this.providerControl.then(action, action);
    this.providerControl = result.then(() => undefined, () => undefined);
    return result;
  }
  private async imageState(): Promise<ImageState> {
    return await this.ctx.storage.get<ImageState>(IMAGE_STATE_KEY) ?? {
      operationId: null, prepared: false, checkpointPrepared: false, runtimeStarted: null,
      inherited: false, retired: false, transferOperationId: null, discardReceipt: null,
    };
  }
  private async healthy(): Promise<boolean> {
    if (!this.ctx.container?.running) return false;
    try {
      const response = await this.ctx.container.getTcpPort(8081).fetch(new Request('http://localhost/health', { signal: AbortSignal.timeout(5_000) }));
      return response.ok && (await response.json() as { status?: string }).status === 'ok';
    } catch { return false; }
  }

  async preflightImage(): Promise<Response> {
    return this.controlled(async () => {
      try {
        const check = await this.exec('command -v bun >/dev/null && bun --version >/dev/null && test -r /opt/gitspace/host.js && test -r /opt/gitspace/rpc-probe.js', { timeout: 30_000 });
        if (!check.success || check.exitCode !== 0) return Response.json({ status: 'error', error: { code: 'IMAGE_BOOTSTRAP_MISSING', message: 'Image must provide compatible Bun, /opt/gitspace/host.js, and /opt/gitspace/rpc-probe.js' } }, { status: 409 });
        return Response.json({ status: 'ok' });
      } finally { await this.destroy(); }
    });
  }

  async imageStatus(): Promise<Response> {
    await this.requireEnrollment();
    const state = await this.imageState();
    return Response.json({ status: 'ok', value: { image: this.env.PROVIDER_IMAGE ?? null, operationId: state.operationId, prepared: state.prepared, runtimeStarted: state.runtimeStarted } });
  }

  async stageEnrollment(input: ManagedEnrollment, operationId: string): Promise<Response> {
    return this.controlled(async () => {
      const previous = await this.imageState();
      if (previous.retired) throw new Error('Retired image instance cannot accept enrollment');
      const existing = await this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY);
      if (existing) {
        if (existing.userId !== input.userId || existing.machineId !== input.machineId || previous.operationId !== operationId) throw new Error('Image destination is already owned by another enrollment or operation');
        return Response.json({ status: 'ok' });
      }
      const state: ImageState = { operationId, prepared: true, checkpointPrepared: false, runtimeStarted: false,
        inherited: true, retired: false, transferOperationId: null, discardReceipt: null };
      await this.ctx.storage.put({ [ENROLLMENT_KEY]: input, [IMAGE_STATE_KEY]: state });
      return Response.json({ status: 'ok' });
    });
  }

  async exportPreparedEnrollment(operationId: string): Promise<Response> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      this.requirePreparedTransfer(state, operationId);
      return Response.json(input, { headers: { 'cache-control': 'no-store' } });
    });
  }

  private requirePreparedTransfer(state: ImageState, operationId: string): void {
    if (!state.prepared || !(state.checkpointPrepared || (state.inherited && state.runtimeStarted === false)
      || state.discardReceipt?.recoveryOperationId === operationId)) throw new Error('Machine has no durable checkpoint or explicitly discarded recovery receipt');
    if (state.retired && state.transferOperationId !== operationId && state.discardReceipt?.recoveryOperationId !== operationId) {
      throw new Error('Machine was retired by another image operation');
    }
  }

  async retirePrepared(operationId: string): Promise<Response> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      this.requirePreparedTransfer(state, operationId);
      state.retired = true;
      state.transferOperationId = operationId;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Source container has not stopped');
      await this.record(input, 'offline', null, 'Checkpointed machine handed off to its selected image.', 'online');
      return Response.json({ status: 'ok', value: { machineId: input.machineId, retired: true } });
    });
  }

  async discardCandidate(operationId: string | null, recoveryOperationId: string): Promise<Response> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.operationId !== operationId) throw new Error('Candidate image operation changed');
      if (state.discardReceipt && (state.discardReceipt.operationId !== operationId || state.discardReceipt.recoveryOperationId !== recoveryOperationId)) {
        throw new Error('Candidate has a different discard receipt');
      }
      state.retired = true;
      state.transferOperationId = recoveryOperationId;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Candidate container has not stopped');
      state.prepared = true;
      state.discardReceipt = { machineId: input.machineId, operationId, recoveryOperationId, stopped: true };
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.record(input, 'offline', null, 'Candidate disk discarded by explicit tenant recovery authorization.', 'online');
      return Response.json({ status: 'ok', value: state.discardReceipt });
    });
  }

  async enrollMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    return this.controlled(async () => {
      const existing = await this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY);
      if (existing) {
        if (existing.userId !== input.userId || existing.machineId !== input.machineId) throw new Error('Machine enrollment identity changed');
        return this.startMachine(existing);
      }
      if ((await this.imageState()).retired) throw new Error('Destroyed machine cannot accept late enrollment');
      const state: ImageState = { operationId: null, prepared: false, checkpointPrepared: false, runtimeStarted: false,
        inherited: false, retired: false, transferOperationId: null, discardReceipt: null };
      await this.ctx.storage.put({ [ENROLLMENT_KEY]: input, [IMAGE_STATE_KEY]: state });
      return this.startMachine(input);
    });
  }

  async statusMachine(): Promise<SandboxMachineRecord> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const previous = await this.ctx.storage.get<SandboxMachineRecord>(MACHINE_KEY);
      const state = await this.imageState();
      // Serialize the observation with retirement: a late health response must not republish a stopped disk as online.
      if (state.retired || (previous?.state === 'offline' && previous.desiredState === 'offline')) {
        return previous ?? this.record(input, 'offline', null, 'Cloud machine is stopped.', 'offline');
      }
      if (previous?.rpcEndpoint && await this.healthy()) {
        return this.record(input, 'online', previous.rpcEndpoint, 'Managed Cloudflare Sandbox. GitSpace machine runtime enrolled and ready.', 'online');
      }
      return this.record(input, 'offline', previous?.rpcEndpoint ?? null, 'Managed Cloudflare Sandbox is starting or unavailable.', previous?.desiredState === 'online' ? 'online' : 'offline');
    });
  }

  async rpc(request: Request): Promise<Response> {
    const machine = await this.ctx.storage.get<SandboxMachineRecord>(MACHINE_KEY);
    const container = this.ctx.container;
    if (machine?.desiredState !== 'online' || !container?.running) {
      return Response.json({ error: { code: 'MACHINE_OFFLINE', message: 'The cloud machine is not running. Resume it explicitly before sending RPC.' } }, { status: 503 });
    }
    // SDK containerFetch starts stopped containers (and can retry). Inspection
    // must remain passive even if a holder stops after the fleet snapshot.
    return container.getTcpPort(8081).fetch(request);
  }

  async prepareReplacement(): Promise<Response> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.inherited && state.runtimeStarted === false) {
        return Response.json({ prepared: true, machineId: input.machineId });
      }
      if (state.retired) throw new Error('Machine is already retired; reconcile its image operation');
      const token = input.environment.GITSPACE_CONTROL_TOKEN;
      if (!token) return Response.json({ error: 'Machine has no replacement control credential' }, { status: 409 });
      const response = await this.containerFetch('http://localhost/__control/prepare-replacement', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      }, 8081);
      if (response.ok) {
        const result = await response.clone().json() as { prepared?: boolean; machineId?: string };
        if (result.prepared !== true || result.machineId !== input.machineId) throw new Error('Machine returned an invalid preparation receipt');
        state.prepared = true;
        state.checkpointPrepared = true;
        await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      }
      return response;
    });
  }

  async cancelReplacement(): Promise<Response> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.retired || state.inherited) throw new Error('Image handoff cannot be cancelled on this container');
      const token = input.environment.GITSPACE_CONTROL_TOKEN;
      if (!token) return Response.json({ prepared: false, machineId: input.machineId });
      const response = await this.containerFetch('http://localhost/__control/cancel-replacement', {
        method: 'POST', headers: { authorization: `Bearer ${token}` },
      }, 8081);
      if (response.ok) {
        state.prepared = false;
        state.checkpointPrepared = false;
        await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      }
      return response;
    });
  }

  async resumeMachine(): Promise<SandboxMachineRecord> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.retired || state.checkpointPrepared) throw new Error('Prepared source must be cancelled or handed off before resuming');
      const record = await this.startMachine(input);
      const deadline = Date.now() + 120_000;
      while (Date.now() < deadline) {
        if (await this.healthy()) {
          const current = await this.imageState();
          current.prepared = false;
          current.inherited = false;
          await this.ctx.storage.put(IMAGE_STATE_KEY, current);
          return this.record(input, 'online', record.rpcEndpoint, 'Selected cloud image is ready.', 'online');
        }
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 500);
        await pause.promise;
      }
      throw new Error('Selected image has not become healthy; its admission barrier remains active');
    });
  }

  async sleepMachine(): Promise<SandboxMachineRecord> {
    return this.controlled(async () => {
      const input = await this.requireEnrollment();
      await this.stop('SIGTERM');
      // SDK stop sends the signal; a queued resume must not race the VM's eventual exit.
      const deadline = Date.now() + 120_000;
      while (this.ctx.container?.running) {
        if (Date.now() >= deadline) throw new Error('Cloud machine has not stopped; its checkpoint remains prepared');
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 500);
        await pause.promise;
      }
      const state = await this.imageState();
      state.prepared = false;
      state.checkpointPrepared = false;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      return this.record(input, 'offline', null, 'Temporary cloud machine stopped.', 'offline');
    });
  }

  async destroyMachine(machineId: string): Promise<{ machineId: string }> {
    return this.controlled(async () => {
      if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(machineId)) throw new Error('Sandbox machine id is invalid');
      const input = await this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY);
      if (input && input.machineId !== machineId) throw new Error('Machine destruction identity changed');
      const state = await this.imageState();
      state.retired = true;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Cloud machine has not stopped');
      await this.ctx.storage.delete([ENROLLMENT_KEY, MACHINE_KEY]);
      return { machineId };
    });
  }

  private startMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    this.machineStart ??= this.launchMachine(input).finally(() => { this.machineStart = null; });
    return this.machineStart;
  }

  private async launchMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    const state = await this.imageState();
    if (state.retired) throw new Error('Retired image instance cannot be restarted');
    // A custom ENTRYPOINT/CMD can run tenant code before host.js. Fence even an uncertain VM-start request.
    state.runtimeStarted = true;
    await this.ctx.storage.put(IMAGE_STATE_KEY, state);
    await this.startAndWaitForPorts({ ports: 3000 });
    await this.exposePort(8081, { hostname: this.env.SANDBOX_HOSTNAME, name: 'gitspace-rpc' });
    const controlUrl = input.environment.GITSPACE_CONTROL_URL;
    if (!controlUrl) throw new Error('GitSpace control URL is required');
    const rpcEndpoint = new URL(`/__sandbox/${encodeURIComponent(input.userId)}/${encodeURIComponent(input.machineId)}/rpc`, controlUrl).toString();
    const existing = await this.getProcess('gitspace-machine');
    if (existing?.status !== 'running') {
      // A previous concurrent launch may have replaced the SDK process record
      // while the original host still owns its port (including during startup).
      if (!await this.healthy()) {
        await this.startProcess('bun /opt/gitspace/host.js', {
          processId: 'gitspace-machine',
          autoCleanup: false,
          env: { ...input.environment, GITSPACE_PUBLIC_RPC_URL: rpcEndpoint },
        });
      }
    }
    return this.record(input, 'offline', rpcEndpoint, 'Managed Cloudflare Sandbox is starting.', 'online');
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
async function sandbox(env: ProviderEnv, userId: string, machineId: string, incarnation: string | null): Promise<GitSpaceSandbox> {
  const namespace = env.Sandbox as DurableObjectNamespace<GitSpaceSandbox>;
  const identity = incarnation ? `${machineId}:${incarnation}` : machineId;
  return getSandbox(namespace, await sandboxObjectId(userId, identity), { normalizeId: true, keepAlive: true, labels: { userId, machineId, product: 'gitspace' } });
}

function managedEnrollment(body: unknown, userId: string, machineId?: string): ManagedEnrollment {
  if (!body || typeof body !== 'object') throw new Error('Machine enrollment is invalid');
  const value = body as Partial<ManagedEnrollment>;
  if ((value.userId !== undefined && value.userId !== userId) || typeof value.machineId !== 'string'
    || !/^sandbox-[a-z0-9-]{1,64}$/u.test(value.machineId) || (machineId !== undefined && value.machineId !== machineId)
    || !value.environment || typeof value.environment !== 'object' || Array.isArray(value.environment)
    || !Object.values(value.environment).every((item) => typeof item === 'string')) throw new Error('Machine enrollment does not match its provider namespace');
  return { userId, machineId: value.machineId, environment: value.environment };
}
const operationIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u;
function imageOperation(request: Request): string {
  const operation = request.headers.get('x-gitspace-image-operation');
  if (!operation || !operationIdPattern.test(operation)) throw new Error('Image operation identity is required');
  return operation;
}

export default {
  async fetch(request: Request, env: ProviderEnv): Promise<Response> {
    const url = new URL(request.url);
    const userId = request.headers.get('x-gitspace-user-id');
    if (!userId || (env.PROVIDER_ACCOUNT_ID && env.PROVIDER_ACCOUNT_ID !== userId)) {
      return Response.json({ status: 'error', error: { code: 'PROVIDER_ACCOUNT_MISMATCH', message: 'Request does not own this provider namespace' } }, { status: 403 });
    }
    const incarnation = request.headers.get('x-gitspace-image-incarnation');
    if (incarnation && !operationIdPattern.test(incarnation)) return Response.json({ status: 'error', error: { code: 'INVALID_MACHINE_INSTANCE', message: 'Machine instance identity is invalid' } }, { status: 400 });
    try {
      if (url.pathname === '/_image/preflight' && request.method === 'POST') {
        return await (await sandbox(env, userId, 'sandbox-image-preflight', null)).preflightImage();
      }
      if (url.pathname === '/v1/sandboxes' && request.method === 'POST') {
        const input = managedEnrollment(await request.json(), userId);
        const machine = await (await sandbox(env, userId, input.machineId, incarnation)).enrollMachine(input);
        return Response.json({ status: 'ok', machine });
      }
      const match = /^\/v1\/sandboxes\/(sandbox-[a-z0-9-]{1,64})\/(.+)$/u.exec(url.pathname);
      if (!match) return new Response('Not found', { status: 404 });
      const machineId = match[1]!;
      const action = match[2]!;
      const stub = await sandbox(env, userId, machineId, incarnation);
      if (action === '_image/enrollment' && request.method === 'GET') return await stub.exportPreparedEnrollment(imageOperation(request));
      if (action === '_image/enrollment' && request.method === 'PUT') {
        return await stub.stageEnrollment(managedEnrollment(await request.json(), userId, machineId), imageOperation(request));
      }
      if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
      if (action === '_image/retire') return await stub.retirePrepared(imageOperation(request));
      if (action === '_image/discard') {
        const body = await request.json() as { operationId?: unknown; recoveryOperationId?: unknown };
        if ((body.operationId !== null && (typeof body.operationId !== 'string' || !operationIdPattern.test(body.operationId)))
          || typeof body.recoveryOperationId !== 'string' || !operationIdPattern.test(body.recoveryOperationId)) throw new Error('Discard receipt identities are invalid');
        return await stub.discardCandidate(body.operationId, body.recoveryOperationId);
      }
      if (action === 'image/status') return await stub.imageStatus();
      if (action === 'prepare-replacement') return await stub.prepareReplacement();
      if (action === 'cancel-replacement') return await stub.cancelReplacement();
      if (action === 'rpc') {
        const headers = new Headers(request.headers);
        headers.delete('host');
        return await stub.rpc(new Request('http://localhost/rpc', { method: 'POST', headers, body: request.body, signal: request.signal, redirect: 'manual' }));
      }
      if (['status', 'sleep', 'resume', 'destroy'].includes(action)) {
        const value = action === 'status' ? await stub.statusMachine() : action === 'sleep' ? await stub.sleepMachine() : action === 'resume' ? await stub.resumeMachine() : await stub.destroyMachine(machineId);
        return Response.json({ status: 'ok', value });
      }
      return new Response('Not found', { status: 404 });
    } catch (error) {
      return Response.json({ status: 'error', error: { code: 'SANDBOX_OPERATION_FAILED', message: error instanceof Error ? error.message : 'Sandbox lifecycle failed' } }, { status: 409 });
    }
  },
} satisfies ExportedHandler<ProviderEnv>;
