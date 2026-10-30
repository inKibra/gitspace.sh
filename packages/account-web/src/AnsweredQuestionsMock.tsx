// Throwaway design mock, in a workspace's chat as the app renders it (TranscriptItemView, the question card, the
// Composer): a plan approval that takes a note (approve with additions, reject with a reason), and questions that stay
// in the conversation once answered, locked, showing what was asked and what you answered. "Today" shows the current
// behavior for comparison. Static data only; not part of the app.
import type { AskBlock, TranscriptItem } from '@gitspace/blocks';
import type { PendingAskAnswer } from '@gitspace/protocol';
import {
  AskUserQuestions, Badge, Button, DropdownContent, DropdownMenu, DropdownTrigger, IconProvider, MenuItem, ShapeProvider, Sidebar, SidebarContent, SidebarFooter,
  SidebarGroup, SidebarGroupLabel, SidebarHeader, SidebarInset, SidebarInsetTopbar, SidebarMenu, SidebarMenuButton, SidebarMenuItem,
  SidebarMenuSub, SidebarMenuSubButton, SidebarMenuSubItem, SidebarProvider, SidebarUserFooter, SidebarWorkspaceHeader, SizeProvider,
  TooltipProvider, untitledIcons, useShape, WorkspaceTile, type IconComponent,
} from '@gitspace/ui';
import { Activity, Check, Columns03, FolderClosed, GitBranch01, Key01, Lock01, PuzzlePiece01, Stars01, Zap } from '@untitledui/icons';
import { Fragment, StrictMode, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import '@gitspace/ui/fluid-theme.css';
import './styles.css';
import { Composer } from './Composer.js';
import { glyph } from './glyph.js';
import { StatusDot } from './GitSpaceShell.js';
import { AskBlockView, TranscriptItemView } from './TurnTranscript.js';
import { GitSpaceMarkdown } from './GitSpaceMarkdown.js';
import { restoreAppearance } from './appearance.js';
import { verticalSliceFixture } from './App.js';

type Mode = 'proposed' | 'today';

const message = (id: string, role: 'user' | 'assistant', text: string): TranscriptItem => ({ id, type: 'message', role, text });

/** A question as the agent asked it, and what you answered (an option id, or your own words). */
interface Asked { id: string; prompt: string; options: readonly { id: string; title: string; description?: string }[]; optional?: boolean }
type Answers = Record<string, { selected: readonly string[]; own: string | null }>;

/** The plan as `propose_plan` sends it: the question's text is the plan, in Markdown. */
const PLAN_TEXT = `## Challenge streaks

Players keep a streak per challenge: one mark per day they complete a session in it, broken by a missed day.

### Changes
1. **Store** — a \`streaks\` table keyed by user and challenge: current length, longest, last marked day (UTC).
2. **Trainer scan** — when a session completes, mark the day for each challenge it counts toward; a second session the same day changes nothing.
3. **Backfill** — mark the last 30 days from completed sessions, once, behind a migration.
4. **UI** — a streak badge on the challenge card (🔥 7), and the longest streak on the challenge page.

### Tests
- A session on consecutive days extends the streak; a missed day resets it to 1.
- Two sessions on one day mark it once.
- The backfill is idempotent.

### Out of scope
- Streak freezes and reminders.
- Streaks across challenges.`;

const PLAN: readonly Asked[] = [
  { id: 'decision', prompt: PLAN_TEXT, options: [
    { id: 'approve', title: 'Approve', description: 'The agent implements the plan with full tools.' },
    { id: 'reject', title: 'Reject', description: 'The workspace stays in Plan; the agent revises it.' },
  ] },
  { id: 'note', prompt: 'Anything to add?', options: [], optional: true },
];
const IOS: readonly Asked[] = [
  { id: 'machine', prompt: 'Which machine should build the iOS app?', options: [
    { id: 'mac', title: 'MacBook-Pro-2.local', description: 'darwin-arm64 · online' },
    { id: 'darktop', title: 'Darktop', description: 'linux-x64 · cannot run Xcode' },
  ] },
  { id: 'tests', prompt: 'Run the full test suite or only the changed targets?', options: [{ id: 'full', title: 'Full suite' }, { id: 'changed', title: 'Changed targets' }] },
];

function askBlock(id: string, questions: readonly Asked[], answers?: Answers): AskBlock {
  return {
    id, type: 'ask', toolCallId: `${id}-call`, status: answers ? 'answered' : 'pending',
    questions: questions.map(question => {
      const answer = answers?.[question.id];
      const titles = answer ? [...question.options.filter(option => answer.selected.includes(option.id)).map(option => option.title), ...answer.own ? [answer.own] : []] : [];
      return { id: question.id, prompt: question.prompt, options: question.options.map(option => ({ ...option })), ...(answer ? { answer: titles.length === 1 ? titles[0] ?? '' : titles } : {}) };
    }),
  };
}

/** What you answered, as the card keeps it, and when. */
function recorded(answers: PendingAskAnswer[]): { answers: Answers; at: string } {
  return {
    answers: Object.fromEntries(answers.map(answer => [answer.id, { selected: [...answer.selectedOptions], own: answer.customInput?.trim() || null }])),
    at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

/**
 * An answered question card: the question component's own card, header and rows, read only. Every question stays; what
 * you picked is marked and the rest dimmed; your own words fill the free-text row.
 */
function AnsweredCard({ title, questions, answers, at, outcome }: { title: string; questions: readonly Asked[]; answers: Answers; at: string; outcome?: { label: string; tone: 'green' | 'red' } }): ReactElement {
  const shape = useShape();
  return <div aria-label={`${title}, answered`} className={`relative w-full max-w-[520px] overflow-hidden border border-border bg-card ${shape.container}`}>
    <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-3.5 text-[12px] text-muted-foreground sm:px-5 sm:pt-4">
      <span className="inline-flex items-center gap-1.5"><Lock01 width={12} height={12} strokeWidth={1.5} />{title} · answered</span>
      {outcome ? <Badge variant="dot" size="compact" color={outcome.tone}>{outcome.label}</Badge> : null}
    </div>
    <div className="flex flex-col gap-4 px-4 pb-2.5 sm:px-5 sm:pb-3">
      {questions.map((question, index) => {
        const answer = answers[question.id] ?? { selected: [], own: null };
        if (question.optional && !answer.own && !answer.selected.length) return null;
        return <div key={question.id} className="flex flex-col gap-2">
          {questions.length > 1 ? <span className="text-[12px] text-muted-foreground">Question {index + 1} of {questions.length}</span> : null}
          <div className="max-h-64 w-full overflow-y-auto text-[14px] leading-relaxed text-foreground"><GitSpaceMarkdown>{question.prompt}</GitSpaceMarkdown></div>
          <div className="-mx-3 flex flex-col">
            {question.options.map((option, optionIndex) => {
              const chosen = answer.selected.includes(option.id);
              return <div key={option.id} className={`flex min-h-10 items-center gap-3 py-1.5 pl-3 pr-1.5 ${shape.item} ${chosen ? 'bg-card ring-1 ring-inset ring-border' : ''}`}>
                <span className={`flex min-w-0 flex-1 flex-col gap-0.5 leading-snug ${option.description ? '' : 'justify-center'}`}>
                  <span className={`text-[14px] ${chosen ? 'text-foreground' : 'text-muted-foreground line-through decoration-border'}`}>{option.title}</span>
                  {option.description ? <span className="text-[12px] text-muted-foreground">{option.description}</span> : null}
                </span>
                <span className="inline-flex size-7 shrink-0 items-center justify-center">
                  {chosen ? <span className={`inline-flex size-5 items-center justify-center bg-foreground text-background ${shape.bg}`}><Check width={12} height={12} strokeWidth={2} /></span>
                    : <span className="text-[11px] text-muted-foreground">{optionIndex + 1}</span>}
                </span>
              </div>;
            })}
            {answer.own ? <div className={`flex min-h-10 items-center gap-3 bg-active py-1.5 pl-3 pr-1.5 ${shape.item}`}>
              <span className="min-w-0 flex-1 whitespace-pre-wrap text-[14px] leading-snug text-foreground">{answer.own}</span>
              <span className="inline-flex size-7 shrink-0 items-center justify-center"><span className={`inline-flex size-5 items-center justify-center bg-foreground text-background ${shape.bg}`}><Check width={12} height={12} strokeWidth={2} /></span></span>
            </div> : null}
          </div>
        </div>;
      })}
    </div>
    <div className="border-t border-border px-4 py-2 text-[12px] text-muted-foreground sm:px-5">You answered · {at}</div>
  </div>;
}

function MockSidebar(): ReactElement {
  const nav: readonly { label: string; icon: IconComponent }[] = [
    { label: 'Kanban', icon: glyph(Columns03) }, { label: 'Projects', icon: glyph(FolderClosed) }, { label: 'Inference', icon: glyph(Stars01) },
    { label: 'Plugins', icon: glyph(PuzzlePiece01) }, { label: 'Automations', icon: glyph(Zap) }, { label: 'Secrets & values', icon: glyph(Key01) }, { label: 'Monitoring', icon: glyph(Activity) },
  ];
  const dot = (color: 'blue' | 'orange' | 'green'): IconComponent => function Dot() { return <StatusDot color={color} />; };
  return <Sidebar variant="inset">
    <SidebarHeader><SidebarWorkspaceHeader name="GitSpace" tile={<WorkspaceTile>G</WorkspaceTile>} /></SidebarHeader>
    <SidebarContent>
      <SidebarGroup collapsible><SidebarGroupLabel>Navigate</SidebarGroupLabel>
        <SidebarMenu>{nav.map(item => <SidebarMenuItem key={item.label}><SidebarMenuButton icon={item.icon}>{item.label}</SidebarMenuButton></SidebarMenuItem>)}</SidebarMenu>
      </SidebarGroup>
      <SidebarGroup collapsible><SidebarGroupLabel>Projects</SidebarGroupLabel>
        <SidebarMenu>
          <SidebarMenuItem><SidebarMenuButton icon={dot('blue')}>GitSpace</SidebarMenuButton></SidebarMenuItem>
          <SidebarMenuItem>
            <SidebarMenuButton icon={dot('blue')}>inkibra core</SidebarMenuButton>
            <SidebarMenuSub open>
              {['DJMC · Jev arc policies', 'ToneTempo · Challenges and streaks', 'automatic-music-updates', 'inkibra-site-posthog-brief'].map(name => <SidebarMenuSubItem key={name}>
                <SidebarMenuSubButton render={<button type="button" />} icon={dot(name.startsWith('ToneTempo') ? 'orange' : 'blue')} isActive={name.startsWith('ToneTempo')}>{name}</SidebarMenuSubButton>
              </SidebarMenuSubItem>)}
            </SidebarMenuSub>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarGroup>
    </SidebarContent>
    <SidebarFooter><SidebarUserFooter name="Bradley Leatherwood" avatar={<span className="flex size-5 items-center justify-center rounded-full bg-muted-foreground text-[10px] font-semibold text-background">B</span>} menu={<MenuItem index={0} label="Settings" onSelect={() => undefined} />} /></SidebarFooter>
  </Sidebar>;
}

function AnsweredQuestionsMock(): ReactElement {
  const shape = useShape();
  const [mode, setMode] = useState<Mode>('proposed');
  const [plan, setPlan] = useState<{ answers: Answers; at: string } | null>(null);
  const [ios, setIos] = useState<{ answers: Answers; at: string } | null>(null);
  const reset = () => { setPlan(null); setIos(null); };
  const approved = plan?.answers.decision?.selected.includes('approve') ?? false;
  const note = plan?.answers.note?.own ?? null;

  // Today: the plan card floats above the composer (Approve / Reject plus an Other field it refuses) and leaves no trace.
  const todayPlan: AskBlock = { id: 'today-plan', type: 'ask', toolCallId: 'today-plan', status: 'pending', questions: [{ id: 'today-plan', prompt: PLAN[0]!.prompt, header: 'Approval required', options: [{ id: 'Approve', title: 'Approve' }, { id: 'Reject', title: 'Reject' }] }] };

  const rows: { key: string; gap: number; node: ReactElement }[] = [];
  const item = (key: string, value: TranscriptItem, gap = 8) => rows.push({ key, gap, node: <TranscriptItemView item={value} active={false} /> });
  item('u1', message('u1', 'user', 'Plan the challenge streaks for ToneTempo.'));
  item('a1', message('a1', 'assistant', 'Here is the plan. Approve it and I will move this workspace to Code.'), 24);
  if (mode === 'proposed') {
    rows.push({ key: 'plan', gap: 8, node: plan
      ? <AnsweredCard title="Plan approval" questions={PLAN} answers={plan.answers} at={plan.at} outcome={approved ? { label: 'Approved · moved to Code', tone: 'green' } : { label: 'Rejected · still in Plan', tone: 'red' }} />
      : <AskUserQuestions
          questions={[
            { id: 'decision', title: PLAN[0]!.prompt, options: PLAN[0]!.options.map(option => ({ ...option })), allowOther: false, layout: 'stacked' },
            { id: 'note', title: PLAN[1]!.prompt, freeText: true, skippable: true, freeTextPlaceholder: 'Optional: add to the plan, or say why you reject it' },
          ]}
          onComplete={answers => setPlan({
            answers: Object.fromEntries(Object.values(answers).map(answer => [answer.questionId, { selected: answer.selectedIds, own: answer.otherText?.trim() || null }])),
            at: new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
          })}
          renderTitle={prompt => <div className="max-h-80 overflow-y-auto pr-1"><GitSpaceMarkdown>{prompt}</GitSpaceMarkdown></div>} /> });
    if (plan) item('a2', message('a2', 'assistant', approved
      ? note ? `Approved, with your additions: ${note} Moving to Code and starting with the streaks table.` : 'Approved. Moving to Code and starting with the streaks table.'
      : note ? `Understood: ${note} I will revise the plan and propose it again.` : 'Rejected. What should change?'), 24);
  } else item('a2', message('a2', 'assistant', 'Approved. Moving to Code and starting with the streaks table.'), 24);
  if (mode === 'today' || plan) {
    item('u2', message('u2', 'user', 'Build the iOS app next.'));
    item('a3', message('a3', 'assistant', 'Two things before I build it.'));
    rows.push({ key: 'ios', gap: 8, node: ios
      ? mode === 'proposed' ? <AnsweredCard title="Questions" questions={IOS} answers={ios.answers} at={ios.at} /> : <AskBlockView item={askBlock('ios', IOS, ios.answers)} />
      : <AskBlockView item={askBlock('ios', IOS)} onAnswer={async answers => { setIos(recorded(answers)); }} /> });
    if (ios) item('a4', message('a4', 'assistant', 'Attaching MacBook-Pro-2.local. I will run what you chose there and report back.'), 24);
  }

  return <div className="flex h-dvh flex-col bg-background">
    <SidebarProvider className="gitspace-shell min-h-0 flex-1" persist={false}>
      <MockSidebar />
      <SidebarInset className="min-w-0">
        <SidebarInsetTopbar>
          <span className="inline-flex min-w-0 flex-1 items-center gap-2 truncate text-body">
            <span className="font-medium">ToneTempo · Challenges and streaks</span>
            <span className="inline-flex items-center gap-1 font-mono text-caption text-muted-foreground"><GitBranch01 width={12} height={12} strokeWidth={1.5} />tonetempo-challenges-and-streaks</span>
          </span>
        </SidebarInsetTopbar>
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full min-w-0 max-w-3xl px-6 pb-48 pt-6">
              {rows.map(row => <Fragment key={row.key}><div className="min-w-0" style={{ paddingBottom: row.gap }}>{row.node}</div></Fragment>)}
            </div>
          </div>
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center px-6 pb-4">
            <div className="w-full max-w-xl">
              {mode === 'today' ? <div className={`${shape.container} pointer-events-auto mb-2 flex max-h-[50dvh] flex-col gap-2 overflow-y-auto bg-surface-3 p-3 shadow-surface-3`}>
                <AskBlockView item={todayPlan} onAnswer={async () => { throw new Error('Choose Approve or Reject.'); }} />
              </div> : null}
              <div className="pointer-events-auto"><Composer workspace={verticalSliceFixture.workspace} running={false} pending={false} /></div>
            </div>
          </div>
        </div>
      </SidebarInset>
    </SidebarProvider>
    <div className="fixed right-4 top-3 z-50">
      <DropdownMenu>
        <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" className="border border-dashed border-border shadow-surface-1">{mode === 'proposed' ? 'Proposed' : 'Today'} (mock)</Button>} />
        <DropdownContent align="end" className="w-[260px] min-w-[260px]">
          <MenuItem index={0} label="Proposed: note, cards stay locked" onSelect={() => { setMode('proposed'); reset(); }} />
          <MenuItem index={1} label="Today: floating card, collapsed answers" onSelect={() => { setMode('today'); reset(); }} />
          <MenuItem index={2} label="Reset answers" onSelect={reset} />
        </DropdownContent>
      </DropdownMenu>
    </div>
  </div>;
}

restoreAppearance();
const root = document.getElementById('root');
if (!root) throw new Error('root missing');
createRoot(root).render(<StrictMode>
  <ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider>
    <AnsweredQuestionsMock />
  </TooltipProvider></IconProvider></SizeProvider></ShapeProvider>
</StrictMode>);
