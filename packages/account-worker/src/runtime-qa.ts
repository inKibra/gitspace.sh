import { z } from 'zod';
import type { RuntimeReportIssueArgumentsSchema } from '@gitspace/protocol-runtime';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { RuntimeQaItemSchema, type RuntimeQaActionInput, type RuntimeQaItem } from '@gitspace/protocol-runtime/workspace-controls';
import { acrossRelease } from './release-worker.js';
import type { RuntimeIdentity } from './runtime-services.js';

/** A QA item the project object kept, with when its latest event was recorded there. */
export const RuntimeQaMovedItemSchema = z.object({ item: RuntimeQaItemSchema, at: z.string() });
export type RuntimeQaMovedItem = z.infer<typeof RuntimeQaMovedItemSchema>;
/** The QA items the project object still keeps for one workspace (`ProjectAuthorityDO.workspaceQa`). */
export const RuntimeWorkspaceQaSchema = z.object({ items: z.array(RuntimeQaMovedItemSchema) });

/**
 * A workspace's QA items live in its own object's storage, oldest first. Its runtime, its agents and the relay file them
 * there and its snapshot reads them, so opening the workspace asks no other object for them; nothing reads them
 * project-wide. `updated_at` is when the stored state was written (a local change) or recorded in the project (a moved
 * item); rows written before the column existed have none, so the project's state replaces them.
 */
function qaItems(sql: SqlStorage) {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_qa_items(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, state TEXT NOT NULL, history_ref TEXT NOT NULL, title TEXT NOT NULL, item TEXT NOT NULL)');
  sql.exec("CREATE INDEX IF NOT EXISTS runtime_qa_items_open ON runtime_qa_items(history_ref, title) WHERE state='open'");
  try { sql.exec('ALTER TABLE runtime_qa_items ADD COLUMN updated_at TEXT'); }
  catch (error) { if (!(error instanceof Error) || !/duplicate column name/u.test(error.message)) throw error; }
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_qa_moved(id INTEGER PRIMARY KEY CHECK(id=1))');
  function stored(id: string): { item: RuntimeQaItem; updatedAt: string } | null {
    const row = sql.exec<{ item: string; updated_at: string | null }>('SELECT item, updated_at FROM runtime_qa_items WHERE id=?', id).toArray()[0];
    return row ? { item: RuntimeQaItemSchema.parse(JSON.parse(row.item)), updatedAt: row.updated_at ?? '' } : null;
  }
  /** The id of the oldest open item with this history and title. */
  function open(historyRef: string, title: string): string | undefined {
    return sql.exec<{ id: string }>("SELECT id FROM runtime_qa_items WHERE state='open' AND history_ref=? AND title=? ORDER BY created_at, rowid LIMIT 1", historyRef, title).toArray()[0]?.id;
  }
  function write(item: RuntimeQaItem, updatedAt: string): void {
    sql.exec(`INSERT INTO runtime_qa_items(id,created_at,state,history_ref,title,item,updated_at) VALUES(?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, item=excluded.item, updated_at=excluded.updated_at`, item.id, item.createdAt, item.state, item.historyRef, item.title, JSON.stringify(item), updatedAt);
  }
  return {
    stored, open, write,
    list: () => sql.exec<{ item: string; updated_at: string | null }>('SELECT item, updated_at FROM runtime_qa_items ORDER BY created_at, rowid').toArray().map(row => ({ item: RuntimeQaItemSchema.parse(JSON.parse(row.item)), updatedAt: row.updated_at ?? '' })),
    /** Stores `item` unless one with its id is stored, and returns what is stored. An open item filed while the same
     * failure is open is stored as a copy merged into the first. */
    add(item: RuntimeQaItem): RuntimeQaItem {
      const existing = stored(item.id);
      if (existing) return existing.item;
      const first = item.state === 'open' ? open(item.historyRef, item.title) : undefined;
      const added = first === undefined ? item : { ...item, state: 'merged' as const, duplicateOf: first };
      write(added, new Date().toISOString());
      return added;
    },
    /** True once the project object holds none of this workspace's items. */
    moved: () => sql.exec('SELECT 1 FROM runtime_qa_moved').toArray().length > 0,
    markMoved: () => { sql.exec('INSERT OR IGNORE INTO runtime_qa_moved(id) VALUES(1)'); },
  };
}

/** Files a report as a QA item of the workspace whose storage this is; filing the same id again returns the stored item. */
export function appendRuntimeQa(storage: DurableObjectStorage, identity: RuntimeIdentity, id: string, report: z.infer<typeof RuntimeReportIssueArgumentsSchema>): RuntimeQaItem {
  return qaItems(storage.sql).add(RuntimeQaItemSchema.parse({ id, title: report.message.split('\n')[0]!.slice(0, 160), description: report.message, historyRef: report.reference ?? `history://${identity.workspaceId}`, tool: report.tool ?? null, model: report.model ?? 'unattributed', runtimeVersion: 'pi-1.0', state: 'open', duplicateOf: null, createdAt: new Date().toISOString() }));
}

/** Items the project object kept for this workspace, sent by its move. Each replaces a stored copy written before the
 * project recorded it; `done` says the project holds no more of this workspace's items. */
export function importRuntimeQa(storage: DurableObjectStorage, items: readonly RuntimeQaMovedItem[], done: boolean): void {
  const store = qaItems(storage.sql);
  storage.transactionSync(() => {
    for (const { item, at } of items.map(entry => RuntimeQaMovedItemSchema.parse(entry))) {
      const existing = store.stored(item.id);
      if (!existing || existing.updatedAt < at) store.write(item, at);
    }
    if (done) store.markMoved();
  });
}

/** How long a failed read of the project's copy waits before the next snapshot tries again. */
const PROJECT_COPY_RETRY_MS = 60_000;

/** A workspace's QA inbox: the items its own runtime, its agents and the relay reported. */
export type RuntimeQaServices = {
  list(): Promise<RuntimeQaItem[]>;
  /** A runtime failure becomes a QA item unless the same failure is already open. */
  report(message: string): void;
  act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }>;
};

/**
 * The inbox of the workspace whose storage this is. Until the project object's move has reached this workspace, a
 * runtime (given `projectCopy`) also shows the items the project still keeps for it, read once in the background, never
 * while the workspace opens; an item shows in whichever copy was written last.
 */
export function createRuntimeQaServices(storage: DurableObjectStorage, env: Env, identity: RuntimeIdentity, projectCopy?: { waitUntil(promise: Promise<unknown>): void; changed(): void }): RuntimeQaServices {
  const store = qaItems(storage.sql);
  // A stub per call: one that saw an error, such as the project object resetting for a release, stays broken.
  const authority = () => env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  let copy: RuntimeQaMovedItem[] = [];
  let reading = false;
  let readAfter = 0;
  function readProjectCopy(): void {
    if (!projectCopy || reading || Date.now() < readAfter || store.moved()) return;
    reading = true;
    projectCopy.waitUntil((async () => {
      try {
        const { items } = RuntimeWorkspaceQaSchema.parse(await acrossRelease(() => authority().workspaceQa(identity.workspaceId)));
        // Nothing left in the project: its move is done, or this workspace never had items there; the snapshot is
        // unchanged.
        if (!items.length) { store.markMoved(); return; }
        copy = items;
        projectCopy.changed();
      } catch (error) {
        readAfter = Date.now() + PROJECT_COPY_RETRY_MS;
        console.warn(JSON.stringify({ event: 'qa_project_copy_failed', workspaceId: identity.workspaceId, message: error instanceof Error ? error.message : String(error) }));
      } finally { reading = false; }
    })());
  }
  function current(): RuntimeQaItem[] {
    readProjectCopy();
    const local = store.list();
    if (store.moved() || !copy.length) return local.map(entry => entry.item);
    const merged = new Map(local.map(entry => [entry.item.id, entry]));
    for (const entry of copy) {
      const existing = merged.get(entry.item.id);
      if (!existing || existing.updatedAt < entry.at) merged.set(entry.item.id, { item: entry.item, updatedAt: entry.at });
    }
    return [...merged.values()].map(entry => entry.item).sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }
  return {
    list: async () => current(),
    report(message: string): void {
      if (store.open(`history://${identity.workspaceId}`, message.split('\n')[0]!.slice(0, 160)) === undefined) appendRuntimeQa(storage, identity, crypto.randomUUID(), { message });
    },
    async act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> {
      const items = current();
      const item = items.find(candidate => candidate.id === input.itemId);
      if (!item) throw new Error('QA item does not belong to this workspace');
      const { action } = input;
      if (action.kind === 'share') {
        const reference = action.target === 'gitspace' ? GITSPACE_SOURCE_REPOSITORY : (await authority().getProject())?.repositoryReference;
        if (!reference) throw new Error('Project has no canonical repository');
        const repository = new URL(reference.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, ''));
        if (repository.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/?$/u.test(repository.pathname)) throw new Error('Issue drafts require a canonical GitHub repository');
        const url = new URL(`${repository.pathname.replace(/\/$/u, '')}/issues/new`, 'https://github.com');
        url.searchParams.set('title', item.title);
        url.searchParams.set('body', action.redactedExcerpt);
        // A draft is not a delivery receipt. Keep the local item open until an
        // authorized integration can prove that an external issue was created.
        return { shareDraft: url.toString() };
      }
      let next: RuntimeQaItem;
      switch (action.kind) {
        case 'dismiss': next = { ...item, state: 'dismissed', duplicateOf: null }; break;
        case 'merge': {
          const target = items.find(candidate => candidate.id === action.targetId);
          if (!target || target.id === item.id || target.state === 'merged') throw new Error('Duplicate target must be a distinct canonical QA item');
          next = { ...item, state: 'merged', duplicateOf: target.id };
          break;
        }
        case 'fixed': next = { ...item, state: 'fixed', duplicateOf: null, fixedIn: action.commit }; break;
        case 'file': {
          if (item.state === 'merged') throw new Error('File the issue this one was merged into instead');
          // The account copy is written first and keyed by the item, so a retry after a failed write rewrites it.
          const filed = await env.ACCOUNT_STATE.getByName('account').fileIssue({ id: item.id, projectId: identity.projectId, workspaceId: identity.workspaceId, title: item.title, excerpt: action.excerpt, tool: item.tool, model: item.model, historyRef: item.historyRef, createdAt: item.createdAt, filedAt: new Date().toISOString(), filedBy: actor.deviceId });
          next = { ...item, filedAt: filed.filedAt };
          break;
        }
      }
      // A change to an item still in the project's copy is written here, later than that copy, so it shows from now on.
      store.write(next, new Date().toISOString());
      return {};
    },
  };
}
