import { createServer } from 'node:http';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import type { CloudRuntimeClient } from './cloud-runtime-client.js';

const leaseSchema = z.object({ remote: z.url(), plaintext: z.string().min(1), expiresAt: z.iso.datetime() });

/** Private machine-local credential bridge. Git asks for a fresh cloud lease on every authentication. */
export async function createArtifactsCredentialHelper(root: string, cloud: CloudRuntimeClient) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const socket = join(root, 'credentials.sock');
  const helper = join(root, 'git-credential-artifacts');
  const grants = new Map<string, { local: LocalAttachment; remote: string }>();
  await rm(socket, { force: true });
  await writeFile(helper, '#!/bin/sh\n[ "$1" = get ] || exit 0\nwhile IFS= read -r line; do [ -n "$line" ] || break; done\ntoken=$(curl --fail --silent --show-error --unix-socket "$GITSPACE_ARTIFACTS_SOCKET" "http://localhost/$GITSPACE_ARTIFACTS_GRANT") || exit 1\nprintf "username=x\\npassword=%s\\n\\n" "$token"\n', { mode: 0o700 });
  const server = createServer((request, response) => {
    void (async () => {
      const grant = grants.get((request.url ?? '').slice(1));
      if (request.method !== 'GET' || !grant) { response.writeHead(403).end(); return; }
      const attachment = grant.local.attachment;
      const lease = await cloud.call('runtime.repository.credentials', {
        projectId: attachment.projectId, workspaceId: attachment.workspaceId, machineId: attachment.machineId,
        attachmentId: attachment.attachmentId, generation: attachment.generation, scope: 'read',
      }, leaseSchema);
      if (lease.remote !== grant.remote || Date.parse(lease.expiresAt) <= Date.now() + 60_000 || /[\r\n]/u.test(lease.plaintext)) throw new Error('Invalid repository lease');
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(lease.plaintext.split('?')[0]);
    })().catch(() => { if (!response.headersSent) response.writeHead(502); response.end(); });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.off('error', reject); resolve(); }); });
  await chmod(socket, 0o600);
  return {
    environment(local: LocalAttachment, remote: string): Record<string, string> {
      const id = Buffer.from(`${local.attachment.attachmentId}:${local.attachment.generation}`).toString('base64url');
      grants.set(id, { local, remote });
      return {
        GITSPACE_ARTIFACTS_SOCKET: socket, GITSPACE_ARTIFACTS_GRANT: id,
        GIT_CONFIG_COUNT: '4', GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
        GIT_CONFIG_KEY_1: `credential.${remote}.helper`, GIT_CONFIG_VALUE_1: `!"${helper.replaceAll('"', '\\"')}"`,
        GIT_CONFIG_KEY_2: 'credential.useHttpPath', GIT_CONFIG_VALUE_2: 'true',
        GIT_CONFIG_KEY_3: 'http.followRedirects', GIT_CONFIG_VALUE_3: 'false', GIT_TERMINAL_PROMPT: '0',
      };
    },
    async close(): Promise<void> {
      grants.clear();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(socket, { force: true });
    },
  };
}
