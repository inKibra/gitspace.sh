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
  it('assembles large media exactly through both artifact and resource routes and revokes each object URL once', async () => {
    const blobs: Blob[] = [];
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => { if (!(blob instanceof Blob)) throw new Error('Expected a Blob preview'); blobs.push(blob); return `blob:preview-${blobs.length}`; });
    const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const transport = { readArtifact: vi.fn(() => frames()), readResource: vi.fn(() => frames()) };
    const context = { spaceId: 'workspace', projectId: 'project', generation: 3, sessionId: 'session', runtimeAvailable: true };
    const published = await loadInspectorContent(frames(), url);
    const durable = await loadInspectorResource(transport, context, url);
    const live = await loadInspectorResource(transport, context, 'local://live-capture.wav');
    expect(transport.readArtifact).toHaveBeenCalledOnce();
    expect(transport.readResource).toHaveBeenCalledOnce();
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
});
