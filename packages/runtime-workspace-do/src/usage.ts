import { UsageDoc, type Storage, type Harness, type ConversationId, type EntryId, type Cursor } from '@earendil-works/pi-durable';
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context';
import type { SessionUsageReport, UsageTotals } from '@gitspace/protocol-runtime/session-controls';

export async function readCloudUsage(durable: DurableObjectStorage, storage: Storage, harness: Harness, target: ConversationId): Promise<SessionUsageReport> {
  const sql = durable.sql;
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_usage_requests(owner INTEGER NOT NULL,model TEXT NOT NULL,requests INTEGER NOT NULL,PRIMARY KEY(owner,model))');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_usage_progress(owner INTEGER PRIMARY KEY,entry INTEGER NOT NULL)');
  const owners = new Map<number, number | null>();
  let cursor: Cursor | undefined;
  do { const page = await storage.scanConversations({}, 128, cursor, BACKGROUND_CONTEXT); for (const record of page.items) owners.set(Number(record.id), record.owner ? Number(record.owner.conversationId) : null); cursor = page.next; } while (cursor);
  const included = [...owners.keys()].filter(id => { for (let owner: number | null | undefined = id; owner !== null && owner !== undefined; owner = owners.get(owner)) if (owner === Number(target)) return true; return false; });
  const empty = (): UsageTotals => ({ requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, reasoningTokens: 0, costUsd: 0 });
  const report: SessionUsageReport = { sessionId: String(target), totals: empty(), totalsDeep: empty(), childSessions: Math.max(0, included.length - 1), byModel: [], byRole: [], byAgent: [], byCompletion: [], warnings: ['Pi usage includes compaction and tool charges. Request counts cover persisted assistant responses; historical role and compaction-request attribution are not recorded.'] };
  function add(into: UsageTotals, value: UsageTotals) { for (const key of Object.keys(into) as (keyof UsageTotals)[]) into[key] += value[key]; }
  for (const owner of included) {
    let after = sql.exec<{entry:number}>('SELECT entry FROM runtime_usage_progress WHERE owner=?', owner).toArray()[0]?.entry ?? -1;
    const end = sql.exec<{id:number}>('SELECT MAX(id) AS id FROM entries WHERE conversation_id=?', owner).toArray()[0]?.id ?? -1;
    while (after < end) {
      const ids = sql.exec<{id:number}>('SELECT id FROM entries WHERE conversation_id=? AND id>? AND id<=? ORDER BY id LIMIT 64', owner, after, end).toArray();
      if (!ids.length) break;
      for (const row of ids) {
        const found = await storage.entry(row.id as EntryId, BACKGROUND_CONTEXT);
        if (!found) throw new Error('Usage source unavailable');
        durable.transactionSync(() => {
          for (const message of found.entry.model ?? []) if (message.role === 'assistant') sql.exec('INSERT INTO runtime_usage_requests VALUES(?,?,1) ON CONFLICT(owner,model) DO UPDATE SET requests=requests+1', owner, `${message.provider}/${message.model}`);
          sql.exec('INSERT OR REPLACE INTO runtime_usage_progress VALUES(?,?)', owner, row.id);
        });
        after = row.id;
      }
    }
    const state = await harness.snapshot(UsageDoc, owner as ConversationId, BACKGROUND_CONTEXT);
    const requests = Object.fromEntries(sql.exec<{model:string;requests:number}>('SELECT model,requests FROM runtime_usage_requests WHERE owner=?', owner).toArray().map(row => [row.model, row.requests]));
    for (const bucket of ['models', 'tools'] as const) for (const [key, usage] of Object.entries(state?.[bucket] ?? {})) {
      const totals: UsageTotals = { requests: bucket === 'models' ? requests[key] ?? 0 : 0, input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, totalTokens: usage.totalTokens, reasoningTokens: usage.reasoning ?? 0, costUsd: usage.cost.total };
      if (owner === Number(target)) add(report.totals, totals);
      add(report.totalsDeep, totals);
      const split = key.indexOf('/');
      const provider = bucket === 'models' ? key.slice(0, split) : 'tool';
      const model = bucket === 'models' ? key.slice(split + 1) : key;
      let row = report.byModel.find(row => row.provider === provider && row.model === model);
      if (!row) { row = { provider, model, totals: empty() }; report.byModel.push(row); }
      add(row.totals, totals);
      report.byAgent.push({ agentId: String(owner), agent: owner === Number(target) ? 'Main' : `Conversation ${owner}`, selection: 'unknown', role: null, provider, model, definitionSource: null, definitionPath: null, definitionRevision: null, spawns: owner === Number(target) ? 0 : 1, firstAt: null, lastAt: null, totals });
    }
  }
  return report;
}
