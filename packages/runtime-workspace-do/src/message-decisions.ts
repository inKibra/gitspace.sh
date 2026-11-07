import type { SubmissionRecord } from '@earendil-works/pi-durable';
import { RuntimeMessageDecisionSchema, type RuntimeMessageDecision } from '@gitspace/protocol-runtime/session-controls';
import type { HeldDecisions } from '@gitspace/runtime-core/session-controls';
import { z } from 'zod';

/** A person's message in its conversation, with the decisions they sent with it. `messageId`: the message's entry, as
 * the session's history lists it; `sentAt`: when the runtime took the prompt. */
export type SentDecisions = { conversationId: string; messageId: string; deviceId: string; text: string; sentAt: string; decisions: RuntimeMessageDecision[] };

const HeldDecisionsSchema = z.array(RuntimeMessageDecisionSchema);
type HeldRow = { conversation_id: string; request_id: string; message_id: string | null; device_id: string; text: string; sent_at: string; decisions: string };
const COLUMNS = 'conversation_id,request_id,message_id,device_id,text,sent_at,decisions';
/** A held prompt with no submission this long after it was held never reached its conversation. */
const ORPHAN_MS = 60 * 60_000;

/** Decisions sent with a prompt wait here, under the prompt's request id, until pi places the prompt as an entry of its
 * conversation and `record` succeeds for them; a failed `record` keeps them for the next pass, which runs on every
 * submission change and on `retry`. `record` may see the same message more than once. A prompt withdrawn before it was
 * placed drops its decisions. */
export function createMessageDecisions(sql: SqlStorage, record: (sent: SentDecisions) => Promise<void>) {
  sql.exec('CREATE TABLE IF NOT EXISTS runtime_message_decisions(conversation_id TEXT NOT NULL, request_id TEXT NOT NULL, message_id TEXT, device_id TEXT NOT NULL, text TEXT NOT NULL, sent_at TEXT NOT NULL, decisions TEXT NOT NULL, PRIMARY KEY(conversation_id, request_id))');
  const recording = new Set<string>();
  const forget = (row: Pick<HeldRow, 'conversation_id' | 'request_id'>) => sql.exec('DELETE FROM runtime_message_decisions WHERE conversation_id=? AND request_id=?', row.conversation_id, row.request_id);
  /** Records every placed prompt's decisions not being recorded already; each recorded row leaves. */
  async function recordPlaced(): Promise<void> {
    const failures: unknown[] = [];
    for (const row of sql.exec<HeldRow>(`SELECT ${COLUMNS} FROM runtime_message_decisions WHERE message_id IS NOT NULL`).toArray()) {
      const key = JSON.stringify([row.conversation_id, row.request_id]);
      if (row.message_id === null || recording.has(key)) continue;
      recording.add(key);
      try {
        await record({ conversationId: row.conversation_id, messageId: row.message_id, deviceId: row.device_id, text: row.text, sentAt: row.sent_at, decisions: HeldDecisionsSchema.parse(JSON.parse(row.decisions)) });
        forget(row);
      } catch (error) { failures.push(error); }
      finally { recording.delete(key); }
    }
    if (failures.length) throw new AggregateError(failures, 'Message decisions were not recorded');
  }
  /** Notes where a held prompt went: its entry once placed; nowhere once withdrawn unplaced. */
  function settle(submission: SubmissionRecord): void {
    if (submission.type !== 'input' || submission.requestId === undefined || submission.status === 'queued') return;
    const row = { conversation_id: String(submission.conversationId), request_id: submission.requestId };
    if (submission.entry === undefined) forget(row);
    else sql.exec('UPDATE runtime_message_decisions SET message_id=? WHERE conversation_id=? AND request_id=? AND message_id IS NULL', String(submission.entry), row.conversation_id, row.request_id);
  }
  return {
    hold(conversationId: string, requestId: string, held: HeldDecisions): void {
      sql.exec('INSERT OR IGNORE INTO runtime_message_decisions(conversation_id,request_id,device_id,text,sent_at,decisions) VALUES(?,?,?,?,?,?)', conversationId, requestId, held.deviceId, held.text, new Date().toISOString(), JSON.stringify(held.decisions));
    },
    /** The recording pass a submission's change starts, if any prompt's decisions wait for one. */
    submissionChanged(submission: SubmissionRecord): Promise<void> | undefined {
      settle(submission);
      if (!sql.exec('SELECT 1 FROM runtime_message_decisions WHERE message_id IS NOT NULL LIMIT 1').toArray().length) return;
      return recordPlaced();
    },
    /** Settles the held prompts whose submission changed unseen (the object reset first), drops those that never became
     * a submission, then records every placed one. `submission` reads a prompt's submission by its request id. */
    async retry(submission: (conversationId: string, requestId: string) => Promise<SubmissionRecord | undefined>): Promise<void> {
      const cutoff = new Date(Date.now() - ORPHAN_MS).toISOString();
      for (const row of sql.exec<HeldRow>(`SELECT ${COLUMNS} FROM runtime_message_decisions WHERE message_id IS NULL`).toArray()) {
        const current = await submission(row.conversation_id, row.request_id);
        if (current) settle(current);
        else if (row.sent_at < cutoff) forget(row);
      }
      await recordPlaced();
    },
  };
}
