import type { TranscriptItem, WorkspaceReportBlock } from '@gitspace/blocks';
import type { AutomationMessage } from '@gitspace/protocol/automations-contract';
import { Button, badgeColors, useShape } from '@gitspace/ui';
import { ArrowUpRight, ChevronDown, ChevronRight, Globe02, MessageChatCircle, Terminal, Users01, Zap } from '@untitledui/icons';
import { useState, type CSSProperties, type ReactNode } from 'react';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { automationsUrl, navigateProductUrl, setProductRoute } from '../routes.js';
import { JsonTree } from './JsonTree.js';
import { isJsonValue } from './staging.js';
import type { ItemInteractionProps } from './TranscriptItemView.js';

export const PERMISSION_BADGE: Record<string, 'green' | 'red' | 'amber' | 'gray'> = { pending: 'amber', 'allowed-once': 'green', 'allowed-always': 'green', denied: 'red' };
const REPORT_OUTCOME: Record<WorkspaceReportBlock['outcome'], { label: string; color: keyof typeof badgeColors }> = {
  finished: { label: 'finished', color: 'blue' },
  failed: { label: 'failed', color: 'red' },
  asked: { label: 'asked', color: 'orange' },
  approval: { label: 'needs approval', color: 'orange' },
};

/** A turn a workspace ran for the project agent, in one line: the workspace (a link to it), how the turn came out, and
 * its reply, failure or question folded to one line until clicked. */
export function WorkspaceReportRow({ item, state, onStateChange }: { item: WorkspaceReportBlock } & ItemInteractionProps) {
  const [localOpen, setLocalOpen] = useState(false);
  const open = state?.open ?? localOpen;
  const outcome = REPORT_OUTCOME[item.outcome];
  const href = `/?project=${encodeURIComponent(item.projectId)}&workspace=${encodeURIComponent(item.workspaceId)}`;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="min-w-0 text-caption text-muted-foreground" data-workspace-report={item.outcome}>
    <div className="flex min-h-6 min-w-0 items-center gap-2">
      <span className="status-dot" style={{ color: badgeColors[outcome.color] }} aria-hidden />
      <a className="shrink-0 font-medium text-foreground underline-offset-4 hover:underline" href={href} onClick={(event) => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigateProductUrl(setProductRoute(new URL(href, window.location.href), 'agent'));
      }}>{item.name}</a>
      <span className="shrink-0">{outcome.label}</span>
      {item.excerpt ? <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        aria-expanded={open}
        aria-label={open ? 'Hide details' : undefined}
        onClick={() => { setLocalOpen(!open); onStateChange?.({ open: !open }); }}
      ><Chevron width={14} height={14} strokeWidth={1.5} className="shrink-0" />{open ? null : <span className="min-w-0 truncate">{item.excerpt}</span>}</button> : null}
    </div>
    {open && item.excerpt ? <p className="whitespace-pre-wrap pb-1 pl-4 [overflow-wrap:anywhere]">{item.excerpt}</p> : null}
  </div>;
}

export function Notice({ icon, title, detail, body, badge }: { icon: ReactNode; title: string; detail?: string; body?: string; badge?: ReactNode }) {
  const shape = useShape();
  return <div className={`${shape.container} flex min-w-0 items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block text-body text-foreground">{title}</span>{detail ? <span className="block whitespace-pre-line text-caption text-muted-foreground">{detail}</span> : null}
      {body ? <details className="mt-1 text-caption"><summary className="cursor-pointer text-muted-foreground">Show full message</summary><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-caption text-muted-foreground">{body}</pre></details> : null}</span>
    {badge}
  </div>;
}

type InterruptionBlock = Extract<TranscriptItem, { type: 'interruption' }>;
const ICON = { width: 14, height: 14, strokeWidth: 1.75 };

/** A turn that is neither the person's nor the agent's own: what started it and from where, edged in its kind's colour. */
function OriginCard({ tone, icon, kind, source, children, footer }: { tone: string; icon: ReactNode; kind: ReactNode; source?: ReactNode; children?: ReactNode; footer?: ReactNode }) {
  const shape = useShape();
  const edge: CSSProperties & Record<'--edge', string> = { '--edge': tone };
  return <section className={`relative isolate min-w-0 overflow-hidden border border-border bg-card ${shape.container}`} style={edge}>
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 -z-10 w-40 bg-[radial-gradient(100%_75%_at_0%_50%,color-mix(in_oklab,var(--edge)_9%,transparent),transparent)] dark:bg-[radial-gradient(100%_75%_at_0%_50%,color-mix(in_oklab,var(--edge)_14%,transparent),transparent)]" />
    <span aria-hidden className="pointer-events-none absolute inset-y-0 left-0 w-0.5 bg-[linear-gradient(180deg,transparent,var(--edge)_14%,var(--edge)_86%,transparent)] dark:shadow-[0_0_12px_color-mix(in_oklab,var(--edge)_65%,transparent)]" />
    <header className="flex min-w-0 items-start gap-2.5 px-4 pb-1 pt-3">
      <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: tone, background: `color-mix(in oklab, ${tone} 14%, transparent)` }}>{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-body font-medium text-foreground [overflow-wrap:anywhere]">{kind}</span>
        {source ? <span className="block text-caption text-muted-foreground [overflow-wrap:anywhere]">{source}</span> : null}
      </span>
    </header>
    {children ? <div className="min-w-0 px-4 pb-3 pl-[50px] text-body text-foreground">{children}</div> : null}
    {footer ? <footer className="flex min-w-0 flex-wrap items-center gap-1 border-t border-border px-3 py-1.5 pl-[46px] text-caption text-muted-foreground">{footer}</footer> : null}
  </section>;
}

function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return <div className="mt-2 flex min-w-0 flex-col gap-1.5">
    <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="flex items-center gap-1 self-start text-caption text-muted-foreground hover:text-foreground">
      <Chevron width={14} height={14} strokeWidth={1.5} />{label}
    </button>
    {open ? children : null}
  </div>;
}

/** Markdown that folds to its first lines until opened. */
function FoldedMarkdown({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > 420;
  return <>
    <div className={`relative ${long && !open ? 'max-h-40 overflow-hidden' : ''}`}>
      <GitSpaceMarkdown>{text}</GitSpaceMarkdown>
      {long && !open ? <span aria-hidden className="absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-card to-transparent" /> : null}
    </div>
    {long ? <button type="button" onClick={() => setOpen(!open)} className="mt-1 text-caption text-muted-foreground hover:text-foreground">{open ? 'Show less' : 'Show all'}</button> : null}
  </>;
}

/** An automation run's message: the turn it started, or a notice the agent reads on its next turn. */
export function AutomationCard({ message, delivery }: { message: AutomationMessage; delivery: 'turn' | 'notice' }) {
  return <OriginCard tone={badgeColors.amber} icon={<Zap {...ICON} />}
    kind={<>Automation <span className="font-normal text-muted-foreground">·</span> {message.name}</>}
    source={<><span className="font-mono">{message.event}</span> · {message.summary}</>}
    footer={<>
      <Button variant="ghost" size="compact" type="button" onClick={() => navigateProductUrl(automationsUrl(new URL(window.location.href).searchParams.get('project')))}>Open automations<ArrowUpRight width={12} height={12} strokeWidth={1.5} className="ml-0.5 opacity-60" /></Button>
      <span className="ml-auto pr-1">{delivery === 'turn' ? 'Started this turn' : 'The agent reads this on its next turn'}</span>
    </>}>
    <FoldedMarkdown text={message.instruction} />
    {isJsonValue(message.fields) ? <Disclosure label="The event"><JsonTree value={message.fields} name="event" /></Disclosure> : null}
  </OriginCard>;
}

const EVENT_KIND: Record<string, { tone: string; icon: ReactNode; kind: (source: string) => ReactNode }> = {
  'agent-message': { tone: badgeColors.indigo, icon: <Users01 {...ICON} />, kind: (source) => <>Message from {source}</> },
  workspace: { tone: badgeColors.teal, icon: <MessageChatCircle {...ICON} />, kind: (source) => <>Message from workspace {source}</> },
  'command-completed': { tone: badgeColors.gray, icon: <Terminal {...ICON} />, kind: (source) => <>{source} finished</> },
  'process-exited': { tone: badgeColors.gray, icon: <Terminal {...ICON} />, kind: () => 'Process exited' },
  'browser-taken': { tone: badgeColors.blue, icon: <Globe02 {...ICON} />, kind: (source) => source },
  'browser-handback': { tone: badgeColors.blue, icon: <Globe02 {...ICON} />, kind: (source) => source },
  'capture-replay': { tone: badgeColors.blue, icon: <Globe02 {...ICON} />, kind: (source) => source },
  'page-comment': { tone: badgeColors.blue, icon: <Globe02 {...ICON} />, kind: (source) => source },
};

/** What GitSpace delivered to the agent on someone else's behalf: a subagent's or workspace's message, a finished
 * background command, an exited process, a browser event. A message whose first line heads a JSON value shows the line
 * and the value as a tree. */
export function EventCard({ item }: { item: InterruptionBlock }) {
  const text = item.body ?? item.detail ?? '';
  const [head = '', ...rest] = text.split('\n');
  let value: unknown = null;
  try { value = rest.length ? JSON.parse(rest.join('\n')) : null; } catch { value = null; }
  const structured = value !== null && typeof value === 'object' && isJsonValue(value) ? value : null;
  const style = EVENT_KIND[item.kind ?? ''] ?? { tone: badgeColors.violet, icon: <Zap {...ICON} />, kind: (source: string) => source };
  return <div data-event={item.kind ?? 'event'}><OriginCard tone={style.tone} icon={style.icon} kind={style.kind(item.title)} source={item.kind === 'process-exited' || item.kind === 'command-completed' ? item.title : undefined}
    footer={<span className="ml-auto pr-1">Delivered to the agent</span>}>
    {structured ? <>{head ? <p className="[overflow-wrap:anywhere]">{head}</p> : null}<Disclosure label="Details"><JsonTree value={structured} name={item.kind ?? 'event'} /></Disclosure></> : <FoldedMarkdown text={text} />}
  </OriginCard></div>;
}

const NOTICE_SOURCE_COLOR: Record<string, string> = { Stack: badgeColors.gray, Blocks: badgeColors.amber };

/** One of GitSpace's own notices to the agent (a machine, the stack, an invalid block), a quiet line; the agent reads it on its next turn. */
export function NoticeRow({ item }: { item: InterruptionBlock }) {
  const text = item.detail ?? '';
  const color = NOTICE_SOURCE_COLOR[item.title]
    ?? (/\b(fail(ed|s)?|error|conflict|could not|not published|offline)\b/iu.test(text) ? badgeColors.red
      : /\b(ready|attached|online|published|restored|connected)\b/iu.test(text) ? badgeColors.green : badgeColors.gray);
  return <p data-notice={item.title} className="flex min-w-0 items-start gap-2 px-1 text-caption text-muted-foreground">
    <span className="status-dot mt-1 shrink-0" style={{ color }} />
    <span className="min-w-0 flex-1 whitespace-pre-line [overflow-wrap:anywhere]"><span className="font-medium text-foreground/80">{item.title}</span> · {text}</span>
  </p>;
}
