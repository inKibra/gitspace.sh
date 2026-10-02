import { canonicalLocalResourceUrl, parseResourceUri, type ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import type { InspectorArtifactContent } from './inspector/Inspector.js';

type ReadResult = { status: 'ok'; value: ResourcePreviewFrame } | { status: 'error'; error: unknown };
interface ResourceTransport {
  readArtifact(input: { spaceId: string; expectedGeneration: number; url: string; hash: null }, options: { signal?: AbortSignal }): AsyncIterable<ReadResult>;
  readResource(input: { spaceId: string; expectedGeneration: number; sessionId: string | null; url: string }, options: { signal?: AbortSignal }): AsyncIterable<ReadResult>;
}

/** Do not publish partial bytes, including a complete body followed by a stream error. */
export async function loadInspectorContent(stream: AsyncIterable<ReadResult>, url: string, signal?: AbortSignal): Promise<InspectorArtifactContent> {
  let metadata: Extract<ResourcePreviewFrame, { type: 'metadata' }> | undefined;
  const parts: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  for await (const result of stream) {
    signal?.throwIfAborted();
    if (result.status === 'error') throw result.error;
    const frame = result.value;
    if (frame.type === 'metadata') {
      if (metadata || typeof frame.url !== 'string' || !frame.url || typeof frame.text !== 'boolean' || (frame.mediaType !== null && typeof frame.mediaType !== 'string') || !Number.isSafeInteger(frame.size) || frame.size < 0 || frame.size > 16 * 1024 * 1024 || (frame.text && frame.size > 128 * 1024)) throw new Error('Invalid resource preview metadata');
      metadata = frame;
    } else {
      if (!metadata || frame.type !== 'chunk' || typeof frame.base64 !== 'string' || frame.base64.length > 64 * 1024 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(frame.base64)) throw new Error('Invalid resource preview chunk');
      const decoded = atob(frame.base64);
      size += decoded.length;
      if (!decoded.length || decoded.length > 48 * 1024 || size > metadata.size) throw new Error('Invalid resource preview length');
      const bytes = new Uint8Array(decoded.length);
      for (let index = 0; index < decoded.length; index++) bytes[index] = decoded.charCodeAt(index);
      parts.push(bytes);
    }
  }
  signal?.throwIfAborted();
  if (!metadata || size !== metadata.size) throw new Error('Incomplete resource preview');
  const mediaType = metadata.mediaType ?? 'application/octet-stream';
  const blob = new Blob(parts, { type: mediaType });
  const source = metadata.text ? await blob.text() : null;
  signal?.throwIfAborted();
  const previewUrl = URL.createObjectURL(blob);
  let disposed = false;
  return { url, source, mediaType, previewUrl, dispose() { if (!disposed) { disposed = true; URL.revokeObjectURL(previewUrl); } } };
}

export async function loadInspectorResource(transport: ResourceTransport, context: {
  spaceId: string;
  projectId: string;
  generation: number;
  sessionId: string | null;
  runtimeAvailable: boolean;
}, uri: string, signal?: AbortSignal): Promise<InspectorArtifactContent> {
  const resource = parseResourceUri(uri);
  if (!resource) throw new Error('Unsupported or unsafe resource URI');
  const request = { spaceId: context.spaceId, expectedGeneration: context.generation };
  const durable = resource.kind === 'local' && (resource.mount !== null || !context.runtimeAvailable);
  if (!durable && (!context.runtimeAvailable || context.sessionId === null)) throw new Error('Open this workspace on its machine to read this session resource. Tool outputs are not part of the saved artifact catalog.');
  const stream = durable && resource.kind === 'local'
    ? transport.readArtifact({ ...request, url: `${canonicalLocalResourceUrl(resource, context.spaceId === context.projectId ? 'base' : 'workspace')}${resource.suffix}`, hash: null }, { signal })
    : transport.readResource({ ...request, sessionId: context.sessionId, url: uri }, { signal });
  return loadInspectorContent(stream, uri, signal);
}
