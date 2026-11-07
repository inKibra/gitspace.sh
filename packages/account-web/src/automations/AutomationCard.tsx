import { Badge, Button, Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, Switch } from '@gitspace/ui';
import { DotsHorizontal, MessageChatCircle } from '@untitledui/icons';
import { type ReactElement, type ReactNode } from 'react';
import { AUTOMATION_EVENT_LABEL, AUTOMATION_MODES, AUTOMATION_START_LABELS, AUTOMATION_WATCH_EVERY_LABEL, AUTOMATION_WATCH_LABEL, describeAutomationSchedule, type AutomationView } from '@gitspace/protocol/automations-contract';
import { MODEL_ROLE_LABELS } from '@gitspace/protocol/inference';
import { formatRelativeTime } from '../relative-time.js';
import { Code, CodeList, ConditionReadback } from './AutomationConditions.js';
import { RunBadge, TestResults } from './AutomationRuns.js';
import { type AutomationsProject } from './AutomationsPage.js';
import { Row } from './automation-fields.js';
import { DeleteGlyph, EditGlyph, MODE_COLOR, MODE_LABEL, OFF_NOTE, PlayGlyph, TestGlyph, formatUtc, subjectNoun, workspaceLabel } from './automation-formatters.js';

function triggerReadback(automation: AutomationView, now: number): ReactNode {
  const { trigger } = automation;
  switch (trigger.kind) {
    case 'manual': return <>Manual only: runs when you choose <strong className="font-semibold">Run now</strong></>;
    case 'label': return <>GitHub · label <CodeList values={Object.keys(AUTOMATION_START_LABELS)} last=" or " /> added to an issue or pull request</>;
    case 'github': return <>GitHub · {trigger.events.map((entry, index) => <span key={entry.event}>{index === 0 ? '' : ' · '}{AUTOMATION_EVENT_LABEL[entry.event].toLowerCase()}{entry.actions.length ? <> <CodeList values={entry.actions} last=", " /></> : null}</span>)}</>;
    case 'watch': return <>{AUTOMATION_WATCH_LABEL[trigger.on]} of <Code>{trigger.repository ?? 'this project\'s repository (its upstream for a fork)'}</Code> · checked {AUTOMATION_WATCH_EVERY_LABEL[trigger.every].toLowerCase()} unless the GitHub App delivers it</>;
    case 'schedule': {
      const next = automation.enabled && automation.proposal === null ? automation.nextRunAt : null;
      const described = describeAutomationSchedule(trigger.cron);
      // An expression with no plain-words form reads back as itself; show it once.
      return <><Code>{trigger.cron}</Code>{described === `${trigger.cron.trim()} (UTC)` ? ' (UTC)' : <> · {described}</>}{next ? <> · <span title={formatUtc(next)}>next {formatRelativeTime(next, now)}</span></> : null}</>;
    }
  }
}

function actionReadback(automation: AutomationView, project: AutomationsProject | undefined): ReactNode {
  const { action } = automation;
  switch (action.kind) {
    case 'messageProjectAgent': return 'Message the project agent';
    case 'messageWorkspace': return <>Message workspace <span className="font-mono text-caption">{workspaceLabel(project, automation.projectId, action.workspaceId)}</span></>;
    case 'startWorkspace': return <>Start a workspace for {subjectNoun(automation.trigger)} · starts in <strong className="font-semibold">{action.mode ? MODE_LABEL[action.mode] : 'the label\'s mode'}</strong>{action.role ? <> with model role <strong className="font-semibold">{MODEL_ROLE_LABELS[action.role] ?? action.role}</strong></> : null}</>;
    case 'sendToLinked': return <>Send to its linked workspace{action.orProjectAgent ? ', or to the project agent when it has none' : ''}{action.wake ? <> · <strong className="font-semibold">wakes the agent</strong></> : ' as a notice · the agent stays asleep'}</>;
  }
}

export interface CardHandlers {
  toggle(automation: AutomationView): void;
  runNow(automation: AutomationView): void;
  test(automation: AutomationView): void;
  edit(automation: AutomationView): void;
  remove(automation: AutomationView): void;
  approve(automation: AutomationView): void;
  dismiss(automation: AutomationView): void;
  openConversation(automation: AutomationView): void;
}

export function AutomationCard({ automation, index, project, bot, busy, now, handlers }: { automation: AutomationView; index: number; project: AutomationsProject | undefined; bot: string; busy: boolean; now: number; handlers: CardHandlers }): ReactElement {
  const { proposal, action, trigger } = automation;
  const modes = action.kind === 'startWorkspace' ? action.mode ? [action.mode] : AUTOMATION_MODES : [];
  const runsNow = trigger.kind === 'schedule' || trigger.kind === 'manual' || trigger.kind === 'watch';
  return <Card index={index}>
    <CardHeader>
      <CardTitle><span className="flex flex-wrap items-center gap-2"><span className="[overflow-wrap:anywhere]">{automation.name}</span>
        {modes.map(mode => <Badge key={mode} size="compact" color={MODE_COLOR[mode]}>{MODE_LABEL[mode]}</Badge>)}
        {automation.isDefault ? <Badge size="compact" color="gray">Default</Badge> : null}
      </span></CardTitle>
      <CardDescription><span className="flex flex-wrap items-center gap-1.5">
        {proposal ? <><Badge size="compact" color="amber">Proposed</Badge><span>by the project agent · {formatRelativeTime(proposal.proposedAt, now)}</span></>
          : automation.lastRun ? <><span>Last run {formatRelativeTime(automation.lastRun.at, now)}</span><RunBadge state={automation.lastRun.state} /></> : <span>No runs yet</span>}
      </span></CardDescription>
      {proposal ? null : <CardAction>
        <div className="flex items-center gap-2">
          <Switch label={automation.enabled ? 'On' : 'Off'} checked={automation.enabled} disabled={busy} onToggle={() => handlers.toggle(automation)} />
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${automation.name}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
            <DropdownContent align="end" className="min-w-[220px] w-[220px]">
              {runsNow ? <MenuItem index={0} icon={PlayGlyph} label="Run now" onSelect={() => handlers.runNow(automation)} />
                : <MenuItem index={0} icon={TestGlyph} label="Test with a past event" onSelect={() => handlers.test(automation)} />}
              <MenuItem index={1} icon={EditGlyph} label="Edit" onSelect={() => handlers.edit(automation)} />
              <MenuItem index={2} icon={DeleteGlyph} label="Delete" onSelect={() => handlers.remove(automation)} />
            </DropdownContent>
          </DropdownMenu>
        </div>
      </CardAction>}
    </CardHeader>
    <CardContent>
      <dl className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 sm:grid-cols-[7rem_minmax(0,1fr)]">
        <Row label="When">{triggerReadback(automation, now)}</Row>
        <Row label="Only if">{automation.conditions.length ? <span className="flex flex-wrap gap-x-1.5">{automation.conditions.map((condition, at) => <span key={condition.kind}>{at > 0 ? '· ' : ''}<ConditionReadback condition={condition} bot={bot} /></span>)}</span>
          : <span className="text-muted-foreground">Always</span>}</Row>
        <Row label="Then">{actionReadback(automation, project)}</Row>
        <Row label="Instruction"><span className="line-clamp-3 whitespace-pre-wrap text-muted-foreground">{action.instruction}</span></Row>
      </dl>
    </CardContent>
    {proposal ? <CardFooter><div className="flex w-full min-w-0 flex-col gap-3">
      <p className="flex items-start gap-2 text-body"><MessageChatCircle className="mt-0.5 shrink-0 text-muted-foreground" width={16} height={16} strokeWidth={1.5} /><span className="min-w-0 [overflow-wrap:anywhere]"><span className="text-muted-foreground">You asked: </span>“{proposal.asked}”</span></p>
      <p className="text-body text-muted-foreground [overflow-wrap:anywhere]">{proposal.reason}</p>
      {proposal.tested.length ? <div className="flex flex-col gap-1.5">
        <strong className="text-caption font-medium text-muted-foreground">The agent's test</strong>
        <TestResults results={proposal.tested} />
      </div> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="compact" type="button" disabled={busy} onClick={() => handlers.approve(automation)}>Switch on</Button>
        <Button variant="secondary" size="compact" type="button" disabled={busy} onClick={() => handlers.edit(automation)}>Edit first</Button>
        <Button variant="ghost" size="compact" type="button" onClick={() => handlers.openConversation(automation)}>Open conversation</Button>
        <Button variant="ghost" size="compact" type="button" disabled={busy} onClick={() => handlers.dismiss(automation)}>Dismiss</Button>
      </div>
    </div></CardFooter>
      : automation.enabled ? null : <CardFooter><span className="text-caption text-muted-foreground">{OFF_NOTE[trigger.kind]}</span></CardFooter>}
  </Card>;
}
