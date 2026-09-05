import type { SessionControlView, SkillView } from '@gitspace/protocol';
import { Button, Dropdown, DropdownContent, DropdownMenu, DropdownTrigger, InputMessage, MenuItem, Select, SelectContent, SelectItem, SelectTrigger, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useIcons, useShape, type IconName, type QueuedMessage } from '@gitspace/ui';
import { Attachment01, CpuChip01, DotsHorizontal, Zap } from '@untitledui/icons';
import { useMemo, useState, type ReactNode } from 'react';
import { glyph } from './glyph.js';
import type { AgentScopeView, GitSpaceShellProps, ProviderAuthView, SessionControlsProps } from './GitSpaceShell.js';
import { SessionTreeExplorer } from './SessionTreeExplorer.js';

export type SendBehavior = 'steer' | 'followUp';

function options(items: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{items.map((item, index) => <SelectItem value={item.value} index={index} key={item.value}>{item.label}</SelectItem>)}</SelectContent>;
}

async function imageAttachment(file: File): Promise<{ data: string; mimeType: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 32 * 1024) binary += String.fromCharCode(...bytes.subarray(offset, offset + 32 * 1024));
  return { data: btoa(binary), mimeType: file.type };
}

// ThinkingStep hides `pending` rows (the registry reveals steps as they
// happen); a plan needs its future tasks visible, so state rides the icon.
const STEP_ICON: Record<'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked', IconName> = { pending: 'circle', in_progress: 'loader', completed: 'check', abandoned: 'x', blocked: 'lock' };

/** The agent's plan, rendered with the registry's reasoning-steps component above the composer. */
function PlanSteps({ controls }: { controls: SessionControlsProps }) {
  const tasks = controls.value.todos.flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, ...task })));
  if (!tasks.length) return null;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  return <ThinkingSteps defaultOpen={false}>
    <ThinkingStepsHeader>Plan · {completed}/{tasks.length}</ThinkingStepsHeader>
    <ThinkingStepsContent>
      {tasks.map((task, index) => <ThinkingStep
        key={`${task.phase}:${task.content}`}
        label={task.content}
        description={task.blocker ? `${task.phase} · ${task.blocker}` : task.phase}
        status={task.status === 'in_progress' ? 'active' : 'complete'}
        icon={STEP_ICON[task.status]}
        isLast={index === tasks.length - 1}
      />)}
    </ThinkingStepsContent>
  </ThinkingSteps>;
}

interface SlashCommand { name: string; hint: string; run(): void }

/** Slash commands surface as the registry's inline Dropdown panel while the draft starts with "/". */
function CommandPalette({ draft, commands, onPick }: { draft: string; commands: SlashCommand[]; onPick(command: SlashCommand): void }) {
  const query = draft.slice(1).trim().toLowerCase();
  const matches = commands.filter((command) => command.name.slice(1).startsWith(query));
  if (!matches.length) return null;
  return <Dropdown size="compact" aria-label="Commands">
    {matches.map((command, index) => <MenuItem key={command.name} index={index} label={`${command.name} — ${command.hint}`} onSelect={() => onPick(command)} />)}
  </Dropdown>;
}

/** Shown above the input when the selected model's provider has no credentials on this machine. */
function ProviderNotice({ provider }: { provider: ProviderAuthView }) {
  const shape = useShape();
  return <div role="status" className={`${shape.container} flex items-center justify-between gap-3 bg-surface-3 px-3 py-2 text-caption shadow-surface-1`}>
    <span className="min-w-0 truncate text-foreground">{provider.name} isn’t connected on this machine</span>
    <Button variant="tertiary" size="compact" asChild><a href="/settings?section=omp-providers">Connect</a></Button>
  </div>;
}

export interface ComposerProps {
  workspace: AgentScopeView;
  controls?: SessionControlsProps;
  providers?: readonly ProviderAuthView[];
  skills?: readonly SkillView[];
  running: boolean;
  onSend?: GitSpaceShellProps['onSend'];
  pending: boolean;
  recovering?: boolean;
  error?: string;
}

export function Composer({ workspace, controls, providers, skills = [], running, onSend, pending, recovering = false, error }: ComposerProps) {
  const icons = useIcons();
  const [message, setMessage] = useState('');
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const submit = async (draft: string, draftAttachments: File[], behavior: SendBehavior = 'followUp'): Promise<boolean> => {
    const text = draft.trim();
    if (!text || !onSend || pending || recovering) return false;
    setSubmitError(null);
    try {
      const files = draftAttachments.filter((file) => !file.type.startsWith('image/'));
      const images = await Promise.all(draftAttachments.filter((file) => file.type.startsWith('image/')).map(imageAttachment));
      const attached = await Promise.all(files.map(async (file) => {
        if (file.type.startsWith('text/') && file.size <= 256 * 1024) return `<attachment name="${file.name}">\n${await file.text()}\n</attachment>`;
        return `<attachment name="${file.name}" type="${file.type || 'application/octet-stream'}" size="${file.size}" />`;
      }));
      await onSend([text, ...attached].join('\n\n'), behavior, images);
      setMessage('');
      setAttachments([]);
      return true;
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  };
  const runControl = (operation: Promise<void>): void => {
    setSubmitError(null);
    void operation.catch((failure) => setSubmitError(failure instanceof Error ? failure.message : String(failure)));
  };

  // OMP owns the queue. Fluid owns the row interactions and reports their
  // intent; each edit/remove is reconciled against the canonical queue.
  const queue = useMemo<QueuedMessage[]>(() => controls
    ? [
      ...controls.value.queue.steering.map((text, index) => ({ id: `steering:${index}`, text, files: [], kind: 'steering' as const })),
      ...controls.value.queue.followUp.map((text, index) => ({ id: `followUp:${index}`, text, files: [], kind: 'followUp' as const })),
    ]
    : [], [controls]);
  const onQueueChange = async (next: QueuedMessage[]): Promise<boolean | void> => {
    if (!controls) return false;
    setSubmitError(null);
    try {
      if (next.length === 0 && queue.length > 1) {
        await controls.onClearQueue();
        return;
      }
      const remaining = new Set(next.map((item) => item.id));
      const removed = queue.find((item) => !remaining.has(item.id));
      if (removed?.kind) {
        const index = Number(removed.id.split(':')[1]);
        await controls.onRemoveQueuedMessage(removed.kind, index);
        return;
      }
      const known = new Set(queue.map((item) => item.id));
      const added = next.find((item) => !known.has(item.id));
      if (added) return submit(added.text, added.files, 'followUp');
    } catch (failure) {
      setSubmitError(failure instanceof Error ? failure.message : String(failure));
      return false;
    }
  };
  const steerQueued = (item: QueuedMessage): void => {
    if (!controls || item.kind !== 'followUp') return;
    runControl(controls.onPromoteQueuedMessage(Number(item.id.split(':')[1])));
  };

  const availableSkills = skills.filter((skill) => {
    if (!skill.enabled || skill.exceptions.includes(workspace.projectId)) return false;
    const assignment = skill.assignments.find((candidate) => candidate.projectId === workspace.projectId);
    if (assignment) return workspace.kind === 'project' ? assignment.projectSpaceEnabled : assignment.workspacesEnabled;
    return workspace.kind === 'project'
      ? skill.scope === 'project' || skill.scope === 'all'
      : skill.scope === 'workspaces' || skill.scope === 'all';
  });
  const commands: SlashCommand[] = message.startsWith('/skill:')
    ? availableSkills.map((skill) => ({
        name: `/skill:${skill.name}`,
        hint: skill.description,
        run: () => setMessage(`/skill:${skill.name} `),
      }))
    : availableSkills.length
      ? [{ name: '/skill:', hint: 'Run an available skill', run: () => setMessage('/skill:') }]
      : [];

  const thinkingLevels = ['auto', 'off', 'low', 'medium', 'high', 'xhigh'];
  const streaming = running;
  const selectedProvider = controls?.value.provider ? providers?.find((provider) => provider.id === controls.value.provider) : undefined;

  return <div className="mx-auto flex w-full max-w-xl flex-col gap-2">
    {controls ? <PlanSteps controls={controls} /> : null}
    {controls && showHistory ? <SessionTreeExplorer history={controls.value.history} tree={controls.value.tree} onNavigate={(entryId) => void controls.onNavigateTree(entryId)} onClose={() => setShowHistory(false)} /> : null}
    {message.startsWith('/') && commands.length ? <CommandPalette draft={message} commands={commands} onPick={(command) => { setMessage(''); command.run(); }} /> : null}
    {selectedProvider && !selectedProvider.hasAuth ? <ProviderNotice provider={selectedProvider} /> : null}
    <InputMessage
      data-slot="input-message"
      value={message}
      onValueChange={setMessage}
      onSend={(text, files, meta) => { if (meta?.queuedId) return; void submit(text, files); }}
      placeholder={recovering ? 'Recovering agent…' : `Ask the ${workspace.kind === 'project' ? 'project' : 'workspace'} agent…`}
      disabled={!onSend || pending || recovering}
      files={attachments}
      onFilesChange={setAttachments}
      accept="image/png,image/jpeg,image/webp,text/*,application/pdf"
      maxFiles={8}
      history={controls?.value.history.map((entry) => entry.text) ?? []}
      status={streaming ? 'streaming' : 'idle'}
      streamingSubmitBehavior="queue"
      queue={queue}
      onQueueChange={onQueueChange}
      autoDispatchQueue={false}
      onQueueSteer={steerQueued}
      onStop={controls ? () => runControl(controls.onStop()) : undefined}
      leftSlot={({ openFilePicker }) => <>
        <Button variant="ghost" size="icon-compact" type="button" aria-label="Attach files" onClick={() => openFilePicker()}><Attachment01 width={16} height={16} strokeWidth={1.5} /></Button>
        {controls ? <>
          <Select size="compact" value={`${controls.value.provider ?? ''}/${controls.value.model ?? ''}`} onValueChange={(value) => { const selected = controls.value.models.find((model) => `${model.provider}/${model.id}` === value); if (selected) void controls.onSetModel(selected.provider, selected.id); }}>
            <SelectTrigger variant="borderless" aria-label="Model" icon={glyph(CpuChip01)} />
            {options(controls.value.models.map((model) => ({ value: `${model.provider}/${model.id}`, label: model.name || model.id })))}
          </Select>
          <Select size="compact" value={controls.value.thinking ?? 'auto'} onValueChange={(value) => void controls.onSetThinking(value === 'auto' ? null : value)}>
            <SelectTrigger variant="borderless" aria-label="Thinking level" className="max-md:hidden" />
            {options(thinkingLevels.map((level) => ({ value: level, label: level })))}
          </Select>
        </> : null}
      </>}
      rightSlot={controls ? <>
        <DropdownMenu size="compact">
          <DropdownTrigger render={<Button variant="ghost" size="icon-compact" type="button" aria-label="More agent controls"><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
          <DropdownContent align="end" side="top" sideOffset={6} className="min-w-[240px] w-[240px]">
            <MenuItem index={0} icon={icons.user} label={`Role: ${controls.value.roleLabel ?? 'Default'}`} onSelect={() => void controls.onCycleRole('forward')} closeOnClick={false} />
            <MenuItem index={1} icon={glyph(Zap)} label="Fast mode" checked={controls.value.fastMode} onSelect={() => void controls.onSetFast(!controls.value.fastMode)} />
            <MenuItem index={2} icon={icons.shield} label={`Approval: ${{ 'always-ask': 'Always ask', write: 'Ask for writes', yolo: 'Auto-approve' }[controls.value.approvalMode]}`} onSelect={() => { const order: SessionControlView['approvalMode'][] = ['always-ask', 'write', 'yolo']; void controls.onSetApproval(order[(order.indexOf(controls.value.approvalMode) + 1) % order.length]); }} closeOnClick={false} />
            {workspace.kind === 'workspace' && workspace.phase === 'code' ? <MenuItem index={3} icon={icons.rocket} label="Goal mode" checked={!!controls.value.goal} onSelect={() => void controls.onSetGoal(!controls.value.goal)} /> : null}
            <MenuItem index={4} icon={icons['rotate-ccw']} label="Compact context" onSelect={() => void controls.onCompact()} />
            <MenuItem index={5} icon={icons.clock} label="Session history" onSelect={() => setShowHistory((value) => !value)} />
            <MenuItem index={6} icon={icons.brain} label={`Thinking: ${controls.value.thinking ?? 'auto'}`} onSelect={() => { const next = thinkingLevels[(thinkingLevels.indexOf(controls.value.thinking ?? 'auto') + 1) % thinkingLevels.length]; void controls.onSetThinking(next === 'auto' ? null : next); }} closeOnClick={false} className="md:hidden" />
          </DropdownContent>
        </DropdownMenu>
      </> : null}
    />
    {error || submitError ? <p role="alert" className="text-caption text-destructive">{error ?? submitError}</p> : null}
  </div>;
}
