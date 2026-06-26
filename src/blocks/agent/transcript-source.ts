/**
 * Range-paginated transcript reads over a Pi SDK session's entry tree — the
 * storage-free read side of the infinite-scroll chat. The session is a tree of
 * entries (each with id/parentId); the displayed transcript is the branch from
 * the leaf toward root. We paginate by walking `parentId` (O(page), never the
 * whole transcript) and map each page's entries to blocks on demand.
 *
 * Structural types (not SDK imports) keep this pure + unit-testable; the real
 * `SessionManager` (getLeafId / getEntry returning SessionEntry) is structurally
 * assignable to `TranscriptSource`.
 */
import type { ImageContent, Message, TextContent } from '@oh-my-pi/pi-ai';
import type { Block } from '../index.js';
import { collectToolResults, messageToBlocks } from './message-blocks.js';

/** A session entry, narrowed to the fields the transcript display needs. */
export interface TranscriptEntry {
  id: string;
  parentId: string | null;
  type: string;
  /** present on `message` entries */
  message?: Message;
  /** present on `compaction` entries */
  summary?: string;
  shortSummary?: string;
  /** present on `custom_message` entries */
  content?: string | (TextContent | ImageContent)[];
  display?: boolean;
}

/** The read surface a SessionManager exposes (structurally compatible). */
export interface TranscriptSource {
  getLeafId(): string | null;
  getEntry(id: string): TranscriptEntry | undefined;
}

export interface TranscriptPage {
  blocks: Block[];
  /** id of the oldest entry in this page; pass as `before` to load the next older page. */
  oldestCursor: string | null;
  /** false once the root (no parent) has been reached. */
  hasMore: boolean;
}

function clip(text: string, max = 140): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function customMessageText(content: string | (TextContent | ImageContent)[]): string {
  if (typeof content === 'string') return content.trim();
  return content
    .filter((part): part is TextContent => part.type === 'text')
    .map((part) => part.text)
    .join('\n')
    .trim();
}

/**
 * Map a page of entries (display order: oldest → newest) to blocks. Message
 * entries map through the message mapper (tool results correlated within the
 * page); compaction/custom-message entries render as markers; other entry types
 * (model/mode/service-tier changes, labels, …) are not shown.
 */
export function entriesToBlocks(entries: ReadonlyArray<TranscriptEntry>): Block[] {
  const messages = entries
    .filter((entry): entry is TranscriptEntry & { message: Message } => entry.type === 'message' && !!entry.message)
    .map((entry) => entry.message);
  const results = collectToolResults(messages);

  const blocks: Block[] = [];
  for (const entry of entries) {
    if (entry.type === 'message' && entry.message) {
      blocks.push(...messageToBlocks(entry.message, entry.id, results));
    } else if (entry.type === 'compaction') {
      const text = entry.shortSummary ?? (entry.summary ? clip(entry.summary) : 'Earlier context was summarized.');
      blocks.push({ id: entry.id, type: 'callout', data: { tone: 'info', title: 'context compacted', text } });
    } else if (entry.type === 'custom_message' && entry.display && entry.content) {
      const text = customMessageText(entry.content);
      if (text) blocks.push({ id: entry.id, type: 'callout', data: { tone: 'info', text } });
    }
  }
  return blocks;
}

/**
 * Read one page of the transcript. `before` omitted → the newest page (tail);
 * `before` = a prior `oldestCursor` → the next older page. Pages are bounded by
 * entry count (`limit`), so the cursor advances even when some entries render no
 * blocks.
 */
export function getTranscriptRange(source: TranscriptSource, opts: { before?: string; limit: number }): TranscriptPage {
  const limit = Math.max(1, opts.limit);

  let startId: string | null;
  if (opts.before) {
    const beforeEntry = source.getEntry(opts.before);
    startId = beforeEntry ? beforeEntry.parentId : null;
  } else {
    startId = source.getLeafId();
  }

  const collected: TranscriptEntry[] = [];
  let cursor: string | null = startId;
  while (cursor && collected.length < limit) {
    const entry = source.getEntry(cursor);
    if (!entry) break;
    collected.push(entry);
    cursor = entry.parentId;
  }

  if (collected.length === 0) {
    return { blocks: [], oldestCursor: null, hasMore: false };
  }

  const oldest = collected[collected.length - 1];
  const ordered = [...collected].reverse(); // oldest → newest for display
  return {
    blocks: entriesToBlocks(ordered),
    oldestCursor: oldest.id,
    hasMore: oldest.parentId !== null,
  };
}
