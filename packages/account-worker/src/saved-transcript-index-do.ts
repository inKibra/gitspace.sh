import { DurableObject } from 'cloudflare:workers';
import { TranscriptProjector, type TranscriptContentPage, type TranscriptContentRequest, type TranscriptPage, type TranscriptPageRequest } from '@gitspace/blocks';
import type { TranscriptEvent } from '@gitspace/protocol/transcript';
import { SavedTranscriptProjection } from './saved-transcript-projection.js';

/** One immutable generation per owner. Incomplete attempts are never readable. */
export class SavedTranscriptIndexDO extends DurableObject<Env> {
  private building: Promise<void> | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    SavedTranscriptProjection.initialize(ctx.storage.sql);
  }

  ready(generation: string, key: Uint8Array | null): boolean {
    return new SavedTranscriptProjection(this.ctx.storage.sql, generation, key).ready();
  }

  async build(generation: string, key: Uint8Array | null, source: ReadableStream<Uint8Array>): Promise<void> {
    const projection = new SavedTranscriptProjection(this.ctx.storage.sql, generation, key);
    if (this.building) {
      await source.cancel();
      await this.building;
      if (!projection.ready()) throw new Error('Saved transcript index is incomplete');
      return;
    }
    try {
      if (projection.ready()) { await source.cancel(); return; }
    } catch (error) {
      await source.cancel();
      throw error;
    }
    // Do not blockConcurrencyWhile across source IO: a cold checkpoint can take
    // longer than its timeout. This promise serializes attempts in a live owner;
    // the durable complete marker fences reads after an interrupted owner dies.
    const build = this.ingest(projection, source);
    this.building = build;
    try { await build; }
    finally { if (this.building === build) this.building = null; }
  }

  private async ingest(projection: SavedTranscriptProjection, source: ReadableStream<Uint8Array>): Promise<void> {
    this.ctx.storage.transactionSync(() => projection.reset());
    const reader = source.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let projector: TranscriptProjector | undefined;
    let sessionId: string | undefined;
    let ordinal = -1;
    let fragments: string[] = [];
    let ended = false;
    const consume = (text: string) => {
      let start = 0;
      for (;;) {
        const newline = text.indexOf('\n', start);
        if (newline === -1) break;
        const part = text.slice(start, newline);
        const line = fragments.length ? [...fragments, part].join('') : part;
        fragments = [];
        const event = JSON.parse(line) as TranscriptEvent;
        if (!Number.isSafeInteger(event.ordinal) || event.ordinal <= ordinal) throw new Error('Saved transcript source is not ordered');
        if (!projector) {
          sessionId = event.sessionId;
          projector = new TranscriptProjector(event.sessionId, projection);
        } else if (event.sessionId !== sessionId) throw new Error('Saved transcript source changed session');
        projector.apply({ ...event, createdAt: new Date(event.createdAt) });
        ordinal = event.ordinal;
        start = newline + 1;
      }
      if (start < text.length) fragments.push(text.slice(start));
    };
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const text = decoder.decode(next.value, { stream: true });
        this.ctx.storage.transactionSync(() => consume(text));
      }
      this.ctx.storage.transactionSync(() => {
        consume(decoder.decode());
        if (fragments.length) throw new Error('Saved transcript source ended inside an event');
        projector?.flush();
        projection.complete();
      });
      ended = true;
    } finally {
      if (!ended) await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  page(generation: string, key: Uint8Array | null, request: TranscriptPageRequest): TranscriptPage {
    const projection = new SavedTranscriptProjection(this.ctx.storage.sql, generation, key);
    if (!projection.ready()) throw new Error('Saved transcript index is incomplete');
    return projection.page(request);
  }

  content(generation: string, key: Uint8Array | null, request: TranscriptContentRequest): TranscriptContentPage {
    const projection = new SavedTranscriptProjection(this.ctx.storage.sql, generation, key);
    if (!projection.ready()) throw new Error('Saved transcript index is incomplete');
    return projection.content(request);
  }
}
