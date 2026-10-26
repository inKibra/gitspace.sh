import type { RuntimeBrowserComment, RuntimeBrowserCommentAnchor, RuntimeBrowserCommentAuthor, RuntimeBrowserCommentBox, RuntimeBrowserCommentThread } from '@gitspace/protocol-runtime';
import { useState } from 'react';
import type { CSSProperties } from 'react';

/** Chrome's purple tab-group colour, which marks comments: pins, outlines and the comment buttons. */
export const COMMENT_PURPLE = '#a142f4';
/** A resolved thread's pin, and a person's avatar. */
const COMMENT_GRAY = '#525252';
/** An agent's avatar: Chrome's blue, as the overlay draws the agent. */
const AGENT_BLUE = '#1a73e8';
/** The thread popover is `w-72`; it sits this far beside its pin and needs about this much height. */
const POPOVER_WIDTH_PX = 288;
const POPOVER_GAP_PX = 12;
const POPOVER_HEIGHT_PX = 220;

/** The name a comment shows: the person's, `main` for the main agent, `agent` for a subagent. */
export function commentAuthorName(by: RuntimeBrowserCommentAuthor): string {
  return by.kind === 'agent' ? by.conversation === 'main' ? 'main' : 'agent' : by.name;
}

/** `button “Pay now”`, or `an area of the page` for a dragged area. */
export function commentAnchorLabel(anchor: RuntimeBrowserCommentAnchor | null): string {
  if (!anchor || (!anchor.role && !anchor.name)) return 'an area of the page';
  const role = anchor.role || 'element';
  return anchor.name ? `${role} “${anchor.name}”` : role;
}

/** "3 min ago": how long ago `at` was, from `now`. */
export function commentAge(at: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(at)) / 1000));
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ago`;
  return new Date(at).toLocaleDateString();
}

/** Threads in the order they were started, each numbered from 1, a thread keeping its number as others are added. */
export function numberThreads(threads: readonly RuntimeBrowserCommentThread[]): { thread: RuntimeBrowserCommentThread; n: number }[] {
  return threads.toSorted((a, b) => a.root.createdAt.localeCompare(b.root.createdAt) || a.root.id.localeCompare(b.root.id)).map((thread, index) => ({ thread, n: index + 1 }));
}

/** A numbered pin at the top-right corner of a thread's anchor box (fractions of the frame); purple while open, gray
 * once resolved. `highlighted` rings it and outlines the box, as Show on page and an open popover do. */
export function CommentPin({ n, box, resolved, highlighted, onClick }: { n: number; box: RuntimeBrowserCommentBox; resolved: boolean; highlighted: boolean; onClick?: () => void }) {
  const color = resolved ? COMMENT_GRAY : COMMENT_PURPLE;
  const pin = { left: `${Math.min(1, box.x + box.w) * 100}%`, top: `${box.y * 100}%`, background: color, boxShadow: highlighted ? `0 0 0 3px white, 0 0 0 5px ${color}` : undefined };
  const className = 'absolute z-20 flex size-6 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full rounded-bl-none text-[11px] font-bold text-white shadow-md';
  return <>
    {highlighted ? <span aria-hidden className="pointer-events-none absolute z-10 rounded" style={{ left: `${box.x * 100}%`, top: `${box.y * 100}%`, width: `${box.w * 100}%`, height: `${box.h * 100}%`, outline: `2px dashed ${color}`, outlineOffset: 2 }} /> : null}
    {onClick
      ? <button type="button" aria-label={`Comment ${n}`} aria-pressed={highlighted} className={className} style={pin}
        onPointerDown={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
        onClick={event => { event.stopPropagation(); onClick(); }}>{n}</button>
      : <span role="img" aria-label={`Comment ${n}`} className={`pointer-events-none ${className}`} style={pin}>{n}</span>}
  </>;
}

/** Where a thread's popover goes in a frame `width` × `height` px: beside its box, on the side with room; at the top
 * right without one. */
export function placeThread(box: RuntimeBrowserCommentBox | null, width: number, height: number): CSSProperties {
  if (!box) return { right: 12, top: 12 };
  const right = (box.x + box.w) * width + POPOVER_GAP_PX;
  const left = right + POPOVER_WIDTH_PX <= width ? right : Math.max(0, Math.min(width - POPOVER_WIDTH_PX, box.x * width - POPOVER_GAP_PX - POPOVER_WIDTH_PX));
  return { left, top: Math.max(8, Math.min(box.y * height - 8, height - POPOVER_HEIGHT_PX)) };
}

/** One comment of a thread: avatar (the person's initial in gray, `AI` in blue for an agent), name, age, text. */
export function CommentMessage({ comment, now }: { comment: RuntimeBrowserComment; now: number }) {
  const agent = comment.by.kind === 'agent', name = commentAuthorName(comment.by);
  return <div className="flex gap-2">
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold text-white" style={{ background: agent ? AGENT_BLUE : COMMENT_GRAY }}>{agent ? 'AI' : [...name.trim()][0]?.toUpperCase() ?? '?'}</span>
    <div className="min-w-0">
      <p className="text-[11px]"><strong>{name}</strong>{comment.by.kind === 'person' && comment.by.guest ? ' (guest)' : ''} <time dateTime={comment.createdAt} className="text-neutral-400">· {commentAge(comment.createdAt, now)}</time></p>
      <p className="whitespace-pre-wrap break-words">{comment.text}</p>
    </div>
  </div>;
}

/** Replying to and resolving threads. Each settles once the change is saved, or rejects with why it was not. */
export interface ThreadActions {
  reply(threadId: string, text: string): Promise<void>;
  resolve(threadId: string, reopen: boolean): Promise<void>;
}

/** One thread's reply draft and its reply and resolve in flight: the draft empties once its reply is saved and stays,
 * with the reason, when it is not. */
export function useThreadReply(threadId: string, actions: ThreadActions) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState<'reply' | 'resolve' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const run = async (kind: 'reply' | 'resolve', operation: () => Promise<void>) => {
    setBusy(kind); setError(null);
    try { await operation(); if (kind === 'reply') setText(''); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(null); }
  };
  return {
    text, setText, busy, error,
    send() { const trimmed = text.trim(); if (trimmed && busy === null) void run('reply', () => actions.reply(threadId, trimmed)); },
    resolve(reopen: boolean) { if (busy === null) void run('resolve', () => actions.resolve(threadId, reopen)); },
  };
}

export interface ThreadPopoverProps {
  thread: RuntimeBrowserCommentThread;
  n: number;
  /** Who replies here, as the reply field says: "Reply as Grace (guest)…". */
  as: string;
  /** The account's owner: Resolve and Reopen. */
  canResolve: boolean;
  actions: ThreadActions;
  style: CSSProperties;
  now: number;
  onClose(): void;
}

/** A thread over the page (the in-page tool's look): where it points, its comments, a reply field, Resolve for the
 * account's owner and a purple Reply. `key` it by thread so a draft reply stays with its thread. */
export function ThreadPopover({ thread, n, as, canResolve, actions, style, now, onClose }: ThreadPopoverProps) {
  const { root, replies } = thread;
  const draft = useThreadReply(root.id, actions);
  return <div
    role="dialog" aria-label={`Comment thread ${n}`}
    onPointerDown={event => event.stopPropagation()} onPointerMove={event => event.stopPropagation()} onPointerUp={event => event.stopPropagation()}
    onKeyDown={event => { if (event.key === 'Escape') onClose(); }}
    className="absolute z-30 flex max-h-[80%] w-72 max-w-[80vw] cursor-auto flex-col gap-2 overflow-y-auto rounded-xl border border-neutral-200 bg-white p-3 text-[12px] text-neutral-800 shadow-2xl"
    style={style}
  >
    <div className="flex items-start gap-2">
      <p className="min-w-0 flex-1 text-[11px] text-neutral-500">On {commentAnchorLabel(root.anchor)}{root.resolved ? <> · resolved by <strong className="text-neutral-700">{root.resolved.by}</strong></> : null}</p>
      <button type="button" aria-label="Close thread" className="-mr-1 -mt-1 rounded px-1 text-[13px] leading-none text-neutral-400 hover:text-neutral-800" onClick={onClose}>×</button>
    </div>
    <CommentMessage comment={root} now={now} />
    {replies.map(reply => <CommentMessage key={reply.id} comment={reply} now={now} />)}
    <textarea
      aria-label="Your reply" rows={2} value={draft.text} maxLength={4000} placeholder={`Reply as ${as}…`} disabled={draft.busy === 'reply'}
      className="w-full resize-none rounded-lg border border-neutral-300 bg-white px-2 py-1.5 text-[12px] text-neutral-800 placeholder:text-neutral-400 focus:border-[#a142f4] focus:outline-none"
      onChange={event => draft.setText(event.currentTarget.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); draft.send(); } }}
    />
    {draft.error ? <p role="alert" className="text-[11px] text-red-600">{draft.error}</p> : null}
    <div className="flex items-center gap-2">
      {canResolve ? <button type="button" disabled={draft.busy !== null} className="text-[11px] text-neutral-500 hover:text-neutral-800 disabled:opacity-50" onClick={() => draft.resolve(root.resolved !== null)}>{root.resolved ? 'Reopen' : 'Resolve'}</button> : null}
      <span className="flex-1" />
      <button type="button" disabled={!draft.text.trim() || draft.busy !== null} className="rounded-lg px-2.5 py-1 text-[12px] font-medium text-white disabled:opacity-50" style={{ background: COMMENT_PURPLE }} onClick={draft.send}>{draft.busy === 'reply' ? 'Sending…' : 'Reply'}</button>
    </div>
  </div>;
}
