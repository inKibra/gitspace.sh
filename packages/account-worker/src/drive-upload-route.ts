import { TENANT_OBJECT_PART_BYTES } from '@gitspace/protocol';
import { DRIVE_UPLOAD_PATH } from '@gitspace/protocol/rpc-contract';
import { DEVICE_AUTHORITY_UNAVAILABLE, withDeviceAuthority } from './device-authority.js';
import { InspectorCloudArtifacts, InspectorGenerationConflict, InspectorWorkspaceMissing, readInspectorContext } from './account-inspector-data.js';

const partPath = new RegExp(`^${DRIVE_UPLOAD_PATH}/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/parts/([1-9][0-9]{0,4})$`, 'u');

function failure(status: number, code: string, message: string): Response {
  return Response.json({ status: 'error', error: { code, message } }, { status, headers: { 'cache-control': 'no-store' } });
}

/**
 * `PUT <DRIVE_UPLOAD_PATH>/<uploadId>/parts/<n>?spaceId=<id>&expectedGeneration=<g>`: one raw part of an Inspector
 * upload begun with `inspector.artifacts.uploadBegin`, signed by an enrolled device with write authority over the
 * account (the signature covers the path, the space identity in the query, and the body). The part goes straight into
 * the upload's multipart object; RPC bodies would carry it base64 in 256 KiB chunks.
 */
export async function serveDriveUploadPart(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = partPath.exec(url.pathname);
  if (!match) return failure(404, 'NOT_FOUND', 'Unknown upload part');
  if (request.method !== 'PUT') return failure(405, 'METHOD_NOT_ALLOWED', 'Upload parts are sent with PUT');
  const spaceId = url.searchParams.get('spaceId');
  const expectedGeneration = Number(url.searchParams.get('expectedGeneration'));
  if (!spaceId || !Number.isSafeInteger(expectedGeneration) || expectedGeneration < 0) return failure(400, 'UPLOAD_PART_INVALID', 'Name the space and its generation');
  const declared = Number(request.headers.get('content-length'));
  if (!Number.isSafeInteger(declared) || declared < 1 || declared > TENANT_OBJECT_PART_BYTES) return failure(413, 'UPLOAD_PART_TOO_LARGE', `A part is 1 to ${TENANT_OBJECT_PART_BYTES} bytes with its Content-Length`);
  const body = new Uint8Array(await request.arrayBuffer());
  if (body.byteLength !== declared) return failure(400, 'UPLOAD_PART_INVALID', 'The part does not match its Content-Length');
  const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({
    header: request.headers.get('x-gitspace-device'), method: 'PUT', target: `${url.pathname}${url.search}`, body,
    capabilities: ['rpc.write'], accountScope: true,
  }, now));
  if (auth.status === 'error') return failure(auth.error.code === 'RPC_FORBIDDEN' ? 403 : auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : 401, auth.error.code, auth.error.message);
  try {
    const source = await readInspectorContext(env, env.ACCOUNT_ID, spaceId, undefined, expectedGeneration);
    const stored = await new InspectorCloudArtifacts(env, env.ACCOUNT_ID, source).uploadPart(match[1]!, Number(match[2]), body);
    return Response.json({ status: 'ok', value: stored }, { headers: { 'cache-control': 'no-store' } });
  } catch (error) {
    if (error instanceof InspectorWorkspaceMissing) return failure(404, 'WORKSPACE_NOT_FOUND', error.message);
    if (error instanceof InspectorGenerationConflict) return failure(409, 'SPACE_GENERATION_CONFLICT', error.message);
    return failure(409, 'UPLOAD_PART_REJECTED', error instanceof Error ? error.message : 'The part was refused');
  }
}
