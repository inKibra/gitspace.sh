import { type ReactElement } from 'react';
import { BlockList } from './registry.web.js';
import { BlockHostProvider, type BlockHost } from './host.web.js';

/**
 * The native agent transcript: a stream of blocks rendered through the registry,
 * with interactivity routed to the injected host. This replaces the terminal
 * (xterm) view of the agent. Stateless — the caller supplies the block stream
 * (from the agent session) and a host (wired to the engine's response calls).
 */
export function AgentTranscript({
  blocks,
  host,
  busy = false,
}: {
  blocks: readonly unknown[];
  host: BlockHost;
  busy?: boolean;
}): ReactElement {
  return (
    <BlockHostProvider host={host}>
      <div className="flex h-full flex-col overflow-y-auto px-3 py-2">
        {blocks.length === 0 ? (
          <div className="py-10 text-center text-[12px] text-[var(--gs-text-dim)]">No messages yet.</div>
        ) : (
          <BlockList blocks={blocks} />
        )}
        {busy && (
          <div className="px-1 py-1.5 text-[11px] text-[var(--gs-warning)]">
            <span className="mr-1 inline-block animate-pulse">●</span> working…
          </div>
        )}
      </div>
    </BlockHostProvider>
  );
}
