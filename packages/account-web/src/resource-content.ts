import { canonicalLocalResourceUrl, parseResourceUri } from '@gitspace/protocol/resource-uri';
import type { InspectorArtifactContent } from './inspector/Inspector.js';

type ResourceBytes = { url: string; mediaType: string | null; base64: string; text: string | null };
type ReadResult = { status: 'ok'; value: ResourceBytes } | { status: 'error'; error: { message: string } };
interface ResourceTransport {
  readArtifact(input: { spaceId: string; expectedGeneration: number; url: string; hash: null }): Promise<ReadResult>;
  readResource(input: { spaceId: string; expectedGeneration: number; sessionId: string | null; url: string }): Promise<ReadResult>;
}
const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: 'text/markdown', markdown: 'text/markdown', html: 'text/html', htm: 'text/html', json: 'application/json',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', mp3: 'audio/mpeg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
};

export async function loadInspectorResource(transport: ResourceTransport, context: {
  spaceId: string;
  projectId: string;
  generation: number;
  sessionId: string | null;
  runtimeAvailable: boolean;
}, uri: string): Promise<InspectorArtifactContent> {
  const resource = parseResourceUri(uri);
  if (!resource) throw new Error('Unsupported or unsafe resource URI');
  const request = { spaceId: context.spaceId, expectedGeneration: context.generation };
  const durable = resource.kind === 'local' && (resource.mount !== null || !context.runtimeAvailable);
  if (!durable && (!context.runtimeAvailable || context.sessionId === null)) throw new Error('Open this workspace on its machine to read this session resource. Tool outputs are not part of the saved artifact catalog.');
  const result = durable && resource.kind === 'local'
    ? await transport.readArtifact({ ...request, url: `${canonicalLocalResourceUrl(resource, context.spaceId === context.projectId ? 'base' : 'workspace')}${resource.suffix}`, hash: null })
    : await transport.readResource({ ...request, sessionId: context.sessionId, url: uri });
  if (result.status === 'error') throw new Error(result.error.message);
  const mediaType = result.value.mediaType ?? (resource.kind === 'local' ? MEDIA_TYPES[resource.path.split('.').at(-1)?.toLowerCase() ?? ''] : 'text/plain') ?? 'application/octet-stream';
  return { url: uri, source: result.value.text, mediaType, previewUrl: `data:${mediaType};base64,${result.value.base64}` };
}
