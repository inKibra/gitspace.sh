import { createServer } from 'node:http';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { GitHubRepositoryTokenSchema, MachineOriginAccessSchema, type MachineOriginAccess } from '@gitspace/protocol/github';
import { RuntimeAttachmentLeaseSchema, type RuntimeAttachment } from '@gitspace/protocol-runtime';
import type { LocalAttachment } from '@gitspace/runtime-machine';
import type { CloudRuntimeClient } from './cloud-runtime-client.js';

/** The checkout identity the account authorizes origin access by: this machine's attachment at its generation. */
export type CheckoutLease = Pick<RuntimeAttachment, 'projectId' | 'workspaceId' | 'machineId' | 'attachmentId' | 'generation'>;

/** How checkouts reach a project origin that an installation of the account's GitHub App covers. */
export interface GitHubCheckoutAccess {
  /** The account's decision for the checkout's project origin, asked every time: coverage changes on GitHub. */
  access(attachment: CheckoutLease): Promise<MachineOriginAccess>;
  /** The credential helper command for `https://github.com`; it carries only the checkout's attachment and generation. */
  helper(attachment: CheckoutLease): string;
}

/** The grant a checkout's helper command carries; the bridge answers only while that attachment generation is held. */
function grantOf(attachment: CheckoutLease): string {
  return Buffer.from(`${attachment.attachmentId}:${attachment.generation}`).toString('base64url');
}

// Git runs `<helper> <grant> get|store|erase`. Only `get` answers; nothing is stored, so `store` and `erase` do nothing.
const SCRIPT = `#!/bin/sh
[ "$2" = get ] || exit 0
while IFS= read -r line; do [ -n "$line" ] || break; done
token=$(curl --fail --silent --show-error --unix-socket "\${0%/*}/github.sock" "http://localhost/$1") || exit 1
printf "username=x-access-token\\npassword=%s\\n\\n" "$token"
`;

/** Private machine-local credential bridge for covered GitHub origins. Every authentication asks the account for a fresh
 * installation token narrowed to the checkout's repository; the token exists only in this response and git's memory.
 * Git's credential protocol does not say whether it fetches or pushes, so a ready checkout asks for `write`. */
export async function createGitHubCredentialHelper(root: string, cloud: Pick<CloudRuntimeClient, 'call'>, checkouts: () => readonly LocalAttachment[]): Promise<GitHubCheckoutAccess & { close(): Promise<void> }> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const socket = join(root, 'github.sock');
  const helper = join(root, 'git-credential-github');
  await rm(socket, { force: true });
  await writeFile(helper, SCRIPT, { mode: 0o700 });
  await chmod(helper, 0o700);
  const server = createServer((request, response) => {
    void (async () => {
      const grant = (request.url ?? '').slice(1);
      const checkout = request.method === 'GET' ? checkouts().find(local => grantOf(local.attachment) === grant) : undefined;
      if (!checkout) { response.writeHead(403).end(); return; }
      const access = checkout.attachment.state === 'ready' ? 'write' : 'read';
      const issued = await cloud.call('runtime.repository.githubToken', { ...RuntimeAttachmentLeaseSchema.parse(checkout.attachment), access }, GitHubRepositoryTokenSchema);
      if (Date.parse(issued.expiresAt) <= Date.now() + 60_000 || /[\r\n]/u.test(issued.token)) throw new Error('Invalid installation token');
      response.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }).end(issued.token);
    })().catch((error: unknown) => {
      console.error(JSON.stringify({ event: 'github_credentials_failed', message: error instanceof Error ? error.message : String(error) }));
      if (!response.headersSent) response.writeHead(502);
      response.end();
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, () => { server.off('error', reject); resolve(); }); });
  await chmod(socket, 0o600);
  return {
    access: attachment => cloud.call('runtime.repository.originAccess', RuntimeAttachmentLeaseSchema.parse(attachment), MachineOriginAccessSchema),
    helper: attachment => `!"${helper.replaceAll('"', '\\"')}" ${grantOf(attachment)}`,
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await rm(socket, { force: true });
    },
  };
}
