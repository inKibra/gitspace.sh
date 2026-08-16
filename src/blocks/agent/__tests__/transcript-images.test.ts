/**
 * Transcript images, against the shape sessions actually persist.
 *
 * Real entries carry `{ type:'image', data:'blob:sha256:<hex>', mimeType }` —
 * the bytes are in the session blob store. The block builder splices `data`
 * into `data:<mime>;base64,<data>`, so an unresolved ref produced
 * `data:image/png;base64,blob:sha256:…`: not a valid URL, an <img> that fails
 * silently, and no image ever visible in the transcript.
 *
 * The existing block tests pass `data: 'TOOL_IMAGE'` — a literal that merely
 * looks like base64 — which is why they never caught this. These use a blob ref.
 */
import { describe, expect, it } from 'bun:test';
import { getTranscriptRange, type TranscriptEntry, type TranscriptSource } from '../transcript-source.js';
import { imageData } from '../../types/transcript.js';
import type { Block } from '../../index.js';

const HASH = 'a'.repeat(64);
const BLOB_REF = `blob:sha256:${HASH}`;
/** A 1x1 PNG, as a stand-in for what the blob store hands back. */
const REAL_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function sourceOf(entries: TranscriptEntry[]): TranscriptSource {
  const byId = new Map(entries.map((e) => [e.id, e]));
  return {
    getLeafId: () => entries[entries.length - 1]?.id ?? null,
    getEntry: (id: string) => byId.get(id),
  };
}

/**
 * A `read` of a png, as a session persists it: the assistant's toolCall entry
 * and then the toolResult. Both are required — a result is paired to its call,
 * so an orphan toolResult renders no blocks at all.
 */
function imageEntries(data: string): TranscriptEntry[] {
  return [
    {
      id: 'e0',
      parentId: null,
      type: 'message',
      message: {
        role: 'assistant',
        content: [{ type: 'toolCall', id: 'call_1', name: 'read', arguments: { path: '/tmp/shot.png' } }],
      } as unknown as TranscriptEntry['message'],
    },
    {
      id: 'e1',
      parentId: 'e0',
      type: 'message',
      message: {
        role: 'toolResult',
        toolCallId: 'call_1',
        toolName: 'read',
        content: [
          { type: 'text', text: 'Read image file [image/png]' },
          { type: 'image', data, mimeType: 'image/png' },
        ],
        isError: false,
      } as unknown as TranscriptEntry['message'],
    },
  ];
}

/** Every image src on a page, including those nested in a tool result. */
function imageSrcs(blocks: readonly Block[]): string[] {
  const srcs: string[] = [];
  for (const block of blocks) {
    if (block.type === 'image') {
      srcs.push(imageData.parse(block.data).src);
      continue;
    }
    const data: unknown = block.data;
    if (!data || typeof data !== 'object' || !('result' in data)) continue;
    const result = data.result;
    if (!Array.isArray(result)) continue;
    for (const inner of result) {
      if (!inner || typeof inner !== 'object') continue;
      if (!('type' in inner) || inner.type !== 'image' || !('data' in inner)) continue;
      srcs.push(imageData.parse(inner.data).src);
    }
  }
  return srcs;
}

describe('transcript image blob refs', () => {
  it('resolves a blob ref into a usable data URL', () => {
    const page = getTranscriptRange(sourceOf(imageEntries(BLOB_REF)), {
      limit: 10,
      resolveImageData: (data) => (data === BLOB_REF ? REAL_BASE64 : data),
    });

    const srcs = imageSrcs(page.blocks);
    expect(srcs.length).toBe(1);
    expect(srcs[0]).toBe(`data:image/png;base64,${REAL_BASE64}`);
  });

  it('without a resolver the src is the malformed URL that rendered nothing', () => {
    // Pins the actual defect, so a regression is a failing test rather than an
    // invisible blank in the UI.
    const page = getTranscriptRange(sourceOf(imageEntries(BLOB_REF)), { limit: 10 });
    expect(imageSrcs(page.blocks)[0]).toBe(`data:image/png;base64,${BLOB_REF}`);
  });

  it('leaves already-inline base64 untouched', () => {
    const page = getTranscriptRange(sourceOf(imageEntries(REAL_BASE64)), {
      limit: 10,
      resolveImageData: (data) => data,
    });
    expect(imageSrcs(page.blocks)[0]).toBe(`data:image/png;base64,${REAL_BASE64}`);
  });

  it('does not mutate the session entries it was given', () => {
    const entries = imageEntries(BLOB_REF);
    getTranscriptRange(sourceOf(entries), { limit: 10, resolveImageData: () => REAL_BASE64 });

    // The entries belong to the live session; inflating them would keep every
    // viewed image resident in memory.
    // The image lives on the toolResult entry (entries[0] is its toolCall).
    const content = entries[1].message?.content;
    if (!Array.isArray(content)) throw new Error('expected content parts');
    const image = content.find((part) => part.type === 'image');
    if (!image || image.type !== 'image') throw new Error('expected an image part');
    expect(image.data).toBe(BLOB_REF);
  });
});
