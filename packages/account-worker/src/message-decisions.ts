import type { RuntimeMessageDecision } from '@gitspace/protocol-runtime/session-controls';
import type { SentDecisions } from '@gitspace/runtime-workspace-do';
import type { RuntimeIdentity } from './runtime-services.js';

/** The line a decision adds to a journal entry, as the person's message states it: the choice and what it decides, then
 * its data as JSON. */
function decisionLine(decision: RuntimeMessageDecision): string {
  const head = decision.choice ? `Decided: ${decision.choice} (${decision.title})` : `Decided: ${decision.title}`;
  const line = decision.payload === undefined || decision.payload === null ? head : `${head}\n~~~json\n${JSON.stringify(decision.payload, null, 2)}\n~~~`;
  return line.slice(0, 16_384);
}

/** Each decision a person sent with a message becomes a `decision` entry of the workspace journal in `phase`: its reason
 * is the message, its citation that message, and the person's device records it. An entry's id is its message's and
 * its place there, so a second call for the same message adds nothing; a failed write throws, for the caller to retry.
 * The project's notice of a new entry is only logged when it fails. */
export async function journalMessageDecisions(env: Env, identity: RuntimeIdentity, phase: string, sent: SentDecisions): Promise<void> {
  const owned = { projectId: identity.projectId, spaceId: identity.workspaceId };
  const { profile } = await env.USER_SETTINGS.getByName(env.ACCOUNT_ID).get(sent.deviceId);
  const who = (profile.displayName.trim() || profile.handle || 'A person').slice(0, 512);
  const space = env.SPACE_CONTEXT.getByName(JSON.stringify([env.ACCOUNT_ID, owned.projectId, owned.spaceId]));
  const project = env.PROJECT_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.projectId}`);
  for (const [index, decision] of sent.decisions.entries()) {
    const entry = await space.appendJournalEntryOnce({
      ...owned, id: `message-decision:${sent.conversationId}:${sent.messageId}:${index}`, kind: 'decision', phase, title: decision.title,
      body: sent.text.slice(0, 32_768), outcome: null, decisions: [decisionLine(decision)], evidence: [], createdBy: sent.deviceId,
      citations: [{ conversationId: sent.conversationId, messageId: sent.messageId, who, at: sent.sentAt, quote: sent.text.slice(0, 4_096) }],
      ...(decision.sectionId ? { sectionId: decision.sectionId } : {}),
    });
    await project.appendEvent({ eventId: `journal-append:${owned.spaceId}:${entry.id}`, scope: 'workspace', entity: 'journal', entityId: entry.id, revision: entry.sequence, operation: 'append', payload: { spaceId: owned.spaceId } })
      .catch((error: unknown) => { console.error('Journal notice was not sent', { workspaceId: identity.workspaceId, id: entry.id, error }); });
  }
}
