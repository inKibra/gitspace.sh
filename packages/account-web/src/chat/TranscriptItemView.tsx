import type { ExecutionBlock, TranscriptItem } from '@gitspace/blocks';
import { parseAutomationMessage } from '@gitspace/protocol/automations-contract';
import { captureMention, captureSummariesIn } from '@gitspace/protocol-runtime';
import { Badge, Button, ChatMessage, ThinkingIndicator, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, type AskUserAnswer } from '@gitspace/ui';
import { AlertCircle, GitBranch01, Link03, ShieldTick } from '@untitledui/icons';
import type { ReactNode } from 'react';
import { connectedTabsIn, TabChip } from '../connected-tab.js';
import { CaptureChip } from '../capture-chip.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { glyph } from '../glyph.js';
import { AskBlockView, AskTakeoverCall, EnvironmentCall } from './AskCards.js';
import { AutomationCard, EventCard, Notice, NoticeRow, PERMISSION_BADGE, WorkspaceReportRow } from './EventCards.js';
import { Execution, SideAgents } from './ExecutionCard.js';
import { MessageAttachments, RichContent, userMessageMarkdown } from './RichContent.js';
import { ToolCall } from './ToolCall.js';
import { ToolGroup } from './ToolGroup.js';
import { AgentMessageActions } from './staging.js';
import type { TurnTranscriptProps } from './TurnTranscript.js';

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
  /** The id of the call whose detail an open tool group shows. */
  selectedCall?: string | null;
}

export interface ItemInteractionProps {
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

/** The agent's todo list as a `todo` call set it, labelled with whether it follows the approved plan or is the agent's own list. */
function TodoRow({ item, state, onStateChange }: { item: Extract<TranscriptItem, { type: 'todo' }> } & ItemInteractionProps) {
  const done = item.items.filter((todo) => todo.state === 'done').length;
  return <div className="flex min-w-0 flex-col gap-1" data-todo-source={item.source ?? 'own'}>
    <ThinkingSteps defaultOpen={!item.error} open={state?.open} onOpenChange={(open) => onStateChange?.({ open })}>
      <ThinkingStepsHeader>{item.title ?? 'Todo'}{item.items.length ? <span className="ml-1.5 font-normal tabular-nums text-muted-foreground">{done}/{item.items.length}</span> : null}<Badge className="ml-2" variant="dot" size="compact" color={item.source === 'plan' ? 'blue' : 'gray'}>{item.source === 'plan' ? 'from the plan' : 'own list'}</Badge></ThinkingStepsHeader>
      <ThinkingStepsContent>{item.items.map((todo, index) => <ThinkingStep key={index} label={todo.text} status={todo.state === 'active' ? 'active' : 'complete'} icon={todo.state === 'done' ? 'check' : todo.state === 'blocked' ? 'lock' : todo.state === 'active' ? 'loader' : 'circle'} isLast={index === item.items.length - 1} />)}</ThinkingStepsContent>
    </ThinkingSteps>
    {item.error ? <p role="status" className="text-caption text-destructive [overflow-wrap:anywhere]">The list did not change: {item.error}</p> : null}
  </div>;
}

export function TranscriptItemView({ item, active, onAnswer, state, onStateChange, renderExecutionHistory }: { item: TranscriptItem; active: boolean; onAnswer?: TurnTranscriptProps['onAnswer']; renderExecutionHistory?: ExecutionHistoryRenderer } & ItemInteractionProps) {
  switch (item.type) {
    case 'message': {
      const automation = item.role === 'user' ? parseAutomationMessage(item.text) : null;
      if (automation) return <AutomationCard message={automation} delivery="turn" />;
      // A sent message names the tabs its pasted share links connected and the captures it mentions (the summaries the
      // workspace appended for the agent); they show as chips above its text.
      const mentioned = item.role === 'user' ? captureSummariesIn(item.text) : null;
      const sent = mentioned === null ? null : connectedTabsIn(mentioned.captures.reduce((text, { captureId }) => text.replaceAll(captureMention(captureId), ''), mentioned.text));
      return <ChatMessage
        attachments={item.images?.length ? <MessageAttachments images={item.images} /> : undefined}
        from={item.role}
        data-pending={item.pending || undefined}
      >{sent === null || mentioned === null ? <AgentMessageActions><GitSpaceMarkdown streaming={item.pending}>{item.text}</GitSpaceMarkdown></AgentMessageActions> : <>
        {sent.tabs.length || mentioned.captures.length ? <span className="flex flex-wrap gap-1.5 pb-1.5">
          {sent.tabs.map((tab, index) => <TabChip key={`${tab.url}:${index}`} host={URL.canParse(tab.url) ? new URL(tab.url).host : tab.url} detail={tab.browser} />)}
          {mentioned.captures.map(capture => <CaptureChip key={capture.captureId} name={capture.name ?? 'Capture not found'} detail={capture.name ? 'Capture' : null} />)}
        </span> : null}
        <GitSpaceMarkdown>{userMessageMarkdown(sent.text)}</GitSpaceMarkdown>
      </>}</ChatMessage>;
    }
    case 'thinking':
      return <ThinkingBlock active={active} text={item.text} state={state} onStateChange={onStateChange} />;
    case 'tool-call':
      // A custom message the runtime recorded as a call keeps its own block; any other single call is a group of one.
      return item.id.includes(':custom:') ? <ToolCall block={item} state={state} onStateChange={onStateChange} />
        : item.tool === 'ask_takeover' ? <AskTakeoverCall block={item} state={state} onStateChange={onStateChange} />
        : item.tool === 'environment' ? <EnvironmentCall block={item} state={state} onStateChange={onStateChange} />
        : <ToolGroup calls={[{ block: item, complete: true }]} state={state} onStateChange={onStateChange} />;
    case 'execution':
      return <Execution block={item} state={state} onStateChange={onStateChange} renderHistory={renderExecutionHistory} />;
    case 'ask':
      return <AskBlockView item={item} onAnswer={onAnswer} state={state} onStateChange={onStateChange} />;
    case 'permission':
      return <Notice icon={<ShieldTick width={16} height={16} strokeWidth={1.5} />} title={`Permission · ${item.tool}`} detail={item.detail} badge={<Badge variant="dot" color={PERMISSION_BADGE[item.status] ?? 'gray'}>{item.status}</Badge>} />;
    case 'todo':
      return <TodoRow item={item} state={state} onStateChange={onStateChange} />;
    case 'interruption': {
      if (item.reason === 'machine') {
        const automation = item.title === 'GitHub' ? parseAutomationMessage(item.detail ?? '') : null;
        return automation ? <AutomationCard message={automation} delivery="notice" /> : <NoticeRow item={item} />;
      }
      if (item.reason === 'event') return item.kind === 'machine-ready' ? <NoticeRow item={item} /> : <EventCard item={item} />;
      return <Notice icon={<AlertCircle width={16} height={16} strokeWidth={1.5} />} title={item.title} detail={item.detail} body={item.body} badge={item.recovered ? <Badge variant="dot" color="green">recovered</Badge> : <Badge variant="dot" color="red">{item.reason}</Badge>} />;
    }
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
