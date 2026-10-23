import { signedControlRequestSchema, TENANT_OBJECT_PART_BYTES, type SignedControlRequest } from '@gitspace/protocol';
import { CloudDataCheckpointBlobStore } from '../src/cloud-space-authority.js';

type StoredObject = { bytes: Uint8Array; workspaceId: string | null };

function sha256(bytes: Uint8Array): string {
  return `sha256:${new Bun.CryptoHasher('sha256').update(bytes).digest('hex')}`;
}

/**
 * The account's data endpoint as the machine sees it: plaintext bodies bound to their signed SHA-256 and size, and
 * multipart uploads declared up front and assembled on completion. `tamper` replaces a served body to model storage
 * corruption behind correct metadata.
 */
export function fakeDataEndpoint() {
  const objects = new Map<string, StoredObject>();
  const requests: SignedControlRequest[] = [];
  const uploads = new Map<string, { key: string; hash: unknown; size: unknown; parts: Map<number, Uint8Array> }>();
  const served = new Map<string, Uint8Array>();
  const headers = (object: StoredObject) => ({
    'x-gitspace-sha256': sha256(object.bytes), 'x-gitspace-size': String(object.bytes.byteLength), 'content-length': String(object.bytes.byteLength),
  });
  const refused = (status: number, code: string) => Response.json({ status: 'error', error: { code, message: code } }, { status });
  const fetcher = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(String(input));
    const signed = signedControlRequestSchema.parse(JSON.parse(Buffer.from(new Headers(init?.headers).get('x-gitspace-control')!, 'base64url').toString()));
    requests.push(signed);
    const key = url.pathname.replace('/v1/data/', '').split('/').map(decodeURIComponent).join('/');
    if (signed.payload.key !== key) return refused(403, 'KEY_MISMATCH');
    const object = objects.get(key);
    switch (`${init?.method ?? 'GET'} ${signed.operation}`) {
      case 'HEAD data.head': return new Response(null, object ? { headers: headers(object) } : { status: 404 });
      case 'GET data.get': {
        if (!object) return new Response(null, { status: 404 });
        if (signed.payload.hash !== undefined && signed.payload.hash !== sha256(object.bytes)) return refused(409, 'HASH_MISMATCH');
        return new Response(new Uint8Array(served.get(key) ?? object.bytes), { headers: headers(object) });
      }
      case 'POST data.multipart.create': {
        const uploadId = crypto.randomUUID();
        uploads.set(uploadId, { key, hash: signed.payload.hash, size: signed.payload.size, parts: new Map() });
        return Response.json({ status: 'ok', value: { uploadId, partBytes: TENANT_OBJECT_PART_BYTES } });
      }
      case 'DELETE data.multipart.abort': {
        uploads.delete(String(signed.payload.uploadId));
        return new Response(null, { status: 204 });
      }
      case 'POST data.multipart.complete': {
        const upload = uploads.get(String(signed.payload.uploadId));
        if (!upload || upload.key !== key) return refused(404, 'UPLOAD_UNKNOWN');
        uploads.delete(String(signed.payload.uploadId));
        const ordered = [...upload.parts.entries()].sort(([left], [right]) => left - right).map(([, part]) => part);
        const bytes = new Uint8Array(Buffer.concat(ordered));
        if (bytes.byteLength !== upload.size || sha256(bytes) !== upload.hash) return refused(409, 'OBJECT_CONFLICT');
        objects.set(key, { bytes, workspaceId: null });
        return Response.json({ status: 'ok', value: { hash: upload.hash, size: upload.size } }, { status: 201 });
      }
    }
    const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
    if (bytes.byteLength !== signed.payload.size || sha256(bytes) !== signed.payload.hash) return refused(400, 'OBJECT_BODY_MISMATCH');
    if (signed.operation === 'data.multipart.part') {
      uploads.get(String(signed.payload.uploadId))?.parts.set(Number(signed.payload.partNumber), bytes);
      return Response.json({ status: 'ok', value: { partNumber: signed.payload.partNumber, etag: `etag-${String(signed.payload.partNumber)}` } });
    }
    if (object) return new Response(null, { status: 204 });
    objects.set(key, { bytes, workspaceId: typeof signed.payload.workspaceId === 'string' ? signed.payload.workspaceId : null });
    return new Response(null, { status: 201 });
  }, { preconnect: fetch.preconnect });
  const options = { baseUrl: 'https://account.invalid', userId: 'account-a', machineId: 'machine-a', signingPrivateKey: new Uint8Array(32).fill(21), fetcher };
  return {
    objects, requests, options,
    store: new CloudDataCheckpointBlobStore(options),
    tamper(key: string, bytes: Uint8Array) { served.set(key, bytes); },
  };
}
