import { z } from 'zod';
import { TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { UPLOAD_LINK_PATH } from '@gitspace/protocol/rpc-contract';
import { InspectorCloudArtifacts, InspectorGenerationConflict, InspectorWorkspaceMissing, readInspectorContext } from './account-inspector-data.js';
import { BrowserUploadPartSchema, type BrowserUploadReply, type BrowserUploadStep } from './browser-upload.js';
import { openToken, sealToken, type SealedTokenKind } from './sealed-token.js';
import type { DriveUpload } from './drive-files.js';
import type { WorkspaceDrive } from './workspace-drive.js';

/**
 * Upload links: how bytes reach a drive upload once an authenticated caller began it (an Inspector upload over RPC, a
 * file from your Chrome with its pairing key). Beginning returns a sealed link to that one upload; the client sends
 * `PUT <link>/parts/<n>` (1-based, raw bytes, every part `TENANT_OBJECT_PART_BYTES` but the last), then
 * `POST <link>/complete`, or `DELETE <link>` to give up. A part streams into the upload's R2 multipart object as it
 * arrives, never held whole by the Worker.
 *
 * A link is a bearer capability for that upload only: it writes nothing else, publishes only at the path reserved when
 * it began, within its declared size (and digest, when declared), and stops working when it expires or the upload ends.
 */
export const UPLOAD_LINK_MS = 24 * 60 * 60_000;
const UPLOAD_LINK: SealedTokenKind = { scope: 'upload-url:v1', context: 'gitspace-upload-url-v1' };
const COMPLETE_BODY_BYTES = 16 * 1024;

const UploadLinkTargetSchema = z.discriminatedUnion('kind', [
  /** An Inspector upload into `spaceId`'s writable drive at its generation when it began. */
  z.object({ kind: z.literal('drive'), spaceId: z.string().min(1), generation: z.number().int().nonnegative(), uploadId: z.string().uuid() }),
  /** A download or capture file from a paired Chrome, its session kept by the relay. */
  z.object({ kind: z.literal('browser'), pairingId: z.string().uuid(), uploadId: z.string().uuid() }),
]);
export type UploadLinkTarget = z.infer<typeof UploadLinkTargetSchema>;
const UploadGrantSchema = z.object({ version: z.literal(1), target: UploadLinkTargetSchema, expiresAt: z.number().int() });

/** An absolute upload link for `target`, valid for `UPLOAD_LINK_MS`. */
export async function mintUploadLink(env: Env, target: UploadLinkTarget): Promise<string> {
  const token = await sealToken(env, UPLOAD_LINK, UploadGrantSchema.parse({ version: 1, target, expiresAt: Date.now() + UPLOAD_LINK_MS }));
  return new URL(`${UPLOAD_LINK_PATH}/${token}`, env.ACCOUNT_URL).href;
}

/** What `serveUploadLink` needs besides the link: the relay for Chrome uploads and a workspace's drive. */
export interface UploadLinkDependencies {
  relay: { browserRelayUpload(step: BrowserUploadStep): Promise<BrowserUploadReply> };
  drive(identity: { projectId: string; workspaceId: string }): Pick<WorkspaceDrive, 'append'>;
}

const linkPath = new RegExp(`^${UPLOAD_LINK_PATH}/([A-Za-z0-9_-]{40,2048})(?:/parts/([1-9][0-9]{0,4})|/(complete))?$`, 'u');

function reply(status: number, body: { status: 'ok'; value: unknown } | { status: 'error'; error: { code: string; message: string } }): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' } });
}
const refused = (status: number, code: string, message: string) => reply(status, { status: 'error', error: { code, message } });
const browserReply = (result: BrowserUploadReply) => result.ok ? reply(200, { status: 'ok', value: result.value }) : refused(result.status, result.code, result.message);

/** `PUT|POST|DELETE <UPLOAD_LINK_PATH>/<token>[/parts/<n>|/complete]`. */
export async function serveUploadLink(request: Request, env: Env, dependencies: UploadLinkDependencies): Promise<Response> {
  const match = linkPath.exec(new URL(request.url).pathname);
  if (!match) return refused(404, 'UPLOAD_LINK_UNKNOWN', 'Unknown upload link');
  const route = match[2] ? 'part' : match[3] ? 'complete' : 'abort';
  const method = { part: 'PUT', complete: 'POST', abort: 'DELETE' }[route];
  if (request.method !== method) return refused(405, 'METHOD_NOT_ALLOWED', `Use ${method} here`);
  let grant: z.infer<typeof UploadGrantSchema>;
  try { grant = UploadGrantSchema.parse(await openToken(env, UPLOAD_LINK, match[1]!)); }
  catch { return refused(404, 'UPLOAD_LINK_UNKNOWN', 'Unknown upload link'); }
  if (grant.expiresAt <= Date.now()) return refused(410, 'UPLOAD_LINK_EXPIRED', 'This upload link expired; start the upload again');

  let action: { route: 'part'; number: number; stream: ReadableStream<Uint8Array>; size: number } | { route: 'complete'; body: unknown } | { route: 'abort' };
  if (route === 'part') {
    const size = Number(request.headers.get('content-length'));
    if (!Number.isSafeInteger(size) || size < 1 || size > TENANT_OBJECT_PART_BYTES || !request.body) return refused(413, 'UPLOAD_PART_SIZE', `A part is 1 to ${TENANT_OBJECT_PART_BYTES / 1024 / 1024} MiB, sent with its Content-Length`);
    action = { route, number: Number(match[2]), stream: request.body, size };
  } else if (route === 'complete') {
    if (Number(request.headers.get('content-length') ?? 0) > COMPLETE_BODY_BYTES) return refused(413, 'UPLOAD_INVALID', 'Upload request too large');
    const text = await request.text();
    if (text.length > COMPLETE_BODY_BYTES) return refused(413, 'UPLOAD_INVALID', 'Upload request too large');
    try { action = { route, body: text ? JSON.parse(text) : null }; } catch { return refused(400, 'UPLOAD_INVALID', 'Upload request must be JSON'); }
  } else action = { route };

  const target = grant.target;
  if (target.kind === 'browser') {
    const { uploadId, pairingId } = target;
    if (action.route === 'complete') return browserReply(await dependencies.relay.browserRelayUpload({ op: 'complete', pairingId, uploadId, body: action.body }));
    if (action.route === 'abort') return browserReply(await dependencies.relay.browserRelayUpload({ op: 'abort', pairingId, uploadId }));
    const index = action.number - 1;
    const checked = await dependencies.relay.browserRelayUpload({ op: 'part', pairingId, uploadId, index });
    if (!checked.ok) return browserReply(checked);
    const next = BrowserUploadPartSchema.parse(checked.value);
    let drive: DriveUpload;
    try { drive = await dependencies.drive(next).append(next.drive, action.stream, action.size); }
    catch (error) { return refused(409, 'UPLOAD_PART_REJECTED', error instanceof Error ? error.message : 'The part was refused'); }
    return browserReply(await dependencies.relay.browserRelayUpload({ op: 'stored', uploadId, index, size: action.size, drive }));
  }

  try {
    const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, await readInspectorContext(env, env.ACCOUNT_ID, target.spaceId, undefined, target.generation));
    const value = action.route === 'part' ? await artifacts.uploadPart(target.uploadId, action.number, action)
      : action.route === 'complete' ? await artifacts.commitUpload(target.uploadId)
        : await artifacts.abortUpload(target.uploadId);
    return reply(200, { status: 'ok', value });
  } catch (error) {
    if (error instanceof InspectorWorkspaceMissing) return refused(404, 'WORKSPACE_NOT_FOUND', error.message);
    if (error instanceof InspectorGenerationConflict) return refused(409, 'SPACE_GENERATION_CONFLICT', error.message);
    return refused(409, 'UPLOAD_REJECTED', error instanceof Error ? error.message : 'The upload was refused');
  }
}
