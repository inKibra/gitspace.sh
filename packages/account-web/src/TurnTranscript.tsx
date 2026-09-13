import type { AskBlock, ExecutionBlock, MessageImage, RichContentBlock, SideAgentBlock, ToolCallBlock, TranscriptItem, TransportBlock, TurnBlock } from '@gitspace/blocks';
import type { PendingAskAnswer } from '@gitspace/protocol';
import { AskUserQuestions, Badge, Button, ChatMessage, Dialog, DialogContent, DialogTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ThinkingIndicator, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useShape, type AskUserAnswer, type IconName } from '@gitspace/ui';
import { AlertCircle, ChevronDown, ChevronRight, GitBranch01, Link03, ShieldTick, Terminal, Users01 } from '@untitledui/icons';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { ResourceLink } from './ResourceNavigation.js';
import { glyph } from './glyph.js';
import { useState, type ReactNode } from 'react';

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

function TranscriptImage({ alt, label, src }: { alt: string; label: string; src: string }) {
  const [open, setOpen] = useState(false);
  const shape = useShape();
  return <>
    <button
      aria-label={label}
      className={`${shape.container} block w-fit max-w-full cursor-zoom-in overflow-hidden bg-surface-2 shadow-surface-1 outline-none transition-transform duration-80 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)]`}
      onClick={() => setOpen(true)}
      type="button"
    >
      <img
        alt={alt}
        className="block max-h-64 max-w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10"
        loading="lazy"
        src={src}
      />
    </button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] !max-w-[calc(100vw-2rem)] items-center justify-center overflow-hidden bg-surface-1 p-4" size="lg">
        <DialogTitle className="sr-only">{alt}</DialogTitle>
        <img
          alt={alt}
          className={`${shape.container} block max-h-[calc(100dvh-4rem)] max-w-full object-contain outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`}
          src={src}
        />
      </DialogContent>
    </Dialog>
  </>;
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

function ToolArguments({ args }: { args: unknown }) {
  const serialized = JSON.stringify(args, null, 2);
  return <GitSpaceMarkdown>{`~~~json\n${serialized}\n~~~`}</GitSpaceMarkdown>;
}

/** One tool call is one reasoning-steps block: header names the tool, the step carries the target and status, details hold input and result. */
function ToolCall({ block, state, onStateChange }: { block: ToolCallBlock } & ItemInteractionProps) {
  const hasArgs = !(block.input?.length) && block.args !== undefined;
  const hasDetail = hasArgs || (block.input?.length ?? 0) + (block.result?.length ?? 0) > 0;
  const hasImage = block.input?.some((content) => content.type === 'image') || block.result?.some((content) => content.type === 'image');
  const failed = block.status === 'error';
  return <ThinkingSteps className="w-full" defaultOpen={failed} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
    <ThinkingStepsHeader>{block.tool}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      <ThinkingStep label={block.target ?? block.tool} description={failed ? 'failed' : block.status} status={block.status === 'running' ? 'active' : 'complete'} icon={TOOL_ICON[block.status]} isLast>
        {hasDetail ? <ThinkingSteps className="w-full" key={hasImage ? 'image' : 'detail'} defaultOpen={failed || hasImage} open={state?.detailsOpen} onOpenChange={(detailsOpen) => onStateChange?.({ detailsOpen })}>
          <ThinkingStepsHeader>Details</ThinkingStepsHeader>
          <ThinkingStepsContent>
          <div className="flex min-w-0 flex-col gap-2">
            {block.input?.map((content) => <RichContent block={content} key={content.id} />)}
            {hasArgs ? <ToolArguments args={block.args} /> : null}
            {block.result?.map((content) => <RichContent block={content} key={content.id} />)}
          </div>
          </ThinkingStepsContent>
        </ThinkingSteps> : null}
      </ThinkingStep>
    </ThinkingStepsContent>
  </ThinkingSteps>;
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

function Notice({ icon, title, detail, badge }: { icon: ReactNode; title: string; detail?: string; badge?: ReactNode }) {
  const shape = useShape();
  return <div className={`${shape.container} flex min-w-0 items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1 [overflow-wrap:anywhere]"><span className="block text-body text-foreground">{title}</span>{detail ? <span className="block whitespace-pre-line text-caption text-muted-foreground">{detail}</span> : null}</span>
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

function AskBlockView({ item, onAnswer, state, onStateChange }: { item: AskBlock; onAnswer?: TurnTranscriptProps['onAnswer'] } & ItemInteractionProps) {
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
      update({ submitting: false, error: failure instanceof Error ? failure.message : String(failure) });
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
    />
    {error ? <p role="alert" className="mt-2 text-caption text-destructive [overflow-wrap:anywhere]">{error}</p> : null}
  </div>;
}

export function TranscriptItemView({ item, active, onAnswer, state, onStateChange, renderExecutionHistory }: { item: TranscriptItem; active: boolean; onAnswer?: TurnTranscriptProps['onAnswer']; renderExecutionHistory?: ExecutionHistoryRenderer } & ItemInteractionProps) {
  switch (item.type) {
    case 'message':
      return <ChatMessage
        attachments={item.images?.length ? <MessageAttachments images={item.images} /> : undefined}
        from={item.role}
        data-pending={item.pending || undefined}
      >{item.role === 'assistant' ? <GitSpaceMarkdown streaming={item.pending}>{item.text}</GitSpaceMarkdown> : item.text}</ChatMessage>;
    case 'thinking':
      return <ThinkingBlock active={active} text={item.text} state={state} onStateChange={onStateChange} />;
    case 'tool-call':
      return <ToolCall block={item} state={state} onStateChange={onStateChange} />;
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
      return <Notice icon={<AlertCircle width={16} height={16} strokeWidth={1.5} />} title={item.title} detail={item.detail} badge={item.recovered ? <Badge variant="dot" color="green">recovered</Badge> : <Badge variant="dot" color="red">{item.reason}</Badge>} />;
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
