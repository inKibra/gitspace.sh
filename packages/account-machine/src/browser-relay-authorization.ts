import type { RuntimeBrowserAuthorization, RuntimeBrowserAuthorizationBody } from '@gitspace/protocol-runtime';

/** Self-contained so the exact verifier runs in the installed extension. */
export async function verifyRelayAuthorization(authorization: RuntimeBrowserAuthorization, trust: { accountId: string; publicKey: string }, now = Date.now()): Promise<RuntimeBrowserAuthorizationBody> {
  const canonical = (input: unknown): string => {
    if (input === null || typeof input !== 'object') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(canonical).join(',')}]`;
    return `{${Object.entries(input).filter(([, value]) => value !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, value]) => `${JSON.stringify(key)}:${canonical(value)}`).join(',')}}`;
  };
  const bytes = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));
  const verify = async (publicKey: string, signature: string, domain: string, body: unknown) => crypto.subtle.verify('Ed25519', await crypto.subtle.importKey('raw', bytes(publicKey), 'Ed25519', false, ['verify']), bytes(signature), new TextEncoder().encode(domain + canonical(body)));
  const validTime = (value: { issuedAt: string; expiresAt: string }) => Number.isFinite(Date.parse(value.issuedAt)) && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > now && Date.parse(value.expiresAt) > Date.parse(value.issuedAt) && Date.parse(value.issuedAt) <= now + 120_000;
  const { body, signature, authority } = authorization;
  if (!authority || authority.body.accountId !== trust.accountId || !validTime(authority.body) || !await verify(trust.publicKey, authority.signature, 'gitspace.browser.authority.v1\n', authority.body)) throw new Error('Untrusted cloud authority or browser clock skew');
  if (!validTime(body) || Date.parse(body.expiresAt) > Date.parse(authority.body.expiresAt) || !await verify(authority.body.publicKey, signature, 'gitspace.browser.authorization.v1\n', body)) throw new Error('Invalid cloud authorization or browser clock skew');
  if (body.scope.projectId !== authority.body.projectId || body.scope.workspaceId !== authority.body.workspaceId || !body.scope.attemptId || !body.scope.requestId || !body.scope.taskId || !body.scope.machineId || !body.scope.attachmentId || !body.scope.conversationId || !Number.isSafeInteger(body.scope.generation)) throw new Error('Cloud authorization scope mismatch');
  if (body.dispatch.version !== 1 || !Number.isFinite(Date.parse(body.dispatch.deadlineAt)) || Date.parse(body.dispatch.deadlineAt) <= now || body.dispatch.tool !== (body.command.type === 'execute' ? 'browser' : 'browser_control')) throw new Error('Invalid dispatch');
  if (body.command.type === 'execute') {
    const { grant: signed, args } = body.command;
    const grant = signed.body;
    const certificate = signed.authority;
    if (!certificate || certificate.body.accountId !== trust.accountId || !validTime(certificate.body) || !await verify(trust.publicKey, certificate.signature, 'gitspace.browser.authority.v1\n', certificate.body)) throw new Error('Untrusted group grant authority');
    if (!await verify(certificate.body.publicKey, signed.signature, 'gitspace.browser.grant.v1\n', grant)) throw new Error('Invalid group grant signature');
    if (grant.projectId !== certificate.body.projectId || grant.workspaceId !== certificate.body.workspaceId) throw new Error('Group grant authority scope mismatch');
    for (const key of ['projectId', 'workspaceId', 'machineId', 'attachmentId', 'generation'] as const) if (grant[key] !== body.scope[key]) throw new Error('Grant scope mismatch');
    if (grant.source !== 'relay' || args.source !== 'relay' || !grant.groupId || !grant.groupName || !Array.isArray(grant.origins) || !Number.isFinite(Date.parse(grant.expiresAt)) || Date.parse(grant.expiresAt) <= now || Date.parse(grant.expiresAt) < Date.parse(body.expiresAt) || Date.parse(grant.expiresAt) > Date.parse(certificate.body.expiresAt)) throw new Error('Invalid relay group grant');
  } else if (!['prepare', 'manage', 'tabs'].includes(body.command.type)) throw new Error('Unsupported authorization');
  return body;
}
