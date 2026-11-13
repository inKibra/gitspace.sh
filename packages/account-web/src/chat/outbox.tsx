// A message the person sent shows at the end of the transcript from Enter until the runtime's copy of it is there: its
// text, its tabs, captures and files (each file's upload progress while it uploads) and "Sending…". A send that failed
// stays with its error, an Edit action (its text and files go back into the composer) and a Retry action. The composer
// sends; the outbox holds the messages and drops each once the transcript or the session's queue shows it.
import { withoutCaptureSummaries } from '@gitspace/protocol-runtime';
import { Button, ChatMessage, useShape } from '@gitspace/ui';
import { File06 } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { ShareLink } from '../Composer.js';
import { CaptureChip } from '../capture-chip.js';
import { TabChip } from '../connected-tab.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { formatBytes } from '../inspector/artifact-upload.js';
import type { WorkspaceDraftCapture } from '../workspace-draft.js';
import { userMessageMarkdown } from './RichContent.js';

/** A message of the person's that the transcript shows; `truncated`: `text` is the start of it. */
export interface SentMessage { id: string; text: string; truncated: boolean }

/** Where a sent message lands: the transcript's messages of the person, and the session's queue. */
export interface OutboxArrivals {
  sent: readonly SentMessage[];
  queue: readonly string[];
  /** False while the transcript's newest rows are not loaded, so a message landing there would not be seen. */
  latest: boolean;
}

export interface OutgoingMessage {
  id: string;
  /** The person's text, trimmed. */
  text: string;
  /** What the message shows: `text` with the lines of the choices staged with it. */
  shown: string;
  files: readonly File[];
  tabs: readonly { link: ShareLink; host: string; browser: string | null }[];
  captures: readonly { id: string; name: string }[];
  /** The composer's draft when it was sent; the runtime clears this device's save of it. */
  draft: WorkspaceDraftCapture | undefined;
  /** Bytes stored so far of each file; null while nothing uploads. */
  progress: ReadonlyMap<File, number> | null;
  status: 'sending' | 'sent' | 'failed';
  error: string | null;
  /** The text the runtime accepted, once it did. */
  body: string | null;
  /** The transcript's messages of the person and the session's queue when it was sent. */
  before: { sent: ReadonlySet<string>; queue: readonly string[] };
}

export type OutgoingInput = Pick<OutgoingMessage, 'text' | 'shown' | 'files' | 'tabs' | 'captures' | 'draft'>;

/** What the composer does with a message of the outbox. */
export interface OutboxActions {
  edit(message: OutgoingMessage): void;
  retry(message: OutgoingMessage): void;
}

export interface Outbox {
  /** The messages not yet shown by the transcript or the queue, oldest first. */
  messages: readonly OutgoingMessage[];
  add(input: OutgoingInput): OutgoingMessage;
  update(id: string, patch: Partial<Pick<OutgoingMessage, 'progress' | 'status' | 'error' | 'body'>>): void;
  remove(id: string): void;
  /** The shown composer's actions; it sets them each render. */
  actions: { current: OutboxActions | null };
}

function words(text: string): string {
  return withoutCaptureSummaries(text).replace(/\s+/gu, ' ').trim();
}

/** Whether the transcript or the queue shows `message`: a message of the person's that is new since it was sent and has
 * its text, or one more queued copy of its text. The oldest accepted message also takes any new message of the
 * person's, so one the runtime rewrote (a skill command) does not stay pending. */
function arrived(message: OutgoingMessage, arrivals: OutboxArrivals, oldest: boolean): boolean {
  if (message.status !== 'sent' || message.body === null) return false;
  if (!arrivals.latest) return true;
  const body = words(message.body);
  const fresh = arrivals.sent.filter((sent) => !message.before.sent.has(sent.id));
  if (oldest && fresh.length) return true;
  if (fresh.some((sent) => {
    const text = words(sent.text);
    return sent.truncated ? text.length > 0 && (body.startsWith(text) || text.startsWith(body)) : text === body;
  })) return true;
  return arrivals.queue.filter((text) => words(text) === body).length > message.before.queue.filter((text) => words(text) === body).length;
}

export function useOutbox(arrivals: OutboxArrivals): Outbox {
  const [messages, setMessages] = useState<readonly OutgoingMessage[]>([]);
  const latest = useRef(arrivals);
  latest.current = arrivals;
  const actions = useRef<OutboxActions | null>(null);
  const pending = useMemo(() => {
    const oldest = messages.find((message) => message.status === 'sent');
    return messages.filter((message) => !arrived(message, arrivals, message === oldest));
  }, [messages, arrivals]);
  useEffect(() => {
    if (pending.length !== messages.length) setMessages((current) => current.filter((message) => pending.includes(message) || !messages.includes(message)));
  }, [pending, messages]);
  const operations = useMemo(() => ({
    add(input: OutgoingInput): OutgoingMessage {
      const message: OutgoingMessage = {
        ...input, id: crypto.randomUUID(), progress: null, status: 'sending', error: null, body: null,
        before: { sent: new Set(latest.current.sent.map((sent) => sent.id)), queue: latest.current.queue },
      };
      setMessages((current) => [...current, message]);
      return message;
    },
    update(id: string, patch: Partial<Pick<OutgoingMessage, 'progress' | 'status' | 'error' | 'body'>>): void {
      setMessages((current) => current.map((message) => message.id === id ? { ...message, ...patch } : message));
    },
    remove(id: string): void {
      setMessages((current) => current.filter((message) => message.id !== id));
    },
  }), []);
  return useMemo(() => ({ messages: pending, actions, ...operations }), [pending, operations]);
}

function OutgoingFiles({ message }: { message: OutgoingMessage }) {
  const shape = useShape();
  return <span role="group" aria-label="Attachments" className="flex min-w-0 flex-wrap justify-end gap-1.5">{message.files.map((file, index) => {
    const received = message.progress?.get(file);
    return <span key={`${file.name}:${file.size}:${file.lastModified}:${index}`} className={`${shape.container} inline-flex min-w-0 max-w-full items-center gap-2 bg-surface-2 px-3 py-2 text-foreground shadow-surface-1`}>
      <File06 width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
      <span className="min-w-0 text-body [overflow-wrap:anywhere]">{file.name}</span>
      <span role={received === undefined ? undefined : 'status'} className="shrink-0 text-caption tabular-nums text-muted-foreground">{received === undefined ? formatBytes(file.size)
        : received >= file.size ? 'Uploaded' : `Uploading ${Math.floor((received / Math.max(file.size, 1)) * 100)}%`}</span>
    </span>;
  })}</span>;
}

/** The outbox's messages as the person's messages at the end of the transcript. */
export function OutgoingMessages({ outbox }: { outbox: Outbox }) {
  if (!outbox.messages.length) return null;
  const sending = outbox.messages.some((message) => message.status === 'sending');
  return <div className="flex min-w-0 flex-col gap-6" aria-label="Messages being sent">{outbox.messages.map((message) => <div key={message.id} data-outgoing={message.status} className="flex min-w-0 flex-col items-end gap-0.5">
    <ChatMessage from="user" attachments={message.files.length ? <OutgoingFiles message={message} /> : undefined}>
      {message.tabs.length || message.captures.length ? <span className="flex flex-wrap gap-1.5 pb-1.5">
        {message.tabs.map((tab) => <TabChip key={tab.link.text} host={tab.host} detail={tab.browser} />)}
        {message.captures.map((capture) => <CaptureChip key={capture.id} name={capture.name} detail="Capture" />)}
      </span> : null}
      {message.shown ? <GitSpaceMarkdown>{userMessageMarkdown(message.shown)}</GitSpaceMarkdown> : null}
    </ChatMessage>
    {message.status === 'failed'
      ? <div className="flex min-w-0 flex-wrap items-center justify-end gap-x-2 px-1">
          <p role="alert" className="min-w-0 text-caption text-destructive [overflow-wrap:anywhere]">Not sent: {message.error}</p>
          <Button variant="ghost" size="compact" onClick={() => outbox.actions.current?.edit(message)}>Edit</Button>
          <Button variant="ghost" size="compact" disabled={sending} onClick={() => outbox.actions.current?.retry(message)}>Retry</Button>
        </div>
      : <p role="status" className="px-1 text-caption text-muted-foreground">Sending…</p>}
  </div>)}</div>;
}
