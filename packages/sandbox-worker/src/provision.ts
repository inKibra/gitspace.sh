export interface SandboxMachineRecord {
  id: string;
  label: string;
  state: 'online' | 'offline';
  rpcEndpoint: string | null;
  kind: 'sandbox';
  notes: string;
  provider: 'cloudflare-sandbox';
  desiredState: 'online' | 'offline' | 'removed';
  lifecycleRevision: number;
  operationId: string | null;
  error: string | null;
}
export interface SandboxExecResult { success: boolean; exitCode: number; stderr: string }
export type SandboxFactory = (id: string, labels: Record<string, string>) => SandboxHandle;
export interface SandboxProcess {
  waitForLog(pattern: string | RegExp, timeout?: number): Promise<unknown>;
  waitForPort(port: number, options?: { mode?: 'tcp' | 'http' }): Promise<void>;
}
export interface SandboxHandle {
  exec(command: string): Promise<SandboxExecResult>;
  exposePort(port: number, options: { hostname: string; name?: string }): Promise<{ url: string }>;
  startProcess(command: string, options: { env: Record<string, string> }): Promise<SandboxProcess>;
}

export async function sandboxObjectId(userId: string, machineId: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${userId}:${machineId}`)));
  return `gitspace-${[...digest.subarray(0, 16)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

export async function provisionSandbox(input: { userId: string; machineId: string; hostname: string; environment: Record<string, string>; factory: SandboxFactory }): Promise<SandboxMachineRecord> {
  if (!input.userId || input.userId.length > 160) throw new Error('Sandbox user id is invalid');
  if (!/^sandbox-[a-z0-9-]{1,64}$/u.test(input.machineId)) throw new Error('Sandbox machine id is invalid');
  const labels = { userId: input.userId, machineId: input.machineId, product: 'gitspace' };
  const sandbox = input.factory(await sandboxObjectId(input.userId, input.machineId), labels);
  const readiness = await sandbox.exec('git --version && bun --version');
  if (!readiness.success || readiness.exitCode !== 0) throw new Error(readiness.stderr.trim() || 'Cloudflare Sandbox failed its GitSpace readiness probe');
  const exposed = await sandbox.exposePort(8081, { hostname: input.hostname, name: 'gitspace-rpc' });
  const rpcEndpoint = new URL('/rpc', exposed.url).toString();
  const process = await sandbox.startProcess('bun /opt/gitspace/host.js', { env: { ...input.environment, GITSPACE_PUBLIC_RPC_URL: rpcEndpoint } });
  await process.waitForLog(/GitSpace RPC ready/u, 120_000);
  return {
    id: input.machineId,
    label: `Cloudflare ${input.machineId.slice('sandbox-'.length)}`,
    state: 'online',
    rpcEndpoint,
    kind: 'sandbox',
    provider: 'cloudflare-sandbox',
    notes: 'Managed Cloudflare Sandbox. GitSpace machine runtime enrolled and ready.',
    desiredState: 'online',
    lifecycleRevision: 1,
    operationId: null,
    error: null,
  };
}
