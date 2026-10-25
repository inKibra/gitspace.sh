import { createAssistantMessageEventStream, type Context, type Message, type Models } from '@earendil-works/pi-ai';

export type RunningMark = { step: string; detail: string; startedAt: string };
/** One recorded step: `update` rewrites what it records (the stage it reached, sizes so far), `end` removes it. */
export type RunningStep = { update(detail: string): void; end(): void };
export type RunningMarks = {
  /** What the previous instance was running when it was reset. */
  leftover: RunningMark[];
  /** Marks `operation` while it runs and arms the heartbeat alarm: work that can outlive the call that started it. */
  run<T>(step: string, detail: string, operation: () => Promise<T>): Promise<T>;
  /** A step that ends within the call that started it (opening, recovery, an indexing step): recorded and removed like
   * any other, without the heartbeat alarm, which would wake an idle workspace. */
  stage(step: string, detail: string): RunningStep;
  /** Whether work marked with the heartbeat is running now. */
  active(): boolean;
  /** One record per key (a conversation's turn, its compaction) counting attempts that have not finished. */
  unfinished: { begin(key: string): number; end(key: string): void };
  models(models: Models): Models;
};

/** How often a streaming model request's mark records how much reply has arrived. */
const REPLY_NOTE_MS = 5_000;
/** Mark sizes: characters as kilobytes or megabytes. */
const kilobytes = (count: number) => `${Math.round(count / 1000)} KB`;
export const megabytes = (count: number) => `${(count / 1_000_000).toFixed(1)} MB`;

/** Characters of every string in a value (a tool call's arguments: a written file, a command), without serializing it. */
function textLength(value: unknown): number {
  if (typeof value === 'string') return value.length;
  if (Array.isArray(value)) return value.reduce((total: number, item: unknown) => total + textLength(item), 0);
  if (typeof value === 'object' && value !== null) return Object.values(value).reduce((total: number, item: unknown) => total + textLength(item), 0);
  return 0;
}

/** Characters messages hold, base64 image data counted apart, from string lengths without serializing them. */
export function messageCharacters(messages: readonly Message[]): { characters: number; images: number; imageCharacters: number } {
  let characters = 0, images = 0, imageCharacters = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') { characters += message.content.length; continue; }
    for (const block of message.content) {
      if (block.type === 'image') { images++; imageCharacters += block.data.length; }
      else if (block.type === 'toolCall') characters += textLength(block.arguments);
      else if (block.type === 'text') characters += block.text.length;
      else if (block.type === 'thinking') characters += block.thinking.length;
    }
  }
  return { characters, images, imageCharacters };
}

/**
 * What a workspace object is doing that can exhaust its memory: opening, recovery, a model request, a sync merge, a
 * cloud write, an indexing step. A step is recorded before it starts and removed when it settles, so rows still present
 * when the object next opens are what the previous instance was running when it was reset (out of memory, or a
 * deploy); a reset leaves no other trace.
 */
export function createRunningMarks(sql: SqlStorage, onStart: () => void = () => {}): RunningMarks {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_running(id TEXT PRIMARY KEY, step TEXT NOT NULL, detail TEXT NOT NULL, started_at INTEGER NOT NULL)');
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_unfinished(key TEXT PRIMARY KEY, started_at INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 1)');
  // One-time: marks recorded before attempts were counted read as one attempt.
  if (!sql.exec<{ name: string }>('PRAGMA table_info(runtime_unfinished)').toArray().some(column => column.name === 'attempts')) {
    sql.exec('ALTER TABLE runtime_unfinished ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1');
  }
  const leftover = sql.exec<{ step: string; detail: string; started_at: number }>('SELECT step, detail, started_at FROM runtime_running ORDER BY started_at').toArray()
    .map((row): RunningMark => ({ step: row.step, detail: row.detail, startedAt: new Date(row.started_at).toISOString() }));
  if (leftover.length) sql.exec('DELETE FROM runtime_running');
  // Marks that keep the heartbeat armed; every row in the table is this instance's once the leftover is read.
  const awake = new Set<string>();
  const start = (step: string, detail: string, heartbeat: boolean): RunningStep => {
    const id = crypto.randomUUID();
    sql.exec('INSERT INTO runtime_running(id,step,detail,started_at) VALUES(?,?,?,?)', id, step, detail, Date.now());
    if (heartbeat) { awake.add(id); onStart(); }
    return {
      update(next: string) { sql.exec('UPDATE runtime_running SET detail=? WHERE id=?', next, id); },
      end() { awake.delete(id); sql.exec('DELETE FROM runtime_running WHERE id=?', id); },
    };
  };
  const run = async <T>(step: string, detail: string, operation: () => Promise<T>): Promise<T> => {
    const mark = start(step, detail, true);
    try { return await operation(); } finally { mark.end(); }
  };
  return {
    leftover,
    run,
    stage: (step, detail) => start(step, detail, false),
    active: () => awake.size > 0,
    unfinished: {
      begin(key: string): number {
        const earlier = sql.exec<{ attempts: number }>('SELECT attempts FROM runtime_unfinished WHERE key=?', key).toArray()[0]?.attempts ?? 0;
        sql.exec('INSERT OR REPLACE INTO runtime_unfinished(key,started_at,attempts) VALUES(?,?,?)', key, Date.now(), earlier + 1);
        return earlier;
      },
      end(key: string): void { sql.exec('DELETE FROM runtime_unfinished WHERE key=?', key); },
    },
    /**
     * Model requests are marked from the call until the response stream ends, however the caller consumes it. The mark
     * records what was sent (messages, system prompt, tool definitions), when the provider answered, and every
     * `REPLY_NOTE_MS` how much reply has arrived, so a reset shows which stage of the request it hit and what had grown.
     * Turns stream (`streamSimple`); pi and the compaction hook summarize a conversation with `completeSimple`.
     */
    models(models: Models): Models {
      const describe = (model: { provider: string; id: string }, context: Context) => {
        const { characters, images, imageCharacters } = messageCharacters(context.messages);
        return `${model.provider}/${model.id}: ${context.messages.length} messages, ${megabytes(characters + imageCharacters)}${images ? ` (${images} images, ${megabytes(imageCharacters)})` : ''}, system ${kilobytes(context.systemPrompt?.length ?? 0)}, ${context.tools?.length ?? 0} tools ${kilobytes(textLength(context.tools))}`;
      };
      return new Proxy(models, {
        get: (target, key, receiver) => {
          if (key === 'completeSimple') return (model: Parameters<Models['completeSimple']>[0], context: Context, options?: Parameters<Models['completeSimple']>[2]) => run('compaction request', describe(model, context), () => target.completeSimple(model, context, options));
          if (key !== 'streamSimple') return Reflect.get(target, key, receiver);
          return (model: Parameters<Models['streamSimple']>[0], context: Context, options?: Parameters<Models['streamSimple']>[2]) => {
            const request = describe(model, context);
            const mark = start('model request', request, true);
            const startedAt = Date.now();
            let answered = '';
            const inner = target.streamSimple(model, context, {
              ...options,
              onResponse: async (response, selected) => {
                answered = `; answered ${response.status} after ${Math.round((Date.now() - startedAt) / 1000)} s`;
                mark.update(`${request}${answered}`);
                await options?.onResponse?.(response, selected);
              },
            });
            const outer = createAssistantMessageEventStream();
            let noted = startedAt, events = 0, thinking = 0, text = 0, toolArguments = 0;
            void (async () => {
              try {
                for await (const event of inner) {
                  outer.push(event);
                  events++;
                  if (event.type === 'thinking_delta') thinking += event.delta.length;
                  else if (event.type === 'text_delta') text += event.delta.length;
                  else if (event.type === 'toolcall_delta') toolArguments += event.delta.length;
                  const now = Date.now();
                  if (now - noted < REPLY_NOTE_MS) continue;
                  noted = now;
                  mark.update(`${request}${answered}; reply after ${Math.round((now - startedAt) / 1000)} s: ${events} events, thinking ${kilobytes(thinking)}, text ${kilobytes(text)}, tool-call arguments ${kilobytes(toolArguments)}`);
                }
              }
              finally { mark.end(); outer.end(); }
            })();
            return outer;
          };
        },
      });
    },
  };
}
