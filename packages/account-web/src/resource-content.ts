import { canonicalLocalResourceUrl, createResourcePreview, parseResourceUri, type ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import type { RuntimeBrowserArtifactPage } from '@gitspace/protocol-runtime';
import type { InspectorArtifactContent } from './inspector/Inspector.js';

type ReadResult = { status: 'ok'; value: ResourcePreviewFrame } | { status: 'error'; error: unknown };
interface ResourceTransport {
  readArtifact(input: { spaceId: string; expectedGeneration: number; url: string; hash: null }, options: { signal?: AbortSignal }): AsyncIterable<ReadResult>;
  readResource(input: { spaceId: string; expectedGeneration: number; sessionId: string | null; url: string }, options: { signal?: AbortSignal }): AsyncIterable<ReadResult>;
  readBrowserArtifact?(input: { machineId: string; artifactId: string; offset: number; limit: number }, signal?: AbortSignal): Promise<RuntimeBrowserArtifactPage>;
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
  if (resource.kind === 'browser-artifact') {
    if (!transport.readBrowserArtifact) throw new Error('Browser artifacts require their authorized cloud workspace and expire after ten minutes.');
    let page = await transport.readBrowserArtifact({ machineId: resource.machineId, artifactId: resource.id, offset: 0, limit: 32768 }, signal);
    const metadata = page.artifact;
    if (metadata.id !== resource.id || metadata.url !== resource.url || metadata.bytes > 2_000_000 || Date.parse(metadata.expiresAt) <= Date.now()) throw new Error('Browser artifact is expired or invalid');
    if (!['application/json', 'text/plain', 'image/jpeg', 'image/png', 'image/webp'].includes(metadata.mediaType)) throw new Error('Unsupported browser artifact media type');
    const bytes = new Uint8Array(metadata.bytes);
    let offset = 0;
    for (;;) {
      signal?.throwIfAborted();
      if (page.offset !== offset || JSON.stringify(page.artifact) !== JSON.stringify(metadata)) throw new Error('Browser artifact changed during read');
      const data = atob(page.data);
      if (data.length > 32768 || offset + data.length > bytes.length) throw new Error('Invalid browser artifact page length');
      for (let index = 0; index < data.length; index++) bytes[offset + index] = data.charCodeAt(index);
      offset += data.length;
      if (page.nextOffset === null) {
        if (offset !== bytes.length) throw new Error('Incomplete browser artifact');
        break;
      }
      if (data.length === 0 || page.nextOffset !== offset || offset >= bytes.length) throw new Error('Invalid browser artifact cursor');
      page = await transport.readBrowserArtifact({ machineId: resource.machineId, artifactId: resource.id, offset, limit: 32768 }, signal);
    }
    return loadInspectorContent((async function* () {
      for (const value of createResourcePreview(uri, bytes, metadata.mediaType)) yield { status: 'ok' as const, value };
    })(), uri, signal);
  }
  const request = { spaceId: context.spaceId, expectedGeneration: context.generation };
  const durable = resource.kind === 'local' && (resource.mount !== null || !context.runtimeAvailable);
  if (!durable && (!context.runtimeAvailable || context.sessionId === null)) throw new Error('Open this workspace on its machine to read this session resource. Tool outputs are not part of the saved artifact catalog.');
  const stream = durable && resource.kind === 'local'
    ? transport.readArtifact({ ...request, url: `${canonicalLocalResourceUrl(resource, context.spaceId === context.projectId ? 'base' : 'workspace')}${resource.suffix}`, hash: null }, { signal })
    : transport.readResource({ ...request, sessionId: context.sessionId, url: uri }, { signal });
  return loadInspectorContent(stream, uri, signal);
}
