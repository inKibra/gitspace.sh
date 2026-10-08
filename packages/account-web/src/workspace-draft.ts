import { z } from 'zod';
import { emptyWorkspaceDraft, WorkspaceDraftSchema, WorkspaceDraftTextSchema, WORKSPACE_DRAFT_MAX_LENGTH, type WorkspaceDraft, type WorkspaceDraftSave, type WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';
import { rpcErrorMessage } from './rpc-error-message.js';

const LocalDraftSchema = z.object({ draft: WorkspaceDraftSchema, text: z.string(), dirty: z.boolean() });
export type WorkspaceDraftState = { text: string; dirty: boolean; saving: boolean; error: string | null };
export type WorkspaceDraftCapture = { generation: number; draftRevision: number | undefined };
export type WorkspaceDraftBinding = { text: string; saving: boolean; error: string | null; onChange(text: string): void; onBlur(): void; capture(): WorkspaceDraftCapture; accepted(capture: WorkspaceDraftCapture): void };
type Options = { deviceId: string; key: string; storage: Pick<Storage, 'getItem' | 'setItem'> | null; save(input: WorkspaceDraftSave): Promise<WorkspaceDraftSaveResult> };

/** One owner per workspace/device. Remote revisions never replace unacknowledged local edits. */
export class WorkspaceDraftController {
  private draft = emptyWorkspaceDraft();
  private state: WorkspaceDraftState = { text: '', dirty: false, saving: false, error: null };
  private generation = 0;
  private connected = false;
  private received = false;
  private disposed = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private flight: Promise<void> | null = null;
  private listeners = new Set<() => void>();
  constructor(private readonly options: Options) {
    try {
      const saved = options.storage?.getItem(options.key);
      if (saved) {
        const parsed = LocalDraftSchema.safeParse(JSON.parse(saved));
        if (parsed.success) { this.draft = parsed.data.draft; this.state = { ...this.state, text: parsed.data.text, dirty: parsed.data.dirty }; }
        else this.state = { ...this.state, error: 'Saved local draft could not be read.' };
      }
    } catch (error) { this.state = { ...this.state, error: rpcErrorMessage(error, 'Read local draft') }; }
  }
  snapshot = (): WorkspaceDraftState => this.state;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(patch: Partial<WorkspaceDraftState>): void {
    this.state = { ...this.state, ...patch };
    try { this.options.storage?.setItem(this.options.key, JSON.stringify({ draft: this.draft, text: this.state.text, dirty: this.state.dirty })); }
    catch (error) { this.state = { ...this.state, error: rpcErrorMessage(error, 'Save local draft') }; }
    for (const listener of this.listeners) listener();
  }
  private schedule(): void {
    clearTimeout(this.timer);
    if (this.connected && !this.disposed && this.state.dirty) this.timer = setTimeout(() => { void this.flush(); }, 1000);
  }
  edit(text: string): void {
    this.generation++;
    this.update({ text, dirty: true, error: null });
    this.schedule();
  }
  capture(): WorkspaceDraftCapture { return { generation: this.generation, draftRevision: this.received ? this.draft.revision : undefined }; }
  accepted(capture: WorkspaceDraftCapture): void {
    if (capture.generation !== this.generation) return;
    clearTimeout(this.timer);
    this.generation++;
    // The server owns the revision-fenced clear; never turn acceptance into a new edit.
    this.update({ text: this.draft.revision === capture.draftRevision ? '' : this.draft.text, dirty: false, error: null });
  }
  receive(raw: WorkspaceDraft): void {
    const draft = WorkspaceDraftSchema.parse(raw);
    if (draft.revision < this.draft.revision || (this.received && draft.revision === this.draft.revision)) return;
    this.received = true;
    if (!this.state.dirty) this.generation++;
    this.draft = draft;
    this.update(this.state.dirty ? {} : { text: draft.text });
  }
  setConnected(connected: boolean): void {
    if (connected === this.connected) return;
    this.connected = connected;
    if (connected) void this.flush(); else clearTimeout(this.timer);
  }
  rejectRemote(): void {
    this.setConnected(false);
    this.update({ error: 'The cloud draft could not be read. Local text is retained.' });
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.flight) return this.flight;
    if (!this.connected || this.disposed || !this.state.dirty) return Promise.resolve();
    this.flight = this.drain().finally(() => { this.flight = null; this.schedule(); });
    return this.flight;
  }
  private async drain(): Promise<void> {
    this.update({ saving: true });
    try {
      while (this.connected && !this.disposed && this.state.dirty) {
        const generation = this.generation;
        const text = this.state.text;
        const valid = WorkspaceDraftTextSchema.safeParse(text);
        if (!valid.success) { this.update({ error: `Draft is too long to sync (maximum ${WORKSPACE_DRAFT_MAX_LENGTH} characters).` }); break; }
        const result = await this.options.save({ text: valid.data, expectedRevision: this.draft.revision });
        this.receive(result.draft);
        if (generation === this.generation && result.status === 'saved') {
          this.update({ dirty: false, text: this.draft.text, error: null });
        }
      }
    } catch (error) { this.update({ error: rpcErrorMessage(error, 'Sync workspace draft') }); }
    finally { this.update({ saving: false }); }
  }
  dispose(): void { this.disposed = true; clearTimeout(this.timer); this.listeners.clear(); }
}
