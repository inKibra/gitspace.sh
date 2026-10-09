import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResourcePreviewFrame } from '@gitspace/protocol/resource-uri';
import { loadInspectorContent, loadInspectorResource } from './resource-content.js';

const url = 'local://workspace/live-capture.wav';
const bytes = Uint8Array.from({ length: 192 * 1024 + 7 }, (_, index) => index % 251);
async function* frames(body = bytes, text = false) {
  yield { status: 'ok' as const, value: { type: 'metadata', url, text, mediaType: text ? 'text/plain' : 'audio/wav', size: body.length } satisfies ResourcePreviewFrame };
  for (let offset = 0; offset < body.length; offset += 48 * 1024) {
    yield { status: 'ok' as const, value: { type: 'chunk', base64: Buffer.from(body.subarray(offset, offset + 48 * 1024)).toString('base64') } satisfies ResourcePreviewFrame };
  }
}
afterEach(() => vi.restoreAllMocks());

describe('Inspector bounded resource content', () => {
  it('assembles cloud media exactly without an originating session and revokes each object URL once', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (!(blob instanceof Blob)) throw new Error('Expected a Blob preview'); blobs.push(blob); return `blob:preview-${blobs.length}`; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const transport = { readArtifact: vi.fn(() => frames()), readResource: vi.fn(() => frames()) };
    const context = { spaceId: 'workspace', projectId: 'project', generation: 3, sessionId: null, runtimeAvailable: true };
    const published = await loadInspectorContent(frames(), url);
    const durable = await loadInspectorResource(transport, context, url);
    const live = await loadInspectorResource(transport, context, 'local://live-capture.wav');
    for (const [index, content] of [published, durable, live].entries()) {
      expect(content.source).toBeNull();
      expect(content.mediaType).toBe('audio/wav');
      expect(new Uint8Array(await blobs[index]!.arrayBuffer())).toEqual(bytes);
      expect(content.previewUrl).toBe(`blob:preview-${index + 1}`);
      content.dispose?.();
      content.dispose?.();
    }
    expect(revoke.mock.calls).toEqual([['blob:preview-1'], ['blob:preview-2'], ['blob:preview-3']]);
  });

  it('does not publish bytes when a full body is followed by a typed stream failure', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    const failure = { _tag: 'client/network-failure', data: { reason: 'interrupted' } };
    async function* interrupted() { yield* frames(); yield { status: 'error' as const, error: failure }; }
    await expect(loadInspectorContent(interrupted(), url)).rejects.toBe(failure);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects truncated bodies and cancellation without publishing a preview', async () => {
    const create = vi.spyOn(URL, 'createObjectURL');
    async function* truncated() { yield { status: 'ok' as const, value: { type: 'metadata', url, text: false, mediaType: 'audio/wav', size: bytes.length } satisfies ResourcePreviewFrame }; }
    await expect(loadInspectorContent(truncated(), url)).rejects.toThrow('Incomplete resource preview');
    const controller = new AbortController();
    async function* cancelled() { yield* frames(); controller.abort(); }
    await expect(loadInspectorContent(cancelled(), url, controller.signal)).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });

  it('reconstructs UTF-8 source across chunk boundaries only for text previews', async () => {
    const source = `${'a'.repeat(48 * 1024 - 1)}€ rendered source`;
    const content = await loadInspectorContent(frames(new TextEncoder().encode(source), true), url);
    try { expect(content.source).toBe(source); } finally { content.dispose?.(); }
  });
  it('reads expiring browser output by bounded pages without treating it as a machine file', async () => {
    const source = `${'line one\n'.repeat(5000)}last line`;
    const body = new TextEncoder().encode(source);
    const artifact = { id: 'output', url: 'browser-artifact://machine/output', mediaType: 'text/plain', bytes: body.length, expiresAt: new Date(Date.now() + 60_000).toISOString() };
    const transport = {
      readArtifact: vi.fn(() => frames()), readResource: vi.fn(() => frames()),
      readBrowserArtifact: vi.fn(async ({ offset, limit }: { offset: number; limit: number }) => {
        const end = Math.min(body.length, offset + limit);
        return { artifact, offset, nextOffset: end < body.length ? end : null, data: Buffer.from(body.subarray(offset, end)).toString('base64') };
      }),
    };
    const context = { spaceId: 'workspace', projectId: 'project', generation: 1, sessionId: null, runtimeAvailable: false };
    const content = await loadInspectorResource(transport, context, `${artifact.url}:2-3`);
    try { expect(content.source).toBe('line one\nline one'); } finally { content.dispose?.(); }
    expect(transport.readArtifact).not.toHaveBeenCalled();
    expect(transport.readResource).not.toHaveBeenCalled();
    transport.readBrowserArtifact.mockImplementation(async ({ offset }) => ({ artifact, offset, nextOffset: offset, data: '' }));
    await expect(loadInspectorResource(transport, context, artifact.url)).rejects.toThrow('Invalid browser artifact cursor');
  });
});
