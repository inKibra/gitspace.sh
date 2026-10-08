import { expect, it } from 'vitest';
import { WorkspaceDraftController } from './workspace-draft.js';
import type { WorkspaceDraft, WorkspaceDraftSave, WorkspaceDraftSaveResult } from '@gitspace/protocol-runtime/draft';

function fixture() {
  let draft: WorkspaceDraft = { text: '', revision: 0, updatedAt: null, deviceId: null };
  const clients: WorkspaceDraftController[] = [];
  const storage = new Map<string, string>();
  const make = (deviceId: string) => {
    const client = new WorkspaceDraftController({ deviceId, key: deviceId, storage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => { storage.set(key, value); } }, save: async (input: WorkspaceDraftSave): Promise<WorkspaceDraftSaveResult> => {
      if (input.expectedRevision !== draft.revision) return { status: 'conflict', draft };
      draft = { text: input.text, revision: draft.revision + 1, updatedAt: new Date().toISOString(), deviceId };
      for (const peer of clients) peer.receive(draft);
      return { status: 'saved', draft };
    } });
    clients.push(client); client.receive(draft); client.setConnected(true); return client;
  };
  return { make, draft: () => draft };
}
it('synchronizes A to B and converges simultaneous unsaved edits without losing local typing', async () => {
  const { make } = fixture(); const a = make('a'); const b = make('b');
  a.edit('from A'); await a.flush(); expect(b.snapshot().text).toBe('from A');
  a.edit('new A'); b.edit('new B'); await a.flush(); await b.flush();
  expect(a.snapshot().text).toBe('new B'); expect(b.snapshot().text).toBe('new B'); a.dispose(); b.dispose();
});
it('reconciles offline text by saving it after the newest remote revision', async () => {
  const { make } = fixture(); const a = make('a'); const b = make('b');
  b.setConnected(false); b.edit('offline B'); a.edit('online A'); await a.flush();
  expect(b.snapshot().text).toBe('offline B'); b.setConnected(true); await b.flush();
  expect(a.snapshot().text).toBe('offline B'); a.dispose(); b.dispose();
});
it('clears an erased draft and accepted sends but preserves typing after send starts', async () => {
  const { make } = fixture(); const a = make('a'); const b = make('b');
  a.edit('send me'); const sent = a.capture(); await a.flush(); a.edit('next message'); a.accepted(sent); await a.flush();
  expect(b.snapshot().text).toBe('next message'); a.edit(''); await a.flush(); expect(b.snapshot().text).toBe('');
  a.edit('sent'); await a.flush(); const next = a.capture(); a.accepted(next); await a.flush(); expect(a.snapshot().text).toBe(''); expect(b.snapshot().text).toBe('sent'); a.dispose(); b.dispose();
});
it('does not clear another device newer saved draft when an older send finishes', async () => {
  const { make } = fixture(); const a = make('a'); const b = make('b');
  a.edit('sent'); await a.flush(); const sent = a.capture();
  b.edit('next from B'); await b.flush(); expect(a.snapshot().text).toBe('next from B');
  a.accepted(sent); await a.flush();
  expect(a.snapshot().text).toBe('next from B'); expect(b.snapshot().text).toBe('next from B');
  a.dispose(); b.dispose();
});
it('protects keystrokes while a save is in flight and ignores stale echoes', async () => {
  const pending = Promise.withResolvers<WorkspaceDraftSaveResult>(); let calls = 0;
  const a = new WorkspaceDraftController({ deviceId: 'a', key: 'a', storage: null, save: async (input) => ++calls === 1 ? pending.promise : { status: 'saved', draft: { text: input.text, revision: 3, updatedAt: new Date().toISOString(), deviceId: 'a' } } });
  a.receive({ text: '', revision: 0, updatedAt: null, deviceId: null }); a.setConnected(true); a.edit('first'); const saving = a.flush(); a.edit('newer');
  a.receive({ text: 'remote', revision: 2, updatedAt: new Date().toISOString(), deviceId: 'b' }); expect(a.snapshot().text).toBe('newer');
  pending.resolve({ status: 'saved', draft: { text: 'first', revision: 1, updatedAt: new Date().toISOString(), deviceId: 'a' } }); await saving;
  expect(a.snapshot().text).toBe('newer'); expect(a.snapshot().dirty).toBe(false); a.dispose();
});
it('retains failed saves locally and retries without replacing text with remote state', async () => {
  let fail = true;
  const storage = new Map<string, string>();
  const options = { deviceId: 'a', key: 'workspace:a', storage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => { storage.set(key, value); } }, save: async (input: WorkspaceDraftSave): Promise<WorkspaceDraftSaveResult> => {
    if (fail) throw new Error('offline');
    return { status: 'saved', draft: { text: input.text, revision: input.expectedRevision + 1, updatedAt: new Date().toISOString(), deviceId: 'a' } };
  } };
  const first = new WorkspaceDraftController(options); first.setConnected(true); first.edit('retained'); await first.flush();
  expect(first.snapshot().error).not.toBeNull(); first.dispose();
  const reopened = new WorkspaceDraftController(options);
  reopened.receive({ text: 'remote', revision: 5, updatedAt: new Date().toISOString(), deviceId: 'b' });
  expect(reopened.snapshot().text).toBe('retained'); fail = false; reopened.setConnected(true); await reopened.flush();
  expect(reopened.snapshot()).toMatchObject({ text: 'retained', dirty: false, error: null }); reopened.dispose();
});
it('does not save an empty draft after an accepted send with an unseen B revision', async () => {
  const saves: WorkspaceDraftSave[] = [];
  let newer: WorkspaceDraft = { text: 'new from B', revision: 2, updatedAt: null, deviceId: 'b' };
  const a = new WorkspaceDraftController({ deviceId: 'a', key: 'a', storage: null, save: async input => {
    saves.push(input);
    if (input.expectedRevision !== newer.revision) return { status: 'conflict', draft: newer };
    newer = { ...newer, text: input.text, revision: newer.revision + 1 };
    return { status: 'saved', draft: newer };
  } });
  a.receive({ ...newer, text: 'sent', revision: 1, deviceId: 'a' }); a.setConnected(true);
  const captured = a.capture();
  a.accepted(captured); await a.flush();
  expect(saves).toEqual([]);
  expect(newer.text).toBe('new from B');
  a.receive(newer);
  expect(a.snapshot()).toMatchObject({ text: 'new from B', dirty: false });
  a.dispose();
});
