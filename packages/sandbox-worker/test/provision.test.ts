import { describe, expect, it } from 'vitest';
import { provisionSandbox } from '../src/provision.js';

describe('Cloudflare Sandbox provisioning', () => {
  it('starts the machine runtime, waits for readiness, and returns its RPC endpoint', async () => {
    const calls: Array<{ id: string; labels: Record<string, string>; command?: string; env?: Record<string, string> }> = [];
    let waitedFor: string | RegExp | null = null;
    const machine = await provisionSandbox({
      userId: 'user-a',
      machineId: 'sandbox-build-a',
      hostname: 'sandboxes.gitspace.sh',
      environment: { GITSPACE_MACHINE_ID: 'sandbox-build-a' },
      factory: (id, labels) => ({
        exec: async (command) => { calls.push({ id, labels, command }); return { success: true, exitCode: 0, stderr: '' }; },
        exposePort: async () => ({ url: 'https://rpc-sandbox.sandboxes.gitspace.sh' }),
        startProcess: async (command, options) => {
          calls.push({ id, labels, command, env: options.env });
          return { waitForLog: async (pattern) => { waitedFor = pattern; }, waitForPort: async () => undefined };
        },
      }),
    });
    expect(calls[0]).toMatchObject({ labels: { userId: 'user-a', machineId: 'sandbox-build-a', product: 'gitspace' }, command: 'git --version && bun --version' });
    expect(calls[0]!.id).toMatch(/^gitspace-[a-f0-9]{32}$/u);
    expect(calls[1]).toMatchObject({ command: 'bun /opt/gitspace/host.js', env: { GITSPACE_MACHINE_ID: 'sandbox-build-a', GITSPACE_PUBLIC_RPC_URL: 'https://rpc-sandbox.sandboxes.gitspace.sh/rpc' } });
    expect(waitedFor).toEqual(/GitSpace RPC ready/u);
    expect(machine).toMatchObject({ id: 'sandbox-build-a', kind: 'sandbox', state: 'online', rpcEndpoint: 'https://rpc-sandbox.sandboxes.gitspace.sh/rpc' });
  });

  it('rejects a container that fails readiness', async () => {
    await expect(provisionSandbox({
      userId: 'user-a',
      machineId: 'sandbox-broken',
      hostname: 'sandboxes.gitspace.sh',
      environment: {},
      factory: () => ({
        exec: async () => ({ success: false, exitCode: 1, stderr: 'bun missing' }),
        exposePort: async () => ({ url: 'https://unused.example' }),
        startProcess: async () => ({ waitForLog: async () => undefined, waitForPort: async () => undefined }),
      }),
    })).rejects.toThrow(/bun missing/u);
  });
});
