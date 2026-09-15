import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  getSandbox: vi.fn(),
}));

import { getSandbox } from '@cloudflare/sandbox';
import worker, { GitSpaceSandbox } from '../src/index.js';

function sandbox() {
  const records = new Map<string, unknown>([['gitspace:managed-enrollment', {
    userId: 'user-a', machineId: 'sandbox-a', environment: { GITSPACE_CONTROL_URL: 'https://api.example' },
  }]]);
  let healthy = false;
  const fetch = vi.fn(async (request: Request) => new URL(request.url).pathname === '/health' && healthy
    ? Response.json({ status: 'ok' })
    : Response.json({ error: { code: 'RPC_DRAINING' } }, { status: 503 }));
  const container = { running: true, getTcpPort: vi.fn(() => ({ fetch })) };
  const runtime = new GitSpaceSandbox({ container, storage: {
    get: async (key: string) => structuredClone(records.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [name, entry] of typeof key === 'string' ? [[key, value]] : Object.entries(key)) records.set(name as string, structuredClone(entry));
    },
    delete: async (keys: string[]) => {
      let removed = 0;
      for (const key of keys) if (records.delete(key)) removed += 1;
      return removed;
    },
  } } as never, { SANDBOX_HOSTNAME: 'sandbox.example' } as never);
  const methods = {
    startAndWaitForPorts: vi.fn(async () => { container.running = true; }),
    exposePort: vi.fn(async () => {}),
    getProcess: vi.fn(async () => ({ status: 'failed' })),
    exec: vi.fn(async () => ({ success: false, exitCode: 1 })),
    startProcess: vi.fn(async () => { healthy = true; }),
    destroy: vi.fn(async () => { container.running = false; healthy = false; }),
    stop: vi.fn(async () => { container.running = false; healthy = false; }),
  };
  Object.assign(runtime, methods);
  return { runtime, records, methods, container, fetch };
}

describe('managed runtime startup', () => {
  it('launches only one host for concurrent starts', async () => {
    const { runtime, methods } = sandbox();
    const started = Promise.withResolvers<void>();
    methods.startAndWaitForPorts.mockImplementation(() => started.promise);
    const first = runtime.resumeMachine();
    const second = runtime.resumeMachine();
    await vi.waitFor(() => expect(methods.startAndWaitForPorts).toHaveBeenCalledTimes(1));
    started.resolve();
    await Promise.all([first, second]);
    expect(methods.startProcess).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy host online despite a failed duplicate process record', async () => {
    const { runtime, fetch, methods } = sandbox();
    fetch.mockImplementation(async () => Response.json({ status: 'ok' }));
    await runtime.resumeMachine();
    expect(methods.startProcess).not.toHaveBeenCalled();
    expect(await runtime.statusMachine()).toMatchObject({ state: 'online', desiredState: 'online' });
  });

  it('resumes after a successful checkpoint and normal sleep', async () => {
    const { runtime, records } = sandbox();
    const enrollment = records.get('gitspace:managed-enrollment') as Parameters<GitSpaceSandbox['stageEnrollment']>[0];
    enrollment.environment.GITSPACE_CONTROL_TOKEN = 'test-control';
    records.set('gitspace:managed-enrollment', enrollment);
    Object.assign(runtime, { containerFetch: async () => Response.json({ prepared: true, machineId: 'sandbox-a' }) });
    await runtime.resumeMachine();
    expect((await runtime.prepareReplacement()).status).toBe(200);
    expect(await runtime.sleepMachine()).toMatchObject({ state: 'offline', desiredState: 'offline' });
    expect(await runtime.resumeMachine()).toMatchObject({ state: 'online', desiredState: 'online' });
  });

  it('waits for a stopped VM before acknowledging sleep or accepting a queued resume', async () => {
    const { runtime, methods, container } = sandbox();
    methods.stop.mockImplementationOnce(async () => {});
    vi.useFakeTimers();
    try {
      let acknowledged = false;
      const sleeping = runtime.sleepMachine().then((record) => { acknowledged = true; return record; });
      const resuming = runtime.resumeMachine();
      await vi.advanceTimersByTimeAsync(0);
      expect(acknowledged).toBe(false);
      container.running = false;
      await vi.advanceTimersByTimeAsync(500);
      expect(await sleeping).toMatchObject({ state: 'offline', desiredState: 'offline' });
      expect(await resuming).toMatchObject({ state: 'online', desiredState: 'online' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('destroys an unenrolled allocation idempotently and rejects late enrollment', async () => {
    const { runtime, records, container } = sandbox();
    const enrollment = records.get('gitspace:managed-enrollment');
    records.clear();
    container.running = false;
    vi.mocked(getSandbox).mockReturnValue(runtime as never);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const destroyed = await worker.fetch(new Request('https://provider.test/v1/sandboxes/sandbox-a/destroy', {
        method: 'POST', headers: { 'x-gitspace-user-id': 'user-a' },
      }), { Sandbox: {} } as never);
      expect(destroyed.status).toBe(200);
    }
    const late = await worker.fetch(new Request('https://provider.test/v1/sandboxes', {
      method: 'POST', headers: { 'x-gitspace-user-id': 'user-a', 'content-type': 'application/json' }, body: JSON.stringify(enrollment),
    }), { Sandbox: {} } as never);
    expect(late.status).toBe(409);
  });

  it('does not touch a deliberately stopped container during status reads', async () => {
    const { runtime, records, methods } = sandbox();
    records.set('gitspace:machine-record', { id: 'sandbox-a', state: 'offline', desiredState: 'offline', rpcEndpoint: null });
    expect(await runtime.statusMachine()).toMatchObject({ state: 'offline', desiredState: 'offline' });
    expect(methods.exec).not.toHaveBeenCalled();
    expect(methods.getProcess).not.toHaveBeenCalled();
    expect(methods.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it('never starts a holder that stopped after the directory reported it online', async () => {
    const { runtime, records, container, fetch, methods } = sandbox();
    records.set('gitspace:machine-record', { id: 'sandbox-a', state: 'online', desiredState: 'online' });
    container.running = false;
    const response = await runtime.rpc(new Request('http://localhost/rpc', { method: 'POST', body: 'signed read' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'MACHINE_OFFLINE' } });
    expect(fetch).not.toHaveBeenCalled();
    expect(methods.startAndWaitForPorts).not.toHaveBeenCalled();
    expect(methods.exec).not.toHaveBeenCalled();
  });

  it('preserves a live host rejection without the SDK replaying or restarting the RPC', async () => {
    const { runtime, records, fetch, methods } = sandbox();
    records.set('gitspace:machine-record', { id: 'sandbox-a', state: 'online', desiredState: 'online' });
    const response = await runtime.rpc(new Request('http://localhost/rpc', { method: 'POST', body: 'signed mutation' }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: 'RPC_DRAINING' } });
    expect(fetch).toHaveBeenCalledOnce();
    expect(methods.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it('requires checkpoint authority after an uncertain custom image start', async () => {
    const { runtime, records, methods } = sandbox();
    const enrollment = records.get('gitspace:managed-enrollment') as Parameters<GitSpaceSandbox['stageEnrollment']>[0];
    records.clear();
    const operation = crypto.randomUUID();
    await runtime.stageEnrollment(enrollment, operation);
    expect(await (await runtime.imageStatus()).json()).toMatchObject({ value: { prepared: true, runtimeStarted: false } });
    methods.startAndWaitForPorts.mockRejectedValue(new Error('VM start response lost'));
    await expect(runtime.resumeMachine()).rejects.toThrow('VM start response lost');
    expect(await (await runtime.imageStatus()).json()).toMatchObject({ value: { prepared: true, runtimeStarted: true } });
    await expect(runtime.exportPreparedEnrollment(crypto.randomUUID())).rejects.toThrow('no durable checkpoint');
  });

  it('keeps a never-started handoff recoverable without booting the candidate', async () => {
    const { runtime, records, methods } = sandbox();
    const enrollment = records.get('gitspace:managed-enrollment') as Parameters<GitSpaceSandbox['stageEnrollment']>[0];
    records.clear();
    await runtime.stageEnrollment(enrollment, crypto.randomUUID());
    const replacement = crypto.randomUUID();
    await runtime.retirePrepared(replacement);
    expect(await (await runtime.exportPreparedEnrollment(replacement)).json()).toEqual(enrollment);
    await expect(runtime.resumeMachine()).rejects.toThrow('Prepared source');
    await expect(runtime.exportPreparedEnrollment(crypto.randomUUID())).rejects.toThrow('another image operation');
    expect(methods.startAndWaitForPorts).not.toHaveBeenCalled();
  });

  it('issues an operation-bound discard receipt only after confirming the candidate stopped', async () => {
    const { runtime, methods } = sandbox();
    const recovery = crypto.randomUUID();
    methods.destroy.mockImplementationOnce(async () => {});
    await expect(runtime.discardCandidate(null, recovery)).rejects.toThrow('has not stopped');
    await expect(runtime.exportPreparedEnrollment(recovery)).rejects.toThrow('no durable checkpoint');
    const receipt = await (await runtime.discardCandidate(null, recovery)).json();
    expect(receipt).toEqual({ status: 'ok', value: { machineId: 'sandbox-a', operationId: null, recoveryOperationId: recovery, stopped: true } });
    await expect(runtime.resumeMachine()).rejects.toThrow('Prepared source');
    expect(await (await runtime.exportPreparedEnrollment(recovery)).json()).toMatchObject({ machineId: 'sandbox-a' });
    await expect(runtime.exportPreparedEnrollment(crypto.randomUUID())).rejects.toThrow('no durable checkpoint');
  });

  it('returns a structured provider rejection for an asynchronous DO failure', async () => {
    const { runtime, records } = sandbox();
    records.clear();
    vi.mocked(getSandbox).mockReturnValue(runtime as never);
    const response = await worker.fetch(new Request('https://provider.test/v1/sandboxes/sandbox-a/image/status', {
      method: 'POST', headers: { 'x-gitspace-user-id': 'user-a' },
    }), { Sandbox: {} } as never);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'SANDBOX_OPERATION_FAILED', message: 'Sandbox machine is not enrolled' } });
  });
});
