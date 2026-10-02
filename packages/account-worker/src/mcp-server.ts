import { createGitSpaceMcpHandler } from '@gitspace/mcp-server';
import { accountAccessResponse, activeAccount } from './account-access.js';
import type { CredentialVaultDO } from './application.js';
import type { UserSettingsDO } from './user-settings.js';

const MAX_REQUEST_BYTES = 1024 * 1024;

function reject(status: number, code: string, message: string): Response {
  return Response.json({ error: { code, message } }, {
    status,
    headers: {
      'cache-control': 'private, no-store',
      ...(status === 401 ? { 'www-authenticate': 'Bearer realm="GitSpace MCP"' } : {}),
    },
  });
}


async function boundedRequest(request: Request): Promise<Request | null> {
  if (!request.body) return request;
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_REQUEST_BYTES) return null;
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > MAX_REQUEST_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return new Request(request.url, { method: request.method, headers: request.headers, body, signal: request.signal });
}

/**
 * One tenant, one independently revocable MCP access key, one dedicated API-client grant.
 * The access key never reaches RPC. Only the existing SDK's device signatures do.
 */
export async function handleMcpRequest(
  request: Request,
  env: Env,
  dispatch: (request: Request) => Promise<Response>,
): Promise<Response> {
  const expectedOrigin = new URL(env.ACCOUNT_URL).origin;
  const url = new URL(request.url);
  if (url.origin !== expectedOrigin) return reject(403, 'MCP_HOST_MISMATCH', 'MCP belongs to this tenant account origin');
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== expectedOrigin) return reject(403, 'MCP_ORIGIN_REJECTED', 'Cross-origin browser requests are not allowed');
  try {
    const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
    if (denied) return denied;
    const settings = await (env.USER_SETTINGS as DurableObjectNamespace<UserSettingsDO>).getByName(env.ACCOUNT_ID).get('mcp');
    if (!settings.profile.handle || url.hostname !== `${settings.profile.handle}.gitspace.sh`) {
      return reject(403, 'MCP_HOST_MISMATCH', 'MCP does not belong to the current account hostname');
    }
    const vault = (env.CREDENTIALS as DurableObjectNamespace<CredentialVaultDO>).getByName(env.ACCOUNT_ID);
    const bearer = /^Bearer ([A-Za-z0-9_-]{43})$/u.exec(request.headers.get('authorization') ?? '');
    const access = bearer ? await vault.resolveMcpAccess(bearer[1]!) : null;
    if (!access) return reject(401, 'MCP_UNAUTHORIZED', 'A valid active MCP access token is required');
    const { device } = access;
    const bounded = await boundedRequest(request);
    if (!bounded) return reject(413, 'MCP_REQUEST_TOO_LARGE', 'MCP request exceeds the account request limit');
    // Every RPC targets the account `/rpc`, which forwards machine work to the
    // holder. Dispatch the already-signed request locally; all account access
    // checks still run. A Worker cannot fetch its own hostnames, so refuse any
    // other target instead of letting it fail as an opaque network error.
    const signedFetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
      const outgoing = new Request(input, init);
      const target = new URL(outgoing.url);
      if (target.origin === expectedOrigin && target.pathname === '/rpc') return dispatch(outgoing);
      return reject(500, 'MCP_RPC_TARGET_INVALID', `MCP dispatches RPC only to ${expectedOrigin}/rpc, not ${target.origin}${target.pathname}`);
    }, { preconnect: globalThis.fetch.preconnect });
    const handler = createGitSpaceMcpHandler({
      key: access.key,
      fetch: signedFetch,
      capabilities: device.capabilities,
      scope: device.scope,
    });
    const response = await handler.fetch(bounded);
    response.headers.set('cache-control', 'private, no-store');
    return response;
  } catch {
    // Dependency failures must not disclose a credential, provider response, or RPC input.
    return reject(503, 'MCP_UNAVAILABLE', 'MCP authorization or execution is unavailable');
  }
}
