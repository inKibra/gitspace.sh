import { Badge, Button, Select, SelectTrigger, badgeColors, useShape } from '@gitspace/ui';
import { Check, Zap } from '@untitledui/icons';
import { useState, type ReactElement } from 'react';
import { AUTOMATION_MODES, type AutomationException, type AutomationMode, type AutomationView } from '@gitspace/protocol/automations-contract';
import { formatRelativeTime } from '../relative-time.js';
import { type AutomationWorkspace } from './AutomationsPage.js';
import { options } from './automation-fields.js';
import { MODE_LABEL } from './automation-formatters.js';

/** The column of the workspace's phase now. */
const NOW_COLUMN = 'bg-[color-mix(in_oklab,var(--focus-ring)_10%,transparent)]';

/**
 * One workspace's automations by phase: a cell is on when the automation's phases include the phase, unless the
 * workspace has an exception for it (a ringed cell). Pressing a cell away from the phases records an exception; back
 * to them removes it. Only automations that reach the workspace by phase are listed: those sending to linked
 * workspaces, and those messaging this workspace.
 */
export function AutomationPhaseGrid({ automations, workspaces, exceptions, busy, now, onSet }: {
  automations: readonly AutomationView[]; workspaces: readonly AutomationWorkspace[]; exceptions: readonly AutomationException[]; busy: string | null; now: number;
  onSet(automation: AutomationView, workspaceId: string, phase: AutomationMode, enabled: boolean | null): void;
}): ReactElement {
  const shape = useShape();
  const choices = workspaces.filter(workspace => workspace.active || exceptions.some(exception => exception.workspaceId === workspace.id));
  const [chosen, setChosen] = useState<string | null>(null);
  const workspace = choices.find(entry => entry.id === chosen) ?? choices[0];
  if (!workspace) return <p className="text-caption text-muted-foreground">No open workspaces.</p>;
  const rows = automations.filter(automation => automation.action.kind === 'sendToLinked' || (automation.action.kind === 'messageWorkspace' && automation.action.workspaceId === workspace.id));
  const mine = exceptions.filter(exception => exception.workspaceId === workspace.id && rows.some(automation => automation.id === exception.automationId));
  const grid = rows.map(automation => ({
    automation,
    cells: AUTOMATION_MODES.map(phase => {
      const exception = mine.find(entry => entry.automationId === automation.id && entry.phase === phase);
      const byDefault = automation.phases === undefined || automation.phases.includes(phase);
      return { phase, exception, byDefault, on: exception?.enabled ?? byDefault };
    }),
  }));
  const live = grid.filter(row => row.cells.some(cell => cell.phase === workspace.phase && cell.on)).length;

  return <div className="flex min-w-0 flex-col gap-2">
    <div className="flex flex-wrap items-end justify-between gap-2">
      <p className="min-w-0 flex-[1_1_18rem] text-caption text-muted-foreground">The automations that reach {workspace.name} and its exceptions to their phases. {live} on in {MODE_LABEL[workspace.phase]}, its phase now. A ringed cell is an exception.</p>
      <div className="w-60 max-w-full"><Select value={workspace.id} onValueChange={setChosen}>
        <SelectTrigger aria-label="Workspace" />{options(choices.map(entry => ({ value: entry.id, label: entry.active ? entry.name : `${entry.name} (closed)` })))}
      </Select></div>
    </div>
    {rows.length ? <div className={`${shape.container} overflow-x-auto border border-border bg-surface-1`}>
      <table aria-label={`Automations by phase for ${workspace.name}`} className="w-full border-collapse text-left">
        <thead><tr className="border-b border-border text-caption text-muted-foreground">
          <th className="px-3 py-2 font-medium">Automation</th>
          {AUTOMATION_MODES.map(phase => <th key={phase} className={`w-16 px-1 py-2 text-center font-medium ${phase === workspace.phase ? `${NOW_COLUMN} text-foreground` : ''}`}>{MODE_LABEL[phase]}</th>)}
        </tr></thead>
        <tbody>{grid.map(({ automation, cells }) => <tr key={automation.id} className="border-b border-border align-top last:border-b-0">
          <td className="px-3 py-2">
            <span className="flex flex-wrap items-center gap-1.5"><Zap width={12} height={12} strokeWidth={1.75} style={{ color: cells.some(cell => cell.phase === workspace.phase && cell.on) ? badgeColors.amber : undefined }} className="text-muted-foreground" /><span className="text-caption font-medium text-foreground [overflow-wrap:anywhere]">{automation.name}</span>
              {automation.proposal ? <Badge size="compact" color="amber">Proposed</Badge> : automation.enabled ? null : <Badge size="compact" color="gray">Off</Badge>}</span>
          </td>
          {cells.map(({ phase, exception, byDefault, on }) => <td key={phase} className={`px-1 py-2 text-center ${phase === workspace.phase ? NOW_COLUMN : ''}`}>
            <button type="button" role="switch" aria-checked={on} aria-label={`${automation.name} in ${MODE_LABEL[phase]}${exception ? ' (exception)' : ''}`} disabled={busy === automation.id}
              onClick={() => onSet(automation, workspace.id, phase, !on === byDefault ? null : !on)}
              className={`inline-flex size-5 items-center justify-center rounded border disabled:opacity-60 ${on ? 'border-foreground bg-foreground text-background' : 'border-border bg-background text-transparent enabled:hover:text-muted-foreground'} ${exception ? 'ring-[1.5px] ring-[color:var(--focus-ring)] ring-offset-2 ring-offset-background' : ''}`}>
              <Check width={12} height={12} strokeWidth={3} />
            </button>
          </td>)}
        </tr>)}</tbody>
      </table>
    </div> : <p className="text-caption text-muted-foreground">No automation sends to {workspace.name}.</p>}
    {mine.length ? <ul aria-label={`Exceptions for ${workspace.name}`} className="flex flex-col gap-1">{mine.map(exception => {
      const automation = rows.find(item => item.id === exception.automationId);
      if (!automation) return null;
      return <li key={`${exception.automationId}:${exception.phase}`} className="flex flex-wrap items-center gap-2 text-caption text-muted-foreground">
        <span aria-hidden className="size-2 rounded-full ring-[1.5px] ring-inset ring-[color:var(--focus-ring)]" />
        <span className="min-w-0 [overflow-wrap:anywhere]"><span className="text-foreground">{automation.name}</span> {exception.enabled ? 'on' : 'off'} in {MODE_LABEL[exception.phase]} for this workspace · {formatRelativeTime(new Date(exception.at), now)}</span>
        <Button variant="ghost" size="compact" type="button" disabled={busy === automation.id} onClick={() => onSet(automation, exception.workspaceId, exception.phase, null)}>Use its phases</Button>
      </li>;
    })}</ul> : null}
  </div>;
}
