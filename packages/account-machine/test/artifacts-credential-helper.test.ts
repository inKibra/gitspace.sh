import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import type { ControlOperation } from '@gitspace/protocol';
import { RuntimeAttachmentSchema } from '@gitspace/protocol-runtime';
import { CloudRuntimeClient } from '../src/cloud-runtime-client.js';
import { createArtifactsCredentialHelper } from '../src/artifacts-credential-helper.js';

test('a checkout reuses its repository lease until git reports that the remote refused it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitspace-credentials-'));
  const remote = 'https://artifacts.invalid/workspace.git';
  let leases = 0;
  class LeasingCloud extends CloudRuntimeClient {
    override async call<S extends z.ZodType>(operation: ControlOperation, _payload: Record<string, unknown>, schema: S): Promise<z.output<S>> {
      if (operation !== 'runtime.repository.credentials') throw new Error(`Unexpected operation: ${operation}`);
      leases++;
      return schema.parse({ remote, plaintext: `token-${leases}`, expiresAt: new Date(Date.now() + 900_000).toISOString() });
    }
  }
  const helper = await createArtifactsCredentialHelper(join(root, 'credentials'), new LeasingCloud({ baseUrl: 'https://proof.invalid', userId: 'account', machineId: 'machine', signingPrivateKey: new Uint8Array(32) }));
  try {
    const attachment = RuntimeAttachmentSchema.parse({ projectId: 'project', workspaceId: 'workspace', machineId: 'machine', attachmentId: 'checkout', generation: 0, checkout: { kind: 'shared', branch: 'main' }, state: 'attaching', capabilities: [], updatedAt: new Date().toISOString() });
    const env = { ...Bun.env, ...helper.environment({ attachment, rootPath: root, executionSecret: 'secret', prerequisitesComplete: false }, remote) };
    const credential = async (action: 'fill' | 'reject', input: string) => {
      const child = Bun.spawn(['git', 'credential', action], { cwd: root, env, stdin: new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
      const [status, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      if (status !== 0) throw new Error(stderr);
      return stdout;
    };
    const password = async () => /^password=(.*)$/mu.exec(await credential('fill', `url=${remote}\n\n`))?.[1];
    expect(await password()).toBe('token-1');
    expect(await password()).toBe('token-1');
    expect(leases).toBe(1);
    // What git does with a credential the remote answered 401 to.
    await credential('reject', `url=${remote}\nusername=x\npassword=token-1\n\n`);
    expect(await password()).toBe('token-2');
    expect(leases).toBe(2);
  } finally {
    await helper.close();
    await rm(root, { recursive: true, force: true });
  }
});
