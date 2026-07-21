import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  BlobStore,
  isImageDataUrl,
  resolveImageData,
  resolveImageDataSync,
  resolveImageDataUrl,
} from '@oh-my-pi/pi-coding-agent/session/blob-store';
import { resolveBlobRefsInEntries } from '@oh-my-pi/pi-coding-agent/session/session-loader';

/**
 * Regression test for the patched oh-my-pi blob resolver (patches/@oh-my-pi…).
 *
 * When an image's backing blob is missing (evicted, or resolved against a
 * different blobs dir after a snapcompact + reopen), the upstream resolvers
 * returned the raw `blob:sha256:…` reference. Downstream that ref was spliced
 * into an `image_url` / `data:` URL as if it were base64 — producing a provider
 * 400 ("invalid image_url / invalid base64") that permanently bricked the
 * session. The GitSpace patch degrades a missing blob to a valid transparent
 * PNG so the payload is always structurally valid and never 400s.
 */

const MISSING_REF = 'blob:sha256:0000000000000000000000000000000000000000000000000000000000000000';

function isValidBase64(value: string): boolean {
  if (value.length === 0 || value.length % 4 !== 0) return false;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  // Round-trips cleanly and decodes to non-empty bytes.
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value;
}

let dir: string;
let store: BlobStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'blob-store-missing-'));
  store = new BlobStore(dir); // empty store: every blob is a miss
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('missing-blob image resolution never yields invalid base64', () => {
  it('resolveImageDataUrl returns a valid, self-describing image data URL', async () => {
    const resolved = await resolveImageDataUrl(store, MISSING_REF);
    expect(resolved).not.toBe(MISSING_REF);
    expect(resolved.startsWith('blob:')).toBe(false);
    expect(isImageDataUrl(resolved)).toBe(true);
    const b64 = resolved.slice(resolved.indexOf(';base64,') + ';base64,'.length);
    expect(isValidBase64(b64)).toBe(true);
    // Real PNG magic bytes.
    expect(Buffer.from(b64, 'base64').subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  });

  it('resolveImageData returns valid base64 (not the raw ref)', async () => {
    const resolved = await resolveImageData(store, MISSING_REF);
    expect(resolved).not.toBe(MISSING_REF);
    expect(resolved.startsWith('blob:')).toBe(false);
    expect(isValidBase64(resolved)).toBe(true);
  });

  it('resolveImageDataSync returns valid base64 (not the raw ref)', () => {
    const resolved = resolveImageDataSync(store, MISSING_REF);
    expect(resolved).not.toBe(MISSING_REF);
    expect(resolved.startsWith('blob:')).toBe(false);
    expect(isValidBase64(resolved)).toBe(true);
  });

  it('passthrough: a non-blob-ref value is returned unchanged', async () => {
    const inline = 'data:image/png;base64,iVBORw0KGgo=';
    expect(await resolveImageDataUrl(store, inline)).toBe(inline);
  });

  it('resolveBlobRefsInEntries leaves no unresolved image_url blob refs', async () => {
    // Shape mirrors a persisted transport image_url content part and an image block.
    const entries = [
      {
        type: 'message',
        message: {
          role: 'user',
          content: [
            { type: 'text', text: 'here is an image' },
            { image_url: MISSING_REF },
            { type: 'image', data: MISSING_REF, mimeType: 'image/png' },
          ],
        },
      },
    ] as unknown as Parameters<typeof resolveBlobRefsInEntries>[0];

    await resolveBlobRefsInEntries(entries, store);

    const serialized = JSON.stringify(entries);
    // No raw ref survived anywhere in the resolved tree.
    expect(serialized).not.toContain('blob:sha256:');

    const content = (entries[0] as unknown as { message: { content: Array<Record<string, string>> } }).message.content;
    const imageUrlPart = content.find((c) => 'image_url' in c)!;
    expect(isImageDataUrl(imageUrlPart.image_url)).toBe(true);
    const imageBlock = content.find((c) => c.type === 'image')!;
    expect(isValidBase64(imageBlock.data)).toBe(true);
  });
});
