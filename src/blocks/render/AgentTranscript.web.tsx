import { type ReactElement } from 'react';
import type { Block } from '../index.js';
import type { TranscriptPage } from '../agent/transcript-source.js';
import { BlockList } from './registry.web.js';
import { BlockHostProvider, type BlockHost } from './host.web.js';
import { useTranscript } from './useTranscript.web.js';

const EMPTY: readonly Block[] = [];

/**
 * The native agent transcript — an infinite-scroll surface that replaces the
 * xterm agent view. A committed prefix is paged from the session via
 * `fetchRange` (pull, oldest-ward); `live` is the streaming suffix (push).
 * Interactivity routes through the injected `BlockHost`.
 */
export function AgentTranscript({
  fetchRange,
  live,
  pending = EMPTY,
  tail = EMPTY,
  host,
  busy = false,
  pageSize,
  refreshNonce,
}: {
  fetchRange: (before: string | undefined, limit: number) => Promise<TranscriptPage>;
  live: readonly Block[];
  /** Pending interactive blocks (permissions / questions / todos) — shown at the
   *  foot, not folded into history; resolve through the host. */
  pending?: readonly Block[];
  /** Transient orientation (the idle recap) — always the LAST thing on screen and
   *  deliberately NOT part of `live`: `live` emptying is what tells the transcript
   *  a turn finished and to fold it into history, so parking a long-lived block
   *  there would stop that from ever happening. */
  tail?: readonly Block[];
  host: BlockHost;
  busy?: boolean;
  pageSize?: number;
  /** Bump to force a full refetch (after a conversation rewind). */
  refreshNonce?: number;
}): ReactElement {
  const t = useTranscript({ fetchRange, live, pageSize, refreshNonce });

  // De-duplicate by block id across the three regions so a transient overlap
  // (e.g. a just-committed turn briefly present in both committed and live)
  // never renders the same key twice. Committed wins, then live, then pending.
  const seen = new Set<string>();
  const uniq = (blocks: readonly Block[]): Block[] =>
    blocks.filter((b) => (seen.has(b.id) ? false : (seen.add(b.id), true)));
  const committedBlocks = uniq(t.committed);
  const liveBlocks = uniq(live);
  const pendingBlocks = uniq(pending);
  const tailBlocks = uniq(tail);

  const empty = committedBlocks.length === 0 && liveBlocks.length === 0 && pendingBlocks.length === 0 && tailBlocks.length === 0;

  return (
    <BlockHostProvider host={host}>
      <div className="relative flex h-full flex-col">
        <div ref={t.containerRef} onScroll={t.onScroll} className="flex-1 overflow-y-auto px-3 py-2">
          {t.loadingOlder && <div className="py-2 text-center text-[11px] text-[var(--gs-text-dim)]">loading older…</div>}
          {t.olderError && (
            <div className="py-2 text-center text-[11px] text-[var(--gs-danger)]">
              {t.olderError} · <button type="button" className="underline" onClick={t.retryOlder}>retry</button>
            </div>
          )}
          {!t.hasMoreOlder && !t.loadingOlder && !empty && (
            <div className="py-2 text-center text-[10px] uppercase tracking-wide text-[var(--gs-text-ghost)]">beginning of conversation</div>
          )}

          {empty ? (
            <div className="py-10 text-center text-[12px] text-[var(--gs-text-dim)]">No messages yet.</div>
          ) : (
            <>
              <BlockList blocks={committedBlocks} />
              <BlockList blocks={liveBlocks} />
            </>
          )}

          {busy && (
            <div className="px-1 py-1.5 text-[11px] text-[var(--gs-warning)]">
              <span className="mr-1 inline-block animate-pulse">●</span> working…
            </div>
          )}

          {pendingBlocks.length > 0 && <BlockList blocks={pendingBlocks} />}
          {tailBlocks.length > 0 && <BlockList blocks={tailBlocks} />}
        </div>

        {t.mode === 'browse' && t.newBelowCount > 0 && (
          <button
            type="button"
            onClick={t.jumpToLatest}
            className="absolute bottom-3 left-1/2 -translate-x-1/2 border border-[var(--gs-accent)] bg-[var(--gs-bg-elevated)] px-3 py-1 text-[11px] text-[var(--gs-accent)] shadow"
          >
            ↓ {t.newBelowCount} new · jump to latest
          </button>
        )}
      </div>
    </BlockHostProvider>
  );
}
