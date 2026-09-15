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
  private lifecycleOperation: { name: string; id: string } | null = null;
  private runtimeGeneration: string | null = null;
  private runtimeHealthy: boolean | null = null;

  private controlled<T>(operation: string, action: () => Promise<T>): Promise<T> {
    const run = async () => {
      this.lifecycleOperation = { name: operation, id: crypto.randomUUID() };
      try {
        if (operation !== 'status') await this.lifecycle('begin');
        const result = await action();
        if (operation !== 'status') await this.lifecycle('complete');
        return result;
      } catch (error) {
        try { await this.lifecycle('failed', this.lifecycleError(error)); }
        finally { throw error; }
      } finally {
        this.lifecycleOperation = null;
      }
    };
    const result = this.providerControl.then(run, run);
    this.providerControl = result.then(() => undefined, () => undefined);
    return result;
  }

  private lifecycleError(error: unknown): Record<string, string | null> {
    // SDK errors may embed commands and their environment. Never log their message, stack, or context.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return { error: error instanceof Error ? 'Error' : typeof error,
      errorCode: typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/u.test(code) ? code : null };
  }

  private async lifecycle(stage: string, details: Record<string, string | number | boolean | null> = {}): Promise<void> {
    let input: ManagedEnrollment | undefined;
    let state: ImageState | undefined;
    let diagnosticsError: Record<string, string | null> | null = null;
    try {
      [input, state] = await Promise.all([
        this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY),
        this.imageState(),
      ]);
    } catch (error) {
      // Diagnostics must not block VM cleanup or turn a completed lifecycle action into a failure.
      diagnosticsError = this.lifecycleError(error);
    }
    const event = { event: 'sandbox.lifecycle', machineId: input?.machineId ?? null,
      sandboxId: this.ctx.id?.toString() ?? null, image: this.env.PROVIDER_IMAGE ?? null,
      operation: this.lifecycleOperation?.name ?? null, operationId: this.lifecycleOperation?.id ?? null,
      imageOperationId: state?.operationId ?? null, transferOperationId: state?.transferOperationId ?? null,
      generation: this.runtimeGeneration, stage, running: this.ctx.container?.running ?? false,
      prepared: state?.prepared ?? null, checkpointPrepared: state?.checkpointPrepared ?? null, runtimeStarted: state?.runtimeStarted ?? null,
      retired: state?.retired ?? null,
      ...(diagnosticsError ? { diagnosticsError: 'metadata-unavailable', diagnosticsErrorCode: diagnosticsError.errorCode } : {}),
      ...details };
    if ('error' in details || diagnosticsError) console.error(event);
    else console.info(event);
  }

  override async onStart(): Promise<void> {
    await super.onStart();
    // The SDK calls onStart after its port check, even when the VM was already running.
    await this.lifecycle('vm.port-ready');
  }

  override async onStop(params?: Parameters<CloudflareSandbox<ProviderEnv>['onStop']>[0]): Promise<void> {
    await this.lifecycle('vm.stopped', { exitCode: params?.exitCode ?? null, reason: params?.reason ?? null });
    this.runtimeHealthy = false;
    this.runtimeGeneration = null;
    await super.onStop(params);
  }

  override onError(error: unknown): void {
    this.ctx.waitUntil(this.lifecycle('vm.error', this.lifecycleError(error)));
  }
  private async imageState(): Promise<ImageState> {
    return await this.ctx.storage.get<ImageState>(IMAGE_STATE_KEY) ?? {
      operationId: null, prepared: false, checkpointPrepared: false, runtimeStarted: null,
      inherited: false, retired: false, transferOperationId: null, discardReceipt: null,
    };
  }
  private async healthy(): Promise<boolean> {
    let healthy = false;
    let generation: string | null = null;
    let details: Record<string, string | number | boolean | null> = {};
    if (this.ctx.container?.running) {
      try {
        const response = await this.ctx.container.getTcpPort(8081).fetch(new Request('http://localhost/health', { signal: AbortSignal.timeout(5_000) }));
        details = { httpStatus: response.status };
        if (response.ok) {
          const body = await response.json() as { status?: string; generation?: unknown };
          healthy = body.status === 'ok' && this.ctx.container?.running === true;
          if (typeof body.generation === 'string' && /^[a-zA-Z0-9._:-]{1,128}$/u.test(body.generation)) generation = body.generation;
        }
      } catch (error) { details = this.lifecycleError(error); }
    }
    if (this.runtimeHealthy !== healthy || this.runtimeGeneration !== generation) {
      this.runtimeHealthy = healthy;
      this.runtimeGeneration = generation;
      await this.lifecycle(healthy ? 'runtime.ready' : 'runtime.not-ready', details);
    }
    return healthy;
  }

  async preflightImage(): Promise<Response> {
    return this.controlled('image-preflight', async () => {
      try {
        const check = await this.exec('command -v bun >/dev/null && bun --version >/dev/null && test -r /opt/gitspace/host.js && test -r /opt/gitspace/rpc-probe.js', { timeout: 30_000 });
        if (!check.success || check.exitCode !== 0) return Response.json({ status: 'error', error: { code: 'IMAGE_BOOTSTRAP_MISSING', message: 'Image must provide compatible Bun, /opt/gitspace/host.js, and /opt/gitspace/rpc-probe.js' } }, { status: 409 });
        return Response.json({ status: 'ok' });
      } finally {
        await this.lifecycle('vm.destroy-requested', { machineId: 'sandbox-image-preflight' });
        await this.destroy();
        await this.lifecycle('vm.destroy-returned', { machineId: 'sandbox-image-preflight' });
      }
    });
  }

  async imageStatus(): Promise<Response> {
    await this.requireEnrollment();
    const state = await this.imageState();
    return Response.json({ status: 'ok', value: { image: this.env.PROVIDER_IMAGE ?? null, operationId: state.operationId, prepared: state.prepared, runtimeStarted: state.runtimeStarted } });
  }

  async stageEnrollment(input: ManagedEnrollment, operationId: string): Promise<Response> {
    return this.controlled('stage-enrollment', async () => {
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
    return this.controlled('export-enrollment', async () => {
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
    return this.controlled('retire-image', async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      this.requirePreparedTransfer(state, operationId);
      state.retired = true;
      state.transferOperationId = operationId;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.lifecycle('vm.destroy-requested');
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Source container has not stopped');
      await this.lifecycle('vm.destroy-confirmed');
      await this.record(input, 'offline', null, 'Checkpointed machine handed off to its selected image.', 'online');
      return Response.json({ status: 'ok', value: { machineId: input.machineId, retired: true } });
    });
  }

  async discardCandidate(operationId: string | null, recoveryOperationId: string): Promise<Response> {
    return this.controlled('discard-image', async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.operationId !== operationId) throw new Error('Candidate image operation changed');
      if (state.discardReceipt && (state.discardReceipt.operationId !== operationId || state.discardReceipt.recoveryOperationId !== recoveryOperationId)) {
        throw new Error('Candidate has a different discard receipt');
      }
      state.retired = true;
      state.transferOperationId = recoveryOperationId;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.lifecycle('vm.destroy-requested');
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Candidate container has not stopped');
      await this.lifecycle('vm.destroy-confirmed');
      state.prepared = true;
      state.discardReceipt = { machineId: input.machineId, operationId, recoveryOperationId, stopped: true };
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.record(input, 'offline', null, 'Candidate disk discarded by explicit tenant recovery authorization.', 'online');
      return Response.json({ status: 'ok', value: state.discardReceipt });
    });
  }

  async enrollMachine(input: ManagedEnrollment): Promise<SandboxMachineRecord> {
    return this.controlled('enroll', async () => {
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
    return this.controlled('status', async () => {
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
    return this.controlled('prepare-replacement', async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.inherited && state.runtimeStarted === false) {
        return Response.json({ prepared: true, machineId: input.machineId });
      }
      if (state.retired) throw new Error('Machine is already retired; reconcile its image operation');
      const token = input.environment.GITSPACE_CONTROL_TOKEN;
      if (!token) return Response.json({ error: 'Machine has no replacement control credential' }, { status: 409 });
      const response = await this.replacementControl('prepare-replacement', token);
      if (response.ok) {
        const result = await response.clone().json() as { prepared?: boolean; machineId?: string };
        if (result.prepared !== true || result.machineId !== input.machineId) throw new Error('Machine returned an invalid preparation receipt');
        state.prepared = true;
        state.checkpointPrepared = true;
        await this.ctx.storage.put(IMAGE_STATE_KEY, state);
        await this.lifecycle('checkpoint.prepared');
      }
      return response;
    });
  }

  async cancelReplacement(): Promise<Response> {
    return this.controlled('cancel-replacement', async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      if (state.retired || state.inherited) throw new Error('Image handoff cannot be cancelled on this container');
      const token = input.environment.GITSPACE_CONTROL_TOKEN;
      if (!token) return Response.json({ prepared: false, machineId: input.machineId });
      const response = await this.replacementControl('cancel-replacement', token);
      if (response.ok) {
        const result = await response.clone().json() as { prepared?: boolean; machineId?: string };
        if (result.prepared !== false || result.machineId !== input.machineId) throw new Error('Machine returned an invalid cancellation receipt');
        state.prepared = false;
        state.checkpointPrepared = false;
        await this.ctx.storage.put(IMAGE_STATE_KEY, state);
        await this.lifecycle('checkpoint.cancelled');
      }
      return response;
    });
  }

  private async replacementControl(action: 'prepare-replacement' | 'cancel-replacement', token: string): Promise<Response> {
    const container = this.ctx.container;
    if (!container?.running) return Response.json({ error: 'The cloud machine is stopped; replacement control cannot start a new VM' }, { status: 409 });
    // Control acts on this disk only. SDK containerFetch may boot another VM or replay a rejected request.
    const response = await container.getTcpPort(8081).fetch(new Request(`http://localhost/__control/${action}`, {
      method: 'POST', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(300_000),
    }));
    await this.lifecycle('checkpoint.response', { httpStatus: response.status });
    return response;
  }

  async resumeMachine(): Promise<SandboxMachineRecord> {
    return this.controlled('resume', async () => {
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
    return this.controlled('sleep', async () => {
      const input = await this.requireEnrollment();
      const state = await this.imageState();
      // Sleeping discards the VM's ephemeral disk, not just its native process.
      if (this.ctx.container?.running && !state.checkpointPrepared && !(state.inherited && state.runtimeStarted === false)) {
        throw new Error('Cloud machine must checkpoint before sleeping');
      }
      await this.lifecycle('vm.stop-requested', { signal: 'SIGTERM' });
      await this.stop('SIGTERM');
      // SDK stop sends the signal; a queued resume must not race the VM's eventual exit.
      const deadline = Date.now() + 120_000;
      while (this.ctx.container?.running) {
        if (Date.now() >= deadline) throw new Error('Cloud machine has not stopped; its checkpoint remains prepared');
        const pause = Promise.withResolvers<void>();
        setTimeout(pause.resolve, 500);
        await pause.promise;
      }
      await this.lifecycle('vm.stop-confirmed');
      state.prepared = state.inherited && state.runtimeStarted === false;
      state.checkpointPrepared = false;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      return this.record(input, 'offline', null, 'Temporary cloud machine stopped.', 'offline');
    });
  }

  async destroyMachine(machineId: string): Promise<{ machineId: string }> {
    return this.controlled('destroy', async () => {
      if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(machineId)) throw new Error('Sandbox machine id is invalid');
      const input = await this.ctx.storage.get<ManagedEnrollment>(ENROLLMENT_KEY);
      if (input && input.machineId !== machineId) throw new Error('Machine destruction identity changed');
      const state = await this.imageState();
      state.retired = true;
      await this.ctx.storage.put(IMAGE_STATE_KEY, state);
      await this.lifecycle('vm.destroy-requested', { machineId });
      await this.destroy();
      if (this.ctx.container?.running) throw new Error('Cloud machine has not stopped');
      await this.lifecycle('vm.destroy-confirmed', { machineId });
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
    // Enrollment retries share this path with resume and must not bypass a prepared source's fence.
    if (state.checkpointPrepared) throw new Error('Prepared source must be cancelled or handed off before resuming');
    // A custom ENTRYPOINT/CMD can run tenant code before host.js. Fence even an uncertain VM-start request.
    state.runtimeStarted = true;
    await this.ctx.storage.put(IMAGE_STATE_KEY, state);
    await this.lifecycle('vm.start-requested');
    await this.startAndWaitForPorts({ ports: 3000 });
    await this.lifecycle('vm.sdk-ready');
    await this.exposePort(8081, { hostname: this.env.SANDBOX_HOSTNAME, name: 'gitspace-rpc' });
    const controlUrl = input.environment.GITSPACE_CONTROL_URL;
    if (!controlUrl) throw new Error('GitSpace control URL is required');
    const rpcEndpoint = new URL(`/__sandbox/${encodeURIComponent(input.userId)}/${encodeURIComponent(input.machineId)}/rpc`, controlUrl).toString();
    const existing = await this.getProcess('gitspace-machine');
    await this.lifecycle('host.observed', { processStatus: existing?.status ?? null, exitCode: existing?.exitCode ?? null });
    if (existing?.status !== 'running') {
      // A previous concurrent launch may have replaced the SDK process record
      // while the original host still owns its port (including during startup).
      if (!await this.healthy()) {
        await this.lifecycle('host.start-requested');
        await this.startProcess('bun /opt/gitspace/host.js', {
          processId: 'gitspace-machine',
          autoCleanup: false,
          env: { ...input.environment, GITSPACE_PUBLIC_RPC_URL: rpcEndpoint },
        });
        await this.lifecycle('host.start-accepted');
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
