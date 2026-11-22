// Where a ghost opens from inside a workspace's view: "Ask a ghost about this" on each entry of its main transcript, a
// ghost from a compaction row's point in time, and a ghost of a subagent's session from its entry or Inspector card.
import { GHOST_ENTRY_ORDINALS } from '@gitspace/protocol-runtime';
import { Tooltip } from '@gitspace/ui';
import { ClockRewind } from '@untitledui/icons';
import { createContext, useContext, type ReactNode } from 'react';
import { GHOST, GhostGlyph } from './ghost-parts.js';
import { summonGhost, type GhostSubject } from './ghost-store.js';

/** The workspace on screen, its main conversation as the session: set by the workspace view. */
export const GhostWorkspace = createContext<GhostSubject | null>(null);
/** True inside the transcript of the workspace's main conversation, whose entries a ghost of it cites. */
export const GhostMainTranscript = createContext(false);

/**
 * A transcript entry of the workspace's main conversation (at `ordinal`): while hovered it offers "Ask a ghost about
 * this", a ghost of the conversation about that entry. A compaction row also offers a ghost from that point: it reads
 * nothing after the row, and the drive and Chatter as they were then.
 */
export function GhostEntry({ ordinal, compaction, children }: { ordinal: number; compaction: boolean; children: ReactNode }) {
  const workspace = useContext(GhostWorkspace);
  const main = useContext(GhostMainTranscript);
  if (!workspace || !main) return children;
  const entry = Math.floor(ordinal / GHOST_ENTRY_ORDINALS);
  return <div className="ghost-entry relative min-w-0" data-ghost-entry={entry}>
    {children}
    {compaction ? <Tooltip side="left" content={<span className="block max-w-[240px] whitespace-normal leading-snug">A ghost that reads this conversation only up to here, and the drive as it was then: what did the agent know, and what did this summary leave out?</span>}>
      <button type="button" aria-label="Ask a ghost from here" onClick={() => summonGhost({ ...workspace, until: entry })}
        className="ghost-ask absolute right-0 top-0 inline-flex h-6 items-center gap-1 rounded-full px-2 text-[11px] font-medium"><ClockRewind width={12} height={12} strokeWidth={1.75} />Ghost from here</button>
    </Tooltip> : null}
    <Tooltip side="left" content="Ask a ghost about this">
      <button type="button" aria-label="Ask a ghost about this" onClick={() => summonGhost(workspace, { about: entry })}
        className="ghost-entry-ask absolute -right-7 top-0.5 flex size-6 items-center justify-center rounded-full hover:bg-foreground/[0.07]" style={{ color: GHOST }}><GhostGlyph size={15} /></button>
    </Tooltip>
  </div>;
}

/** A ghost of one session of the workspace on screen (a subagent's, by its conversation id), from its entry or card. */
export function GhostSessionButton({ conversationId, title }: { conversationId: string; title: string }) {
  const workspace = useContext(GhostWorkspace);
  if (!workspace) return null;
  return <Tooltip side="top" content={`Ask a ghost about ${title} · reads its session, changes nothing`}>
    <button type="button" aria-label={`Ask a ghost about ${title}`} data-ghost-session={conversationId} onClick={() => summonGhost({ ...workspace, conversationId, title, until: null })}
      className="ghost-ask inline-flex h-7 shrink-0 items-center gap-1 rounded-full px-2.5 text-[11.5px] font-medium"><GhostGlyph size={14} />Ask a ghost</button>
  </Tooltip>;
}
