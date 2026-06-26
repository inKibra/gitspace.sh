import { type ReactElement } from 'react';
import type { Block } from '../index.js';
import type { TranscriptPage } from '../agent/transcript-source.js';
import { BlockList } from './registry.web.js';
import { BlockHostProvider, type BlockHost } from './host.web.js';
import { useTranscript } from './useTranscript.web.js';

/**
 * The native agent transcript — an infinite-scroll surface that replaces the
 * xterm agent view. A committed prefix is paged from the session via
 * `fetchRange` (pull, oldest-ward); `live` is the streaming suffix (push).
 * Interactivity routes through the injected `BlockHost`.
 */
export function AgentTranscript({
  fetchRange,
  live,
  host,
  busy = false,
  pageSize,
}: {
  fetchRange: (before: string | undefined, limit: number) => Promise<TranscriptPage>;
  live: readonly Block[];
  host: BlockHost;
  busy?: boolean;
  pageSize?: number;
}): ReactElement {
  const t = useTranscript({ fetchRange, live, pageSize });
  const empty = t.committed.length === 0 && live.length === 0;

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
              <BlockList blocks={t.committed} />
              <BlockList blocks={live} />
            </>
          )}

          {busy && (
            <div className="px-1 py-1.5 text-[11px] text-[var(--gs-warning)]">
              <span className="mr-1 inline-block animate-pulse">●</span> working…
            </div>
          )}
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
