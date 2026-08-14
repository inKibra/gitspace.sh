/**
 * Server-side blob resolution for transcript images.
 *
 * The SDK persists an image part's bytes in a content-addressed blob store and
 * leaves `blob:sha256:<hex>` in the entry. `src/blocks/agent/message-blocks.ts`
 * builds `data:<mime>;base64,<data>` from that field, so an unresolved ref
 * yields `data:image/png;base64,blob:sha256:…` — not a valid URL, and an <img>
 * given one fails silently. No image had ever rendered in the transcript.
 *
 * This lives outside `src/blocks/` on purpose: that tree is shared with the
 * browser, which has no filesystem and no blob store, so the resolver is
 * injected into `getTranscriptRange` by the daemon-side hosts instead of being
 * imported by the shared page reader.
 *
 * Resolution is inline base64 rather than a served URL. That is the smaller,
 * self-contained change — no new HTTP route, no auth surface, and it works
 * identically over the relay, where a `/blob/<sha>` path would need routing on
 * both sides. The cost is transcript payload size: a page carrying several
 * screenshots inlines them at +33%, which is the reason to revisit this with an
 * endpoint if pages start feeling heavy. Pages are already bounded by entry
 * count, so the blast radius is one page at a time.
 *
 * A missing blob (evicted, or a store from another machine) resolves to a valid
 * transparent PNG via the patched SDK resolver rather than a broken ref, so the
 * failure mode is a blank image, never a corrupt payload.
 */

import { join } from 'path';
import { BlobStore, resolveImageDataSync } from '@oh-my-pi/pi-coding-agent/session/blob-store';
import { getPiAgentDir } from './pi-runtime.js';

/** One store for the process: the blob dir is global to the Pi agent dir (not
 *  per session), and `BlobStore` holds only its path. */
let store: BlobStore | null = null;

/** Inline an image part's payload. Returns non-blob data untouched, so this is
 *  safe to apply to every image part on a page. */
export function resolveTranscriptImageData(data: string): string {
  store ??= new BlobStore(join(getPiAgentDir(), 'blobs'));
  return resolveImageDataSync(store, data);
}
