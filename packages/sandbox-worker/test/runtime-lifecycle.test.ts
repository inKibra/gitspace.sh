import { describe, expect, it, vi } from 'vitest';

vi.mock('@cloudflare/sandbox', () => ({
  Sandbox: class {
    constructor(readonly ctx: unknown, readonly env: unknown) {}
  },
  getSandbox: vi.fn(),
}));

import { GitSpaceSandbox } from '../src/index.js';

function sandbox() {
  const records = new Map<string, unknown>([['gitspace:managed-enrollment', {
    userId: 'user-a', machineId: 'sandbox-a', environment: { GITSPACE_CONTROL_URL: 'https://api.example' },
  }]]);
  const runtime = new GitSpaceSandbox({ storage: {
    get: async (key: string) => records.get(key),
    put: async (key: string, value: unknown) => { records.set(key, value); },
  } } as never, { SANDBOX_HOSTNAME: 'sandbox.example' } as never);
  const methods = {
    startAndWaitForPorts: vi.fn(async () => {}),
    exposePort: vi.fn(async () => {}),
    getProcess: vi.fn(async () => ({ status: 'failed' })),
    exec: vi.fn(async () => ({ success: false, exitCode: 1 })),
    startProcess: vi.fn(async () => {}),
  };
  Object.assign(runtime, methods);
  return { runtime, records, methods };
}

describe('managed runtime startup', () => {
  it('launches only one host for concurrent starts', async () => {
    const { runtime, methods } = sandbox();
    let release!: () => void;
    methods.startAndWaitForPorts.mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    const first = runtime.resumeMachine();
    const second = runtime.resumeMachine();
    await vi.waitFor(() => expect(methods.startAndWaitForPorts).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(methods.startProcess).toHaveBeenCalledTimes(1);
  });

  it('keeps a healthy host online despite a failed duplicate process record', async () => {
    const { runtime, methods } = sandbox();
    methods.exec.mockResolvedValue({ success: true, exitCode: 0 });
    await runtime.resumeMachine();
    expect(methods.startProcess).not.toHaveBeenCalled();
    expect(await runtime.statusMachine()).toMatchObject({ state: 'online', desiredState: 'online' });
  });

  it('does not touch a deliberately stopped container during status reads', async () => {
    const { runtime, records, methods } = sandbox();
    records.set('gitspace:machine-record', { id: 'sandbox-a', state: 'offline', desiredState: 'offline', rpcEndpoint: null });
    expect(await runtime.statusMachine()).toMatchObject({ state: 'offline', desiredState: 'offline' });
    expect(methods.exec).not.toHaveBeenCalled();
    expect(methods.getProcess).not.toHaveBeenCalled();
    expect(methods.startAndWaitForPorts).not.toHaveBeenCalled();
  });
});
