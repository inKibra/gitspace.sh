import { RuntimeSecureInputPageRequestSchema, signRuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserPlacement, type RuntimeSecureFillResult, type RuntimeSecureInputField, type RuntimeSecureInputOutcome, type RuntimeSecureInputPageRequest, type RuntimeSecureInputQuestion, type RuntimeSecureInputView } from '@gitspace/protocol-runtime';
import { STEP_UP_HEADER } from '@gitspace/protocol/device-grant';
import { withDeviceAuthority, DEVICE_AUTHORITY_UNAVAILABLE } from './device-authority.js';
import { runtimeBrowserSigning, type RuntimeBrowserKeyStorage, type RuntimeBrowserSigningEnvironment } from './runtime-browser.js';

/**
 * Secure input on the account's side (docs/APERTURE-DESIGN.md §10.1). The agent's ask_secure_input records a request in
 * the vault (`CredentialVaultDO.secureInputRecord`), bound to the workspace, conversation, question, tab, origin, field
 * and kind, until it expires; its link carries only the request's random id. The page (`serveSecureInput`) shows it to
 * a signed-in GitSpace browser after a passkey step-up, takes the value once, and has the workspace fill it into the tab
 * (`secureFillTab`): your Chrome through its extension, or the cloud browser through its session object, each only
 * while the tab shows the request's origin. The workspace's agent hears provided or declined, never the value.
 */

/** A request as the vault keeps it: its workspace, conversation and question, the request as its question shows it,
 * and whether a page has used it (`used`: answered once, it takes no other answer). */
export type SecureInputRecord = { id: string; projectId: string; workspaceId: string; conversationId: string; questionId: string; request: RuntimeSecureInputQuestion; state: 'open' | 'used' };

/** The longest body the page's API reads: a value of `SECURE_INPUT_VALUE_MAX` characters and its envelope. */
const BODY_MAX_BYTES = 32 * 1024;

function failure(status: number, code: string, message: string): Response {
  return Response.json({ status: 'error', error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}
function success(value: RuntimeSecureInputView | RuntimeSecureInputOutcome): Response {
  return Response.json({ status: 'ok', value }, { headers: { 'cache-control': 'no-store' } });
}

/** The field a request names, as the fill takes it. */
export function secureInputField(request: Pick<RuntimeSecureInputQuestion, 'selector' | 'ref'>): RuntimeSecureInputField | null {
  if (request.selector !== undefined) return { selector: request.selector };
  return request.ref !== undefined ? { ref: request.ref } : null;
}

/**
 * The one check a secure-input page passes before it reads or answers a request: the request is signed by a browser
 * device of this account, signed in to GitSpace in that browser, that may write; and opening or answering it carries a
 * passkey step-up (`x-gitspace-step-up`) naming the request, spent once (`CredentialVaultDO.consumeStepUp`). Declining
 * needs no step-up: it reveals and provides nothing. Answers the device and the page's request, or the refusal to send.
 */
export async function secureInputAuthorized(env: Env, request: Request, body: Uint8Array): Promise<{ deviceId: string; page: RuntimeSecureInputPageRequest } | Response> {
  const url = new URL(request.url);
  const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({
    header: request.headers.get('x-gitspace-device'), method: 'POST', target: `${url.pathname}${url.search}`, body,
    capabilities: ['rpc.write'], browserOnly: true, accountScope: true,
  }, now));
  if (auth.status === 'error') return Response.json(auth, { status: auth.error.code === 'RPC_FORBIDDEN' ? 403 : auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401 });
  const deviceId = auth.value.device.deviceId;
  let raw: unknown = null;
  try { raw = JSON.parse(new TextDecoder().decode(body)); } catch { /* answered below as invalid */ }
  // The issues are not echoed: they could quote the value.
  const parsed = RuntimeSecureInputPageRequestSchema.safeParse(raw);
  if (!parsed.success) return failure(400, 'SECURE_INPUT_INVALID', 'Invalid secure-input request');
  const page = parsed.data;
  if (page.op === 'decline') return { deviceId, page };
  const stepped = await env.CREDENTIALS.getByName(env.ACCOUNT_ID).consumeStepUp({
    deviceId, action: { purpose: page.op === 'view' ? 'secure-input.open' : 'secure-input.answer', targets: [page.id] }, proof: request.headers.get(STEP_UP_HEADER),
  });
  if (stepped.status === 'error') return failure(403, stepped.error.code, stepped.error.message);
  return { deviceId, page };
}

/** What `secureFillTab` reaches: the workspace's cloud browser session, and the relay to your Chromes. */
export type SecureFillEnvironment = RuntimeBrowserSigningEnvironment & {
  RELAY_NAME: string;
  BROWSER_SESSION?: { getByName(name: string): { secureFill(input: { projectId: string; workspaceId: string; targetId: string; origin: string; field: RuntimeSecureInputField; value: string }): Promise<RuntimeSecureFillResult> } };
  RELAY?: { getByName(name: string): { browserRelayPlacement(projectId: string, pairingId?: string): Promise<RuntimeAccountBrowserPlacement>; browserRelaySecureFill(authorization: RuntimeAccountBrowserAuthorization, value: string): Promise<RuntimeSecureFillResult> } };
};

/**
 * Fills `value` into the field `request` names, on the browser its tab is on: the cloud browser's session object fills
 * it there; for your Chrome the workspace signs a `manage` `secureFill` naming the group, tab, origin, field, kind and
 * request (as the main conversation `conversationId`), and the relay hands it and the value to the extension. Either
 * fills only while the tab shows the request's origin. The value is not kept.
 */
export async function secureFillTab(input: { storage: RuntimeBrowserKeyStorage; env: SecureFillEnvironment; identity: { projectId: string; workspaceId: string }; conversationId: string; request: RuntimeSecureInputQuestion; value: string }): Promise<RuntimeSecureFillResult> {
  const { env, identity, request } = input;
  const field = secureInputField(request);
  if (!field) return { refused: 'The request names no field' };
  if (request.source === 'cloud') {
    if (!env.BROWSER_SESSION) throw new Error('Browser session unavailable');
    return env.BROWSER_SESSION.getByName(`${env.ACCOUNT_ID}:${identity.projectId}:${identity.workspaceId}`).secureFill({ ...identity, targetId: request.targetId, origin: request.origin, field, value: input.value });
  }
  if (!env.RELAY || request.pairingId === null) throw new Error('Account Chrome relay unavailable');
  if (await input.storage.get(`runtime.browser.revoked:${request.groupId}`)) return { refused: `The workspace's group on ${request.browser} has ended` };
  const relay = env.RELAY.getByName(env.RELAY_NAME);
  const placement = await relay.browserRelayPlacement(identity.projectId, request.pairingId);
  const signer = await runtimeBrowserSigning(input.storage, env, identity);
  const id = crypto.randomUUID(), deadlineAt = new Date(Date.now() + 60_000).toISOString();
  const authorization = await signRuntimeAccountBrowserAuthorization({
    scope: { ...identity, placement, conversationId: input.conversationId, conversationKind: 'main', taskId: id, requestId: id, attemptId: id },
    issuedAt: signer.issuedAt, expiresAt: deadlineAt, dispatch: { version: 1, tool: 'browser_control', deadlineAt, replay: 'unsafe' },
    command: { type: 'manage', action: 'secureFill', groupId: request.groupId, targetId: request.targetId, origin: request.origin, ...field, fillKind: request.kind, secureInputId: request.requestId },
  }, signer.privateKey, signer.authority);
  return relay.browserRelaySecureFill(authorization, input.value);
}

/** Why a request takes no answer, as the page shows it. */
const REFUSED: Record<'unknown' | 'expired' | 'used' | 'closed', { status: number; code: string; message: string }> = {
  unknown: { status: 404, code: 'SECURE_INPUT_UNKNOWN', message: 'This account has no such secure-input request' },
  expired: { status: 410, code: 'SECURE_INPUT_EXPIRED', message: 'This request expired; the agent can ask again' },
  used: { status: 410, code: 'SECURE_INPUT_USED', message: 'This request was already answered' },
  closed: { status: 410, code: 'SECURE_INPUT_CLOSED', message: 'This request is no longer open: it was declined, or its conversation moved on' },
};

/**
 * `POST /api/secure-input` from the secure-input page (`RuntimeSecureInputPageRequestSchema`), signed by a signed-in
 * GitSpace browser of this account on the account's origin, with a passkey step-up to open or answer
 * (`secureInputAuthorized`). `view` shows the request; `submit`
 * (a typed value, saved in the vault for the origin when `save`), `useSaved` (a value saved for that origin and kind)
 * and `decline` answer it, once: a used, expired or closed request takes no answer, and a leaked link alone reads
 * nothing. Every answer is audited; no answer, error or log carries the value.
 */
export async function serveSecureInput(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST' || request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return failure(403, 'ORIGIN_REJECTED', 'Account origin required');
  const declared = Number(request.headers.get('content-length') ?? 0);
  if (!Number.isSafeInteger(declared) || declared > BODY_MAX_BYTES) return failure(413, 'REQUEST_TOO_LARGE', 'Secure-input request exceeds size limit');
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength > BODY_MAX_BYTES) return failure(413, 'REQUEST_TOO_LARGE', 'Secure-input request exceeds size limit');
  const signedIn = await secureInputAuthorized(env, request, body);
  if (signedIn instanceof Response) return signedIn;
  const { page } = signedIn;
  const vault = env.CREDENTIALS.getByName(env.ACCOUNT_ID);
  const record = await vault.secureInputRequest(page.id);
  if (!record) return failure(REFUSED.unknown.status, REFUSED.unknown.code, REFUSED.unknown.message);
  const identity = { projectId: record.projectId, workspaceId: record.workspaceId };
  const space = env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${record.workspaceId}`);
  const expired = Date.parse(record.request.expiresAt) <= Date.now();
  const state = record.state === 'used' ? 'used' : expired ? 'expired' : await space.secureInputOpen(identity, record.questionId, record.id) ? 'open' : 'closed';
  const { request: asked } = record;
  if (page.op === 'view') {
    return success({ id: record.id, state, workspace: asked.workspace, purpose: asked.purpose, origin: asked.origin, kind: asked.kind, source: asked.source, browser: asked.browser, title: asked.title, expiresAt: asked.expiresAt,
      saved: state === 'open' ? await vault.siteCredentials(asked.origin, asked.kind) : [] });
  }
  if (state !== 'open') return failure(REFUSED[state].status, REFUSED[state].code, REFUSED[state].message);
  const audit = { origin: asked.origin, requestId: record.id, deviceId: signedIn.deviceId, projectId: record.projectId, workspaceId: record.workspaceId };
  /** Takes the request for this answer, once; the refusal to send when another answer or the expiry came first. */
  const claim = async (): Promise<Response | null> => {
    const claimed = await vault.secureInputClaim(record.id, signedIn.deviceId);
    return 'refused' in claimed ? failure(REFUSED[claimed.refused].status, REFUSED[claimed.refused].code, REFUSED[claimed.refused].message) : null;
  };
  if (page.op === 'decline') {
    const refused = await claim();
    if (refused) return refused;
    const reason = 'The person declined it on the secure-input page';
    await space.secureInputDeclined(identity, record, reason);
    await vault.auditSiteCredential({ ...audit, event: 'declined', credentialId: null, detail: null });
    return success({ outcome: 'declined', reason });
  }
  const value = page.op === 'submit' ? page.value : await vault.openSiteCredential(page.credentialId, asked.origin, asked.kind);
  if (value === null) return failure(404, 'SECURE_INPUT_SAVED_UNKNOWN', `No value is saved under that id for ${asked.origin}`);
  const refused = await claim();
  if (refused) return refused;
  const filled = await space.secureInputFill(identity, record, value);
  const credentialId = page.op === 'useSaved' ? page.credentialId : null;
  if ('refused' in filled) {
    await vault.auditSiteCredential({ ...audit, event: 'refused', credentialId, detail: filled.refused });
    return success({ outcome: 'declined', reason: filled.refused });
  }
  await vault.auditSiteCredential({ ...audit, event: 'filled', credentialId, detail: null });
  const save = page.op === 'submit' && page.save;
  if (save) await vault.saveSiteCredential({ ...audit, kind: asked.kind, value });
  return success({ outcome: 'provided', saved: save });
}
