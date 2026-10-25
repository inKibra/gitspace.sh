import type { AskBlock, ExecutionBlock, MessageImage, RichContentBlock, SideAgentBlock, ToolCallBlock, TranscriptItem, TransportBlock, TurnBlock, WorkspaceReportBlock } from '@gitspace/blocks';
import type { PendingAskAnswer } from '@gitspace/protocol';
import { RuntimeBrowserExecutionSchema } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { AskUserQuestions, Badge, badgeColors, Button, ChatMessage, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ThinkingIndicator, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useShape, type AskUserAnswer, type IconName } from '@gitspace/ui';
import { AlertCircle, ChevronDown, ChevronRight, GitBranch01, Link03, ShieldTick, Terminal, Users01 } from '@untitledui/icons';
import { connectedTabsIn, TabChip } from './connected-tab.js';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { ResourceLink } from './ResourceNavigation.js';
import { TranscriptImage } from './resource-media.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { glyph } from './glyph.js';
import { navigateProductUrl, setProductRoute } from './routes.js';
import { useContext, useState, type ReactNode } from 'react';
import { TakeoverCard, TakeoverCardsContext } from './TakeoverCard.js';

function RichContent({ block }: { block: RichContentBlock }) {
  switch (block.type) {
    case 'markdown': return <GitSpaceMarkdown>{block.text}</GitSpaceMarkdown>;
    case 'code': return <GitSpaceMarkdown>{`~~~${block.language ?? ''}\n${block.text}\n~~~`}</GitSpaceMarkdown>;
    case 'diff': return <GitSpaceMarkdown>{`~~~diff\n${block.patch}\n~~~`}</GitSpaceMarkdown>;
    case 'diagram': return <GitSpaceMarkdown>{`~~~mermaid\n${block.source}\n~~~`}</GitSpaceMarkdown>;
    case 'file-tree': return <div className="flex min-w-0 flex-col gap-0.5 font-mono text-caption text-muted-foreground [overflow-wrap:anywhere]">{block.paths.map((path) => <code key={path}>{path}</code>)}</div>;
    case 'image': return <TranscriptImage alt={block.alt ?? 'Tool output image'} label="Open tool output image" src={block.url} />;
    case 'artifact-ref': return <ResourceLink className="inline-flex min-w-0 max-w-full items-center gap-1 text-body text-foreground underline-offset-4 hover:underline" href={block.url}><Link03 className="shrink-0" width={14} height={14} strokeWidth={1.5} /><span className="min-w-0 [overflow-wrap:anywhere]">{block.label}</span></ResourceLink>;
    case 'table': return <div className="min-w-0 max-w-full overflow-x-auto [overflow-wrap:normal]" role="region" aria-label="Tool output table" tabIndex={0}><Table>
      <TableHeader><TableRow>{block.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{block.rows.map((row, index) => <TableRow key={index}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody>
    </Table></div>;
  }
}

function MessageAttachments({ images }: { images: MessageImage[] }) {
  return <>{images.map((image, index) => <TranscriptImage
    alt={`Attached image ${index + 1}`}
    key={`${image.mimeType}:${index}`}
    label={`Open attached image ${index + 1}`}
    src={`data:${image.mimeType};base64,${image.data}`}
  />)}</>;
}

// ThinkingStep drops `pending` rows, so every state maps to a visible icon.
const TOOL_ICON: Record<ToolCallBlock['status'], IconName> = { pending: 'circle', running: 'loader', done: 'check', error: 'x', interrupted: 'x' };
const browserExecutionDetails = z.object({ browser: RuntimeBrowserExecutionSchema });

function ToolArguments({ args }: { args: unknown }) {
  const serialized = JSON.stringify(args, null, 2);
  return <GitSpaceMarkdown>{`~~~json\n${serialized}\n~~~`}</GitSpaceMarkdown>;
}

/** One tool call is one reasoning-steps block: header names the tool, the step carries the target and status, details hold input and result. */
function ToolCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const hasArgs = !(block.input?.length) && block.args !== undefined;
  // Images (screenshots, generated pictures) show below the tool call, even while it is collapsed; its details keep everything else.
  const images = [...block.input ?? [], ...block.result ?? []].flatMap((content) => content.type === 'image' ? [content] : []);
  const input = block.input?.filter((content) => content.type !== 'image') ?? [];
  const result = block.result?.filter((content) => content.type !== 'image') ?? [];
  const hasDetail = hasArgs || input.length + result.length > 0;
  const failed = block.status === 'error';
  // Cloud agents call it web_browser (an OpenAI-reserved name otherwise); machine sessions keep browser.
  const chrome = block.tool === 'browser' || block.tool === 'web_browser' ? browserExecutionDetails.safeParse(block.details) : null;
  return <><ThinkingSteps className="w-full" defaultOpen={failed} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>{block.tool}{chrome?.success ? <span className="ml-2 text-caption font-normal" title={chrome.data.browser.pairingId}>· {chrome.data.browser.name}</span> : null}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      <ThinkingStep label={block.target ?? block.tool} description={failed ? 'failed' : block.status} status={block.status === 'running' ? 'active' : 'complete'} icon={TOOL_ICON[block.status]} isLast>
        {hasDetail ? <ThinkingSteps className="w-full" defaultOpen={failed} open={state?.detailsOpen} onOpenChange={(detailsOpen) => onStateChange?.({ detailsOpen })}>
          <ThinkingStepsHeader>Details</ThinkingStepsHeader>
          <ThinkingStepsContent>
          <div className="flex min-w-0 flex-col gap-2">
            {input.map((content) => <RichContent block={content} key={content.id} />)}
            {hasArgs ? <ToolArguments args={block.args} /> : null}
            {result.map((content) => <RichContent block={content} key={content.id} />)}
          </div>
          </ThinkingStepsContent>
        </ThinkingSteps> : null}
      </ThinkingStep>
    </ThinkingStepsContent>
  </ThinkingSteps>
  {images.length ? <div aria-label={`Images from ${block.tool}`} className="flex min-w-0 flex-wrap gap-2" role="group">{images.map((image) => <RichContent block={image} key={image.id} />)}</div> : null}
  </>;
}

function SideAgents({ agents, state, onStateChange }: { agents: SideAgentBlock[] } & ItemInteractionProps) {
  const running = agents.filter((agent) => agent.status === 'running' || agent.status === 'blocked').length;
  return <ThinkingSteps defaultOpen={running > 0} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>Subagents · {agents.length}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      {agents.map((agent, index) => <ThinkingStep
        key={agent.id}
        icon="users"
        label={agent.label}
        description={[agent.agent, agent.status].filter(Boolean).join(' · ')}
        status={agent.status === 'running' ? 'active' : 'complete'}
        isLast={index === agents.length - 1}
      >{agent.summary ? <p className="text-body text-muted-foreground">{agent.summary}</p> : null}</ThinkingStep>)}
    </ThinkingStepsContent>
  </ThinkingSteps>;
}

function Execution({ block, state, onStateChange, renderHistory }: { block: ExecutionBlock; renderHistory?: ExecutionHistoryRenderer } & ItemInteractionProps) {
  const shape = useShape();
  const [localOpen, setLocalOpen] = useState(block.hasFailures || block.status === 'blocked');
  const open = state?.executionOpen ?? localOpen;
  const kind = block.kind === 'agent' ? 'Agent' : block.kind === 'process' ? 'Process' : 'Background job';
  const color = block.status === 'failed' ? 'red' : block.status === 'blocked' || block.status === 'queued' ? 'amber' : block.status === 'cancelled' ? 'gray' : 'green';
  const Icon = block.kind === 'agent' ? Users01 : Terminal;
  const Chevron = open ? ChevronDown : ChevronRight;
  return <section className={`${shape.container} min-w-0 bg-surface-2 shadow-surface-1`} data-execution-id={block.executionId} data-execution-kind={block.kind}>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
      {renderHistory ? <button
        type="button"
        className="flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]"
        aria-expanded={open}
        aria-label={`${open ? 'Collapse' : 'Expand'} ${kind.toLowerCase()} history: ${block.label}`}
        onClick={() => { setLocalOpen(!open); onStateChange?.({ executionOpen: !open }); }}
      ><Chevron width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><Icon width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="min-w-0 text-body [overflow-wrap:anywhere]"><span className="mr-2 text-muted-foreground">{kind}</span>{block.label}</span></button>
        : <div className="flex min-h-10 min-w-0 flex-1 items-center gap-2"><Icon width={16} height={16} strokeWidth={1.5} className="shrink-0 text-muted-foreground" /><span className="min-w-0 text-body [overflow-wrap:anywhere]"><span className="mr-2 text-muted-foreground">{kind}</span>{block.label}</span></div>}
      <Badge variant="dot" color={color}>{block.status}</Badge>
      {block.hasFailures && block.status !== 'failed' ? <Badge variant="dot" color="red">Failure in history</Badge> : null}
    </div>
    <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 px-3 pb-3 text-caption text-muted-foreground">
      <span className="tabular-nums">{block.historyCount} {block.historyCount === 1 ? 'call' : 'calls'}</span>
      {block.agent ? <span>{block.agent}</span> : null}
      {block.model ? <span>{block.model}</span> : null}
      {block.durationMs !== undefined ? <span className="tabular-nums">{(block.durationMs / 1000).toFixed(1)}s</span> : null}
      {block.status === 'blocked' ? <span className="text-foreground">Waiting for input or a dependency</span> : null}
    </div>
    {block.summary ? <div className="min-w-0 px-3 pb-3 text-body text-muted-foreground [overflow-wrap:anywhere]"><GitSpaceMarkdown>{block.summary}</GitSpaceMarkdown></div> : null}
    {open && renderHistory ? renderHistory(block, state ?? {}, onStateChange) : null}
  </section>;
}

const PERMISSION_BADGE: Record<string, 'green' | 'red' | 'amber' | 'gray'> = { pending: 'amber', 'allowed-once': 'green', 'allowed-always': 'green', denied: 'red' };
const REPORT_OUTCOME: Record<WorkspaceReportBlock['outcome'], { label: string; color: keyof typeof badgeColors }> = {
  finished: { label: 'finished', color: 'blue' },
  failed: { label: 'failed', color: 'red' },
  asked: { label: 'asked', color: 'orange' },
  approval: { label: 'needs approval', color: 'orange' },
};

/** A turn a workspace ran for the project agent, in one line: the workspace (a link to it), how the turn came out, and
 * its reply, failure or question folded to one line until clicked. */
function WorkspaceReportRow({ item, state, onStateChange }: { item: WorkspaceReportBlock } & ItemInteractionProps) {
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

function Notice({ icon, title, detail, body, badge }: { icon: ReactNode; title: string; detail?: string; body?: string; badge?: ReactNode }) {
  const shape = useShape();
  return <div className={`${shape.container} flex min-w-0 items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block text-body text-foreground">{title}</span>{detail ? <span className="block whitespace-pre-line text-caption text-muted-foreground">{detail}</span> : null}
      {body ? <details className="mt-1 text-caption"><summary className="cursor-pointer text-muted-foreground">Show full message</summary><pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap break-words font-mono text-caption text-muted-foreground">{body}</pre></details> : null}</span>
    {badge}
  </div>;
}


export interface TurnTranscriptProps {
  turns: TurnBlock[];
  transport: TransportBlock[];
  /** Resolves the active ask tool dialog through the machine-owned UI bridge. */
  onAnswer?(answers: PendingAskAnswer[]): Promise<void>;
}

export interface TranscriptReadingPosition {
  generation: string | null;
  rowId: string;
  ordinal: number;
  offset: number;
  following: boolean;
}

export type ExecutionHistoryRenderer = (block: ExecutionBlock, state: TranscriptItemState, onStateChange: ItemInteractionProps['onStateChange']) => ReactNode;

/** Lightweight interaction state, owned above virtual rows so unmounting is harmless. */
export interface TranscriptItemState {
  open?: boolean;
  detailsOpen?: boolean;
  answers?: Record<string, AskUserAnswer>;
  questionIndex?: number;
  submitting?: boolean;
  error?: string | null;
  executionOpen?: boolean;
  /** Weak identity retains lightweight nested interactions across virtual remounts. */
  executionView?: object;
  executionPosition?: TranscriptReadingPosition;
}

interface ItemInteractionProps {
  state?: TranscriptItemState;
  onStateChange?(patch: Partial<TranscriptItemState>): void;
}

function ThinkingBlock({ active, text, state, onStateChange }: { active: boolean; text: string } & ItemInteractionProps) {
  return <ThinkingSteps className="w-full" defaultOpen={active} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })} key={active ? 'active' : 'complete'}>
    <ThinkingStepsHeader>{active ? <ThinkingIndicator className="p-0" showIcon={false} size="compact" /> : 'Thinking'}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      <div className="min-w-0 w-full text-foreground">
        <GitSpaceMarkdown streaming={active}>{text}</GitSpaceMarkdown>
      </div>
    </ThinkingStepsContent>
  </ThinkingSteps>;
}

function askAnswer(answer: AskBlock['questions'][number]['answer']): string {
  if (Array.isArray(answer)) return answer.length > 0 ? answer.join(', ') : 'Skipped';
  return answer?.trim() || 'Skipped';
}

export function AskBlockView({ item, onAnswer, state, onStateChange }: { item: AskBlock; onAnswer?: TurnTranscriptProps['onAnswer'] } & ItemInteractionProps) {
  const [local, setLocal] = useState<TranscriptItemState>({});
  const interaction = state ?? local;
  const { submitting = false, error = null } = interaction;
  const update = (patch: Partial<TranscriptItemState>): void => {
    if (onStateChange) onStateChange(patch);
    else setLocal((previous) => ({ ...previous, ...patch }));
  };
  if (item.status !== 'pending') {
    return <Notice
      icon={<ShieldTick width={16} height={16} strokeWidth={1.5} />}
      title={item.status === 'answered' ? 'Questions answered' : 'Questions dismissed'}
      detail={item.questions.map((question) => item.status === 'answered'
        ? `${question.prompt} — ${askAnswer(question.answer)}`
        : question.prompt).join('\n')}
    />;
  }
  const complete = (answers: Record<string, AskUserAnswer>): void => {
    if (!onAnswer || submitting) return;
    update({ submitting: true, error: null });
    void onAnswer(item.questions.map((question) => ({
      id: question.id,
      selectedOptions: answers[question.id]?.selectedIds ?? [],
      customInput: answers[question.id]?.otherText ?? null,
    }))).catch((failure) => {
      update({ submitting: false, error: rpcErrorMessage(failure, 'Answer agent questions') });
    });
  };
  return <div className={submitting ? 'pointer-events-none opacity-60' : undefined} aria-busy={submitting || undefined}>
    <AskUserQuestions
      questions={item.questions.map((question) => ({ id: question.id, title: question.prompt, options: (question.options ?? []).map((option) => ({ id: option.id, title: option.title, description: option.description ?? option.preview })), multiSelect: question.multiple, allowOther: true, freeText: !(question.options?.length), layout: question.options?.some((option) => option.description || option.preview) ? 'stacked' : 'inline' }))}
      defaultAnswers={Object.fromEntries(item.questions.flatMap((question) => question.answer === undefined ? [] : [[question.id, { questionId: question.id, selectedIds: Array.isArray(question.answer) ? question.answer : [question.answer] }]]))}
      answers={interaction.answers}
      onAnswersChange={(answers) => update({ answers })}
      currentIndex={interaction.questionIndex}
      onCurrentIndexChange={(questionIndex) => update({ questionIndex })}
      onComplete={onAnswer ? complete : undefined}
      renderTitle={(prompt) => <GitSpaceMarkdown>{prompt}</GitSpaceMarkdown>}
    />
    {error ? <p role="alert" className="mt-2 text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

/** A user message as Markdown: an uploaded attachment becomes a link to its drive file, an inline text attachment a
 * titled block of its text. */
export function userMessageMarkdown(text: string): string {
  return text
    .replace(/<attachment name="([^"]*)" url="([^"]*)"[^>]*\/>/gu, (_match, name: string, url: string) => `📎 [${name.replace(/[[\]]/gu, '\\$&')}](${url})`)
    .replace(/<attachment name="([^"]*)">\n([\s\S]*?)\n<\/attachment>/gu, (_match, name: string, content: string) => {
      const fence = '~'.repeat(Math.max(3, ...[...content.matchAll(/~{3,}/gu)].map(run => run[0].length + 1)));
      return `📎 **${name}**\n\n${fence}\n${content}\n${fence}`;
    });
}

/** An ask_takeover call shows as its card while the workspace has the card's question; otherwise (a refusal, another
 * surface) as the tool call it is. */
function AskTakeoverCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const cards = useContext(TakeoverCardsContext);
  const question = cards?.questions.find(item => item.kind === 'takeover' && item.takeover?.callId === block.toolCallId);
  return cards && question?.takeover ? <TakeoverCard question={question} card={question.takeover} cards={cards} /> : <ToolCall block={block} state={state} onStateChange={onStateChange} />;
}

export function TranscriptItemView({ item, active, onAnswer, state, onStateChange, renderExecutionHistory }: { item: TranscriptItem; active: boolean; onAnswer?: TurnTranscriptProps['onAnswer']; renderExecutionHistory?: ExecutionHistoryRenderer } & ItemInteractionProps) {
  switch (item.type) {
    case 'message': {
      // A sent message names the tabs its pasted share links connected; they show as chips above its text.
      const sent = item.role === 'user' ? connectedTabsIn(item.text) : null;
      return <ChatMessage
        attachments={item.images?.length ? <MessageAttachments images={item.images} /> : undefined}
        from={item.role}
        data-pending={item.pending || undefined}
      >{sent === null ? <GitSpaceMarkdown streaming={item.pending}>{item.text}</GitSpaceMarkdown> : <>
        {sent.tabs.length ? <span className="flex flex-wrap gap-1.5 pb-1.5">{sent.tabs.map((tab, index) => <TabChip key={`${tab.url}:${index}`} host={URL.canParse(tab.url) ? new URL(tab.url).host : tab.url} detail={tab.browser} />)}</span> : null}
        <GitSpaceMarkdown>{userMessageMarkdown(sent.text)}</GitSpaceMarkdown>
      </>}</ChatMessage>;
    }
    case 'thinking':
      return <ThinkingBlock active={active} text={item.text} state={state} onStateChange={onStateChange} />;
    case 'tool-call':
      return item.tool === 'ask_takeover' ? <AskTakeoverCall block={item} state={state} onStateChange={onStateChange} /> : <ToolCall block={item} state={state} onStateChange={onStateChange} />;
    case 'execution':
      return <Execution block={item} state={state} onStateChange={onStateChange} renderHistory={renderExecutionHistory} />;
    case 'ask':
      return <AskBlockView item={item} onAnswer={onAnswer} state={state} onStateChange={onStateChange} />;
    case 'permission':
      return <Notice icon={<ShieldTick width={16} height={16} strokeWidth={1.5} />} title={`Permission · ${item.tool}`} detail={item.detail} badge={<Badge variant="dot" color={PERMISSION_BADGE[item.status] ?? 'gray'}>{item.status}</Badge>} />;
    case 'todo':
      return <ThinkingSteps defaultOpen open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
        <ThinkingStepsHeader>{item.title ?? 'Plan'}</ThinkingStepsHeader>
        <ThinkingStepsContent>{item.items.map((todo, index) => <ThinkingStep key={index} label={todo.text} status={todo.state === 'active' ? 'active' : 'complete'} icon={todo.state === 'done' ? 'check' : todo.state === 'blocked' ? 'lock' : todo.state === 'active' ? 'loader' : 'circle'} isLast={index === item.items.length - 1} />)}</ThinkingStepsContent>
      </ThinkingSteps>;
    case 'interruption':
      return <Notice icon={<AlertCircle width={16} height={16} strokeWidth={1.5} />} title={item.title} detail={item.detail} body={item.body} badge={item.recovered ? <Badge variant="dot" color="green">recovered</Badge> : item.reason === 'machine' || item.reason === 'event' ? undefined : <Badge variant="dot" color="red">{item.reason}</Badge>} />;
    case 'workspace-report':
      return <WorkspaceReportRow item={item} state={state} onStateChange={onStateChange} />;
    case 'preview':
      return <Notice icon={<Link03 width={16} height={16} strokeWidth={1.5} />} title={item.label} detail={`${item.serviceName} · ${item.status}`} badge={item.route ? <Button variant="tertiary" size="compact" asChild><a href={item.route}>Open preview</a></Button> : undefined} />;
    case 'reference':
      return <Button variant="tertiary" size="compact" type="button" className="h-auto min-h-7 min-w-0 max-w-full self-start py-1 [&_span]:min-w-0 [&_svg]:shrink-0" leadingIcon={glyph(GitBranch01)}><span className="text-left [overflow-wrap:anywhere]">{item.label} <span className="text-caption text-muted-foreground">{item.kind}</span></span></Button>;
    case 'side-agent':
      return <SideAgents agents={[item]} state={state} onStateChange={onStateChange} />;
    default:
      return <RichContent block={item} />;
  }
}

export function TransportNotice({ block }: { block: TransportBlock }) {
  return <p className="flex min-w-0 flex-wrap items-center gap-2 text-caption text-muted-foreground [overflow-wrap:anywhere]">
    <span className="status-dot shrink-0 text-muted-foreground" data-pulse={block.status === 'reconnecting' || undefined} />
    <span className="text-foreground">{block.title}</span>
    {block.durationMs ? <span className="tabular-nums">{(block.durationMs / 1000).toFixed(1)}s</span> : null}
    {block.detail ? <span>{block.detail}</span> : null}
  </p>;
}

/** The transcript reads like the registry's chat demo: one column, messages stacked with gap-2, reasoning and tools inline between them. */
export function TurnTranscript({ turns, transport, onAnswer }: TurnTranscriptProps) {
  return <div className="mx-auto flex min-w-0 w-full max-w-3xl flex-col gap-6 px-6 pb-[calc(var(--composer-overlay-height,0px)+1.5rem)] pt-6">
    {transport.length ? <div className="flex min-w-0 flex-col gap-1">{transport.map((block) => <TransportNotice block={block} key={block.id} />)}</div> : null}
    {turns.map((turn) => <article className="flex min-w-0 flex-col gap-2" data-status={turn.status} key={turn.id}>
      {turn.user ? <TranscriptItemView item={turn.user} active={false} /> : null}
      {turn.items.filter((item) => item.type !== 'message' || item.role !== 'user').map((item) => <TranscriptItemView item={item} active={turn.status === 'running'} onAnswer={onAnswer} key={item.id} />)}
      {turn.sideAgents.length ? <SideAgents agents={turn.sideAgents} /> : null}
    </article>)}
  </div>;
}
