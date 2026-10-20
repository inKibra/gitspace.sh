import { createAssistantMessageEventStream, type Context, type Models } from '@earendil-works/pi-ai';

export type RunningMark = { step: string; detail: string; startedAt: string };

/**
 * What a workspace object is doing that can exhaust its memory: a model request, a sync merge, a cloud write. A step
 * is recorded before it starts and removed when it settles, so rows still present when the object next opens are what
 * the previous instance was running when it was reset (out of memory, or a deploy); a reset leaves no other trace.
 */
export function createRunningMarks(sql: SqlStorage) {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_running(id TEXT PRIMARY KEY, step TEXT NOT NULL, detail TEXT NOT NULL, started_at INTEGER NOT NULL)');
  const leftover = sql.exec<{ step: string; detail: string; started_at: number }>('SELECT step, detail, started_at FROM runtime_running ORDER BY started_at').toArray()
    .map((row): RunningMark => ({ step: row.step, detail: row.detail, startedAt: new Date(row.started_at).toISOString() }));
  if (leftover.length) sql.exec('DELETE FROM runtime_running');
  const start = (step: string, detail: string) => {
    const id = crypto.randomUUID();
    sql.exec('INSERT INTO runtime_running(id,step,detail,started_at) VALUES(?,?,?,?)', id, step, detail, Date.now());
    return () => { sql.exec('DELETE FROM runtime_running WHERE id=?', id); };
  };
  const run = async <T>(step: string, detail: string, operation: () => Promise<T>): Promise<T> => {
    const end = start(step, detail);
    try { return await operation(); } finally { end(); }
  };
  return {
    /** What the previous instance was running when it was reset. */
    leftover,
    run,
    /** Model requests are marked from the call until the response stream ends, however the caller consumes it. */
    models(models: Models): Models {
      const describe = (model: { provider: string; id: string }, context: Context) => {
        let characters = 0;
        for (const message of context.messages) {
          if (typeof message.content === 'string') { characters += message.content.length; continue; }
          for (const block of message.content) characters += 'text' in block ? block.text.length : 'thinking' in block ? block.thinking.length : 0;
        }
        return `${model.provider}/${model.id}: ${context.messages.length} messages, ${characters} characters`;
      };
      return new Proxy(models, {
        get: (target, key, receiver) => {
          if (key === 'completeSimple') return (model: Parameters<Models['completeSimple']>[0], context: Context, options?: Parameters<Models['completeSimple']>[2]) => run('model request', describe(model, context), () => target.completeSimple(model, context, options));
          if (key !== 'streamSimple') return Reflect.get(target, key, receiver);
          return (model: Parameters<Models['streamSimple']>[0], context: Context, options?: Parameters<Models['streamSimple']>[2]) => {
            const end = start('model request', describe(model, context));
            const inner = target.streamSimple(model, context, options);
            const outer = createAssistantMessageEventStream();
            void (async () => {
              try { for await (const event of inner) outer.push(event); }
              finally { end(); outer.end(); }
            })();
            return outer;
          };
        },
      });
    },
  };
}
