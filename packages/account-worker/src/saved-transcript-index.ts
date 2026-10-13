import { transcriptPageRequestSchema, transcriptContentRequestSchema, type TranscriptContentPage, type TranscriptContentRequest, type TranscriptPage, type TranscriptPageRequest } from '@gitspace/blocks';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import type { SavedTranscriptIndexDO } from './saved-transcript-index-do.js';

const encoder = new TextEncoder();
// A generation identifies an immutable source and projection, not a build attempt.
const INDEX_VERSION = 3;

/** A private durable projection. Neither the caller nor the owner collects history. */
export class SavedTranscriptIndex {
  private constructor(
    private readonly owner: DurableObjectStub<SavedTranscriptIndexDO>,
    readonly generation: string,
    private readonly key: Uint8Array | null,
  ) {}

  static async locate(
    namespace: DurableObjectNamespace<SavedTranscriptIndexDO>, userId: string, identity: readonly unknown[], key: Uint8Array | null,
  ): Promise<SavedTranscriptIndex> {
    const digest = await crypto.subtle.digest('SHA-256', encoder.encode(JSON.stringify([INDEX_VERSION, userId, ...identity, key !== null])));
    const generation = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    return new SavedTranscriptIndex(namespace.getByName(`${userId}:${generation}`), generation, key);
  }

  async ready(): Promise<boolean> { return this.owner.ready(this.generation, this.key); }

  static async open(
    namespace: DurableObjectNamespace<SavedTranscriptIndexDO>, userId: string, identity: readonly unknown[], key: Uint8Array | null,
    load: () => Promise<AsyncIterable<TranscriptEvent> | Iterable<TranscriptEvent>>,
  ): Promise<SavedTranscriptIndex> {
    const index = await SavedTranscriptIndex.locate(namespace, userId, identity, key);
    if (!await index.ready()) {
      // Pull-driven serialization keeps only one event in flight. The source reader
      // authenticates the immutable checkpoint before exposing its selected branch.
      const events = await load();
      const iterator = (async function* () { yield* events; })();
      const stream = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) controller.close();
            else controller.enqueue(encoder.encode(`${JSON.stringify(next.value)}\n`));
          } catch (error) { controller.error(error); }
        },
        async cancel() { await iterator.return(); },
      }, { highWaterMark: 0 });
      await index.owner.build(index.generation, key, stream);
    }
    return index;
  }

  async page(request: TranscriptPageRequest): Promise<TranscriptPage> {
    return this.owner.page(this.generation, this.key, transcriptPageRequestSchema.parse(request));
  }

  async content(request: TranscriptContentRequest): Promise<TranscriptContentPage> {
    return this.owner.content(this.generation, this.key, transcriptContentRequestSchema.parse(request));
  }
}
