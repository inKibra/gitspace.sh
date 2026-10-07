import { emptyWorkspaceDraft, WorkspaceDraftSchema, WorkspaceDraftSaveSchema, type WorkspaceDraft, type WorkspaceDraftSave, type WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';

export type WorkspaceDraftStorage = { read(): Promise<unknown>; write(value: WorkspaceDraft): Promise<void> };
/** The runtime owns publication; this owner returns only durably accepted revisions. */
export class WorkspaceDraftStore {
  private value = emptyWorkspaceDraft();
  private line: Promise<void> = Promise.resolve();
  constructor(private readonly storage: WorkspaceDraftStorage) {}
  async initialize(): Promise<void> {
    const stored = await this.storage.read();
    this.value = stored === undefined ? emptyWorkspaceDraft() : WorkspaceDraftSchema.parse(stored);
  }
  snapshot(): WorkspaceDraft { return { ...this.value }; }
  save(raw: WorkspaceDraftSave, deviceId: string): Promise<WorkspaceDraftSaveResult> {
    const input = WorkspaceDraftSaveSchema.parse(raw);
    const actor = WorkspaceDraftSchema.shape.deviceId.unwrap().parse(deviceId);
    const operation = this.line.then(async (): Promise<WorkspaceDraftSaveResult> => {
      if (input.expectedRevision !== this.value.revision) return { status: 'conflict', draft: this.snapshot() };
      const next: WorkspaceDraft = { text: input.text, revision: this.value.revision + 1, updatedAt: new Date().toISOString(), deviceId: actor };
      await this.storage.write(next);
      this.value = next;
      return { status: 'saved', draft: this.snapshot() };
    });
    this.line = operation.then(() => undefined, () => undefined);
    return operation;
  }
  clear(expectedRevision: number, deviceId: string): Promise<WorkspaceDraftSaveResult> {
    return this.save({ text: '', expectedRevision }, deviceId);
  }
}
