import { z } from 'zod';
import type { RuntimeReportIssueArgumentsSchema } from '@gitspace/protocol-runtime';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import { RuntimeQaItemSchema, type RuntimeQaActionInput, type RuntimeQaItem } from '@gitspace/protocol-runtime/workspace-controls';
import type { RuntimeIdentity } from './runtime-services.js';

/**
 * A workspace's QA items live in its own object's storage, oldest first. Its runtime, its agents and the relay file them
 * there and its snapshot reads them, so opening the workspace asks no other object for them; nothing reads them
 * project-wide.
 */
function qaItems(sql: SqlStorage) {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_qa_items(id TEXT PRIMARY KEY, created_at TEXT NOT NULL, state TEXT NOT NULL, history_ref TEXT NOT NULL, title TEXT NOT NULL, item TEXT NOT NULL)');
  sql.exec("CREATE INDEX IF NOT EXISTS runtime_qa_items_open ON runtime_qa_items(history_ref, title) WHERE state='open'");
  function get(id: string): RuntimeQaItem | null {
    const row = sql.exec<{ item: string }>('SELECT item FROM runtime_qa_items WHERE id=?', id).toArray()[0];
    return row ? RuntimeQaItemSchema.parse(JSON.parse(row.item)) : null;
  }
  /** The id of the oldest open item with this history and title. */
  function open(historyRef: string, title: string): string | undefined {
    return sql.exec<{ id: string }>("SELECT id FROM runtime_qa_items WHERE state='open' AND history_ref=? AND title=? ORDER BY created_at, rowid LIMIT 1", historyRef, title).toArray()[0]?.id;
  }
  return {
    get, open,
    list: () => sql.exec<{ item: string }>('SELECT item FROM runtime_qa_items ORDER BY created_at, rowid').toArray().map(row => RuntimeQaItemSchema.parse(JSON.parse(row.item))),
    /** Stores `item` unless one with its id is stored, and returns what is stored. An open item filed while the same
     * failure is open is stored as a copy merged into the first. */
    add(item: RuntimeQaItem): RuntimeQaItem {
      const stored = get(item.id);
      if (stored) return stored;
      const first = item.state === 'open' ? open(item.historyRef, item.title) : undefined;
      const added = first === undefined ? item : { ...item, state: 'merged' as const, duplicateOf: first };
      sql.exec('INSERT INTO runtime_qa_items(id,created_at,state,history_ref,title,item) VALUES(?,?,?,?,?,?)', added.id, added.createdAt, added.state, added.historyRef, added.title, JSON.stringify(added));
      return added;
    },
  };
}

/** Files a report as a QA item of the workspace whose storage this is; filing the same id again returns the stored item. */
export function appendRuntimeQa(storage: DurableObjectStorage, identity: RuntimeIdentity, id: string, report: z.infer<typeof RuntimeReportIssueArgumentsSchema>): RuntimeQaItem {
  return qaItems(storage.sql).add(RuntimeQaItemSchema.parse({ id, title: report.message.split('\n')[0]!.slice(0, 160), description: report.message, historyRef: report.reference ?? `history://${identity.workspaceId}`, tool: report.tool ?? null, model: report.model ?? 'unattributed', runtimeVersion: 'pi-1.0', state: 'open', duplicateOf: null, createdAt: new Date().toISOString() }));
}

/** QA items the project object kept for this workspace, oldest first, each in its latest state. One already stored
 * keeps its stored state. */
export function importRuntimeQa(storage: DurableObjectStorage, items: readonly RuntimeQaItem[]): void {
  const store = qaItems(storage.sql);
  storage.transactionSync(() => { for (const item of items) store.add(RuntimeQaItemSchema.parse(item)); });
}

/** A workspace's QA inbox: the items its own runtime, its agents and the relay reported. */
export type RuntimeQaServices = {
  list(): RuntimeQaItem[];
  /** A runtime failure becomes a QA item unless the same failure is already open. */
  report(message: string): void;
  act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }>;
};
export function createRuntimeQaServices(storage: DurableObjectStorage, env: Env, identity: RuntimeIdentity): RuntimeQaServices {
  const store = qaItems(storage.sql);
  return {
    list: store.list,
    report(message: string): void {
      if (store.open(`history://${identity.workspaceId}`, message.split('\n')[0]!.slice(0, 160)) === undefined) appendRuntimeQa(storage, identity, crypto.randomUUID(), { message });
    },
    async act(input: RuntimeQaActionInput, actor: { deviceId: string; canApprove: boolean }): Promise<{ shareDraft?: string }> {
      const item = store.get(input.itemId);
      if (!item) throw new Error('QA item does not belong to this workspace');
      const { action } = input;
      if (action.kind === 'share') {
        const reference = action.target === 'gitspace' ? GITSPACE_SOURCE_REPOSITORY : (await env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`).getProject())?.repositoryReference;
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
          const target = store.get(action.targetId);
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
      storage.sql.exec('UPDATE runtime_qa_items SET state=?, item=? WHERE id=?', next.state, JSON.stringify(next), next.id);
      return {};
    },
  };
}
