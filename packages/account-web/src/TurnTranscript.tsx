import type { AskBlock, MessageImage, RichContentBlock, SideAgentBlock, ToolCallBlock, TransportBlock, TurnBlock, TurnItem } from '@gitspace/blocks';
import type { PendingAskAnswer } from '@gitspace/protocol';
import { AskUserQuestions, Badge, Button, ChatMessage, Dialog, DialogContent, DialogTitle, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, ThinkingIndicator, ThinkingStep, ThinkingStepDetails, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useShape, type AskUserAnswer, type IconName } from '@gitspace/ui';
import { AlertCircle, GitBranch01, Link03, ShieldTick } from '@untitledui/icons';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { glyph } from './glyph.js';
import { useState, type ReactNode } from 'react';

function RichContent({ block }: { block: RichContentBlock }) {
  switch (block.type) {
    case 'markdown': return <GitSpaceMarkdown>{block.text}</GitSpaceMarkdown>;
    case 'code': return <GitSpaceMarkdown>{`~~~${block.language ?? ''}\n${block.text}\n~~~`}</GitSpaceMarkdown>;
    case 'diff': return <GitSpaceMarkdown>{`~~~diff\n${block.patch}\n~~~`}</GitSpaceMarkdown>;
    case 'diagram': return <GitSpaceMarkdown>{`~~~mermaid\n${block.source}\n~~~`}</GitSpaceMarkdown>;
    case 'file-tree': return <div className="flex flex-col gap-0.5 font-mono text-caption text-muted-foreground">{block.paths.map((path) => <code key={path}>{path}</code>)}</div>;
    case 'image': return <TranscriptImage alt={block.alt ?? 'Tool output image'} label="Open tool output image" src={block.url} />;
    case 'artifact-ref': return <a className="inline-flex items-center gap-1 text-body text-foreground underline-offset-4 hover:underline" href={block.url}><Link03 width={14} height={14} strokeWidth={1.5} />{block.label}</a>;
    case 'table': return <Table>
      <TableHeader><TableRow>{block.columns.map((column) => <TableHead key={column}>{column}</TableHead>)}</TableRow></TableHeader>
      <TableBody>{block.rows.map((row, index) => <TableRow key={index}>{row.map((cell, cellIndex) => <TableCell key={cellIndex}>{cell}</TableCell>)}</TableRow>)}</TableBody>
    </Table>;
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

/** One tool call is one reasoning-steps block: header names the tool, the step carries the target and status, details hold input and result. */
function ToolCall({ block }: { block: ToolCallBlock }) {
  const hasDetail = (block.input?.length ?? 0) + (block.result?.length ?? 0) > 0;
  const hasImage = [...(block.input ?? []), ...(block.result ?? [])].some((content) => content.type === 'image');
  const failed = block.status === 'error';
  return <ThinkingSteps className="w-full" defaultOpen={failed}>
    <ThinkingStepsHeader>{block.tool}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      <ThinkingStep label={block.target ?? block.tool} description={failed ? 'failed' : block.status} status={block.status === 'running' ? 'active' : 'complete'} icon={TOOL_ICON[block.status]} isLast>
        {hasDetail ? <ThinkingStepDetails key={hasImage ? 'image' : 'detail'} summary="Details" defaultOpen={failed || hasImage}>
          <div className="flex min-w-0 flex-col gap-2">
            {block.input?.map((content) => <RichContent block={content} key={content.id} />)}
            {block.result?.map((content) => <RichContent block={content} key={content.id} />)}
          </div>
        </ThinkingStepDetails> : null}
      </ThinkingStep>
    </ThinkingStepsContent>
  </ThinkingSteps>;
}

function SideAgents({ agents }: { agents: SideAgentBlock[] }) {
  const running = agents.filter((agent) => agent.status === 'running' || agent.status === 'blocked').length;
  return <ThinkingSteps defaultOpen={running > 0}>
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

const PERMISSION_BADGE: Record<string, 'green' | 'red' | 'amber' | 'gray'> = { pending: 'amber', 'allowed-once': 'green', 'allowed-always': 'green', denied: 'red' };

function Notice({ icon, title, detail, badge }: { icon: ReactNode; title: string; detail?: string; badge?: ReactNode }) {
  const shape = useShape();
  return <div className={`${shape.container} flex items-start gap-3 bg-surface-3 px-3 py-2.5 shadow-surface-1`}>
    <span className="mt-0.5 shrink-0 text-muted-foreground">{icon}</span>
    <span className="min-w-0 flex-1"><span className="block text-body text-foreground">{title}</span>{detail ? <span className="block whitespace-pre-line text-caption text-muted-foreground">{detail}</span> : null}</span>
    {badge}
  </div>;
}


export interface TurnTranscriptProps {
  turns: TurnBlock[];
  transport: TransportBlock[];
  /** Resolves the active ask tool dialog through the machine-owned UI bridge. */
  onAnswer?(answers: PendingAskAnswer[]): Promise<void>;
}

function ThinkingBlock({ active, text }: { active: boolean; text: string }) {
  return <ThinkingSteps className="w-full" defaultOpen={active} key={active ? 'active' : 'complete'}>
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

function AskBlockView({ item, onAnswer }: { item: AskBlock; onAnswer?: TurnTranscriptProps['onAnswer'] }) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
    setSubmitting(true);
    setError(null);
    void onAnswer(item.questions.map((question) => ({
      id: question.id,
      selectedOptions: answers[question.id]?.selectedIds ?? [],
      customInput: answers[question.id]?.otherText ?? null,
    }))).catch((failure) => {
      setSubmitting(false);
      setError(failure instanceof Error ? failure.message : String(failure));
    });
  };
  return <div className={submitting ? 'pointer-events-none opacity-60' : undefined} aria-busy={submitting || undefined}>
    <AskUserQuestions
      questions={item.questions.map((question) => ({ id: question.id, title: question.prompt, options: (question.options ?? []).map((option) => ({ id: option.id, title: option.title, description: option.description ?? option.preview })), multiSelect: question.multiple, allowOther: true, freeText: !(question.options?.length), layout: question.options?.some((option) => option.description || option.preview) ? 'stacked' : 'inline' }))}
      defaultAnswers={Object.fromEntries(item.questions.flatMap((question) => question.answer === undefined ? [] : [[question.id, { questionId: question.id, selectedIds: Array.isArray(question.answer) ? question.answer : [question.answer] }]]))}
      onComplete={onAnswer ? complete : undefined}
    />
    {error ? <p role="alert" className="mt-2 text-caption text-destructive">{error}</p> : null}
  </div>;
}

function TurnItemView({ item, active, onAnswer }: { item: TurnItem; active: boolean; onAnswer?: TurnTranscriptProps['onAnswer'] }) {
  switch (item.type) {
    case 'message':
      return <ChatMessage
        attachments={item.images?.length ? <MessageAttachments images={item.images} /> : undefined}
        from={item.role}
        data-pending={item.pending || undefined}
      >{item.role === 'assistant' ? <GitSpaceMarkdown streaming={item.pending}>{item.text}</GitSpaceMarkdown> : item.text}</ChatMessage>;
    case 'thinking':
      return <ThinkingBlock active={active} text={item.text} />;
    case 'tool-call':
      return <ToolCall block={item} />;
    case 'ask':
      return <AskBlockView item={item} onAnswer={onAnswer} />;
    case 'permission':
      return <Notice icon={<ShieldTick width={16} height={16} strokeWidth={1.5} />} title={`Permission · ${item.tool}`} detail={item.detail} badge={<Badge variant="dot" color={PERMISSION_BADGE[item.status] ?? 'gray'}>{item.status}</Badge>} />;
    case 'todo':
      return <ThinkingSteps defaultOpen>
        <ThinkingStepsHeader>{item.title ?? 'Plan'}</ThinkingStepsHeader>
        <ThinkingStepsContent>{item.items.map((todo, index) => <ThinkingStep key={index} label={todo.text} status={todo.state === 'active' ? 'active' : 'complete'} icon={todo.state === 'done' ? 'check' : todo.state === 'blocked' ? 'lock' : todo.state === 'active' ? 'loader' : 'circle'} isLast={index === item.items.length - 1} />)}</ThinkingStepsContent>
      </ThinkingSteps>;
    case 'interruption':
      return <Notice icon={<AlertCircle width={16} height={16} strokeWidth={1.5} />} title={item.title} detail={item.detail} badge={item.recovered ? <Badge variant="dot" color="green">recovered</Badge> : <Badge variant="dot" color="red">{item.reason}</Badge>} />;
    case 'preview':
      return <Notice icon={<Link03 width={16} height={16} strokeWidth={1.5} />} title={item.label} detail={`${item.serviceName} · ${item.status}`} badge={item.route ? <Button variant="tertiary" size="compact" asChild><a href={item.route}>Open preview</a></Button> : undefined} />;
    case 'reference':
      return <Button variant="tertiary" size="compact" type="button" className="self-start" leadingIcon={glyph(GitBranch01)}>{item.label}<span className="text-caption text-muted-foreground">{item.kind}</span></Button>;
    default:
      return <RichContent block={item} />;
  }
}

function TransportNotice({ block }: { block: TransportBlock }) {
  return <p className="flex items-center gap-2 text-caption text-muted-foreground">
    <span className="status-dot text-muted-foreground" data-pulse={block.status === 'reconnecting' || undefined} />
    <span className="text-foreground">{block.title}</span>
    {block.durationMs ? <span className="tabular-nums">{(block.durationMs / 1000).toFixed(1)}s</span> : null}
    {block.detail ? <span>{block.detail}</span> : null}
  </p>;
}

/** The transcript reads like the registry's chat demo: one column, messages stacked with gap-2, reasoning and tools inline between them. */
export function TurnTranscript({ turns, transport, onAnswer }: TurnTranscriptProps) {
  return <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-6 pb-40 pt-6">
    {transport.length ? <div className="flex flex-col gap-1">{transport.map((block) => <TransportNotice block={block} key={block.id} />)}</div> : null}
    {turns.map((turn) => <article className="flex flex-col gap-2" data-status={turn.status} key={turn.id}>
      {turn.user ? <TurnItemView item={turn.user} active={false} /> : null}
      {turn.items.filter((item) => item.type !== 'message' || item.role !== 'user').map((item) => <TurnItemView item={item} active={turn.status === 'running'} onAnswer={onAnswer} key={item.id} />)}
      {turn.sideAgents.length ? <SideAgents agents={turn.sideAgents} /> : null}
    </article>)}
  </div>;
}
