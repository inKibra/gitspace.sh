// The goal's decisions, the person's view of the journal: its `decision` entries newest first, who decided and when,
// the conversation messages they cite, the guide section they belong to, and which later decision replaced them.
import { Badge, Button } from '@gitspace/ui';
import type { ChangeGuideView, JournalEntryView } from '@gitspace/protocol';
import { STAGED_CHOICE_DATA } from '@gitspace/protocol-runtime/session-controls';
import { ArrowUpRight, BookOpen01 } from '@untitledui/icons';
import type { ReactElement } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { formatDate } from '../inspector/inspector-shared.js';
import { personLabel } from './Evidence.js';

export function DecisionsSection({ entries, guide, viewerId, onOpenGuideSection, onOpenJournal }: {
  entries: readonly JournalEntryView[]; guide: ChangeGuideView | null; viewerId: string;
  onOpenGuideSection(sectionId: string): void; onOpenJournal(): void;
}): ReactElement {
  const decisions = entries.filter(entry => entry.kind === 'decision').sort((a, b) => b.sequence - a.sequence);
  const replacedBy = new Map<string, JournalEntryView>();
  for (const entry of decisions) if (entry.supersedes) replacedBy.set(entry.supersedes, entry);
  return <div className="flex flex-col gap-5">
    {decisions.length ? <ol className="flex flex-col gap-6">
      {decisions.map(decision => {
        const replacement = replacedBy.get(decision.id);
        const replaced = decision.supersedes ? decisions.find(entry => entry.id === decision.supersedes) : undefined;
        const section = decision.sectionId ? guide?.sections.findIndex(candidate => candidate.id === decision.sectionId) ?? -1 : -1;
        return <li key={decision.id} className="flex flex-col gap-2" aria-label={decision.title}>
          <p className="flex flex-wrap items-center gap-2">
            <span className={`text-body font-medium ${replacement ? 'text-muted-foreground line-through' : 'text-foreground'}`}>{decision.title}</span>
            {replacement ? <Badge size="compact" color="gray">Superseded by “{replacement.title}”</Badge> : null}
          </p>
          <p className="text-caption text-muted-foreground">Decided by <span className="text-foreground">{personLabel(decision.createdBy, viewerId)}</span> · <time className="tabular-nums">{formatDate(decision.createdAt)}</time>{replaced ? <> · replaces “{replaced.title}”</> : null}</p>
          {decision.body.trim() ? <GitSpaceMarkdown className="text-body">{decision.body.replace(STAGED_CHOICE_DATA, '$1')}</GitSpaceMarkdown> : null}
          {decision.citations?.length ? <ol className="flex flex-col gap-2 border-l-2 border-border pl-3" aria-label="Citations">
            {decision.citations.map(citation => <li key={`${citation.conversationId}:${citation.messageId}`} className="flex flex-col">
              <span className="text-[11px] text-muted-foreground">{citation.who} · <time className="tabular-nums">{formatDate(citation.at)}</time></span>
              <blockquote className="text-body text-foreground/85">“{citation.quote.replace(STAGED_CHOICE_DATA, '$1')}”</blockquote>
            </li>)}
          </ol> : null}
          {section >= 0 && decision.sectionId ? <Button variant="ghost" size="compact" type="button" className="self-start" onClick={() => { if (decision.sectionId) onOpenGuideSection(decision.sectionId); }}><BookOpen01 width={13} height={13} />Guide §{section + 1}</Button> : null}
        </li>;
      })}
    </ol> : <p className="text-body text-muted-foreground">No decisions recorded yet.</p>}
    <button type="button" onClick={onOpenJournal} className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground hover:underline">Full log in the Journal tab<ArrowUpRight width={12} height={12} /></button>
  </div>;
}
