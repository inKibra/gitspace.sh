/**
 * What GitSpace tells an agent on someone else's behalf (a subagent's reply, a finished background command, an exited
 * process, a ready machine) reaches the model as user input, because the model must see it. Each one is wrapped so
 * neither the model nor the transcript takes it for the user's own words; one message may carry several.
 */
export interface ConversationEventNote {
  kind: string;
  /** Who or what it comes from, as the transcript labels it. */
  source: string;
  text: string;
}

const CLOSE = '\n</gitspace-event>';
const OPEN = /^<gitspace-event kind="([a-z-]+)" source="([^"\n]*)">\n/u;

export function formatConversationEvents(events: readonly ConversationEventNote[]): string {
  return events.map(event => {
    const source = event.source.replaceAll('"', "'").replaceAll('\n', ' ');
    // The body cannot end its own envelope early.
    return `<gitspace-event kind="${event.kind}" source="${source}">\n${event.text.replaceAll('</gitspace-event>', '<\\/gitspace-event>')}${CLOSE}`;
  }).join('\n\n');
}

/** The events a delivered message carries, or null when the text is not entirely event envelopes (a user's message). */
export function parseConversationEvents(text: string): ConversationEventNote[] | null {
  const events: ConversationEventNote[] = [];
  let rest = text;
  while (rest.length > 0) {
    const open = OPEN.exec(rest);
    if (!open) return null;
    const end = rest.indexOf(CLOSE, open[0].length - 1);
    if (end < 0) return null;
    const body = end < open[0].length ? '' : rest.slice(open[0].length, end);
    events.push({ kind: open[1]!, source: open[2]!, text: body.replaceAll('<\\/gitspace-event>', '</gitspace-event>') });
    rest = rest.slice(end + CLOSE.length);
    if (rest.startsWith('\n\n')) rest = rest.slice(2);
    else if (rest.length > 0) return null;
  }
  return events.length > 0 ? events : null;
}
