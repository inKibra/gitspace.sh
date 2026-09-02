import {
  Badge,
  Button,
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownContent,
  DropdownMenu,
  DropdownTrigger,
  InputField,
  InputGroup,
  MenuItem,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  useShape,
} from '@gitspace/ui';
import { ChevronDown, ChevronUp, ClockRewind, DotsHorizontal, Edit03, Play, Plus, Trash01 } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement, type ReactNode } from 'react';
import {
  PROJECT_CRON_SCHEDULE_HELP,
  parseProjectCronSchedule,
  type ProjectCronDraft,
  type ProjectCronRunState,
  type ProjectCronRunView,
  type ProjectCronState,
  type ProjectCronTarget,
  type ProjectCronView,
} from '@gitspace/protocol/cron-contract';
import { glyph } from './glyph.js';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';

export interface ProjectCronTargetOption {
  target: ProjectCronTarget;
  label: string;
  description?: string;
}
function selectOptions(options: readonly { value: string; label: string }[]): ReactElement {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}

export interface ProjectCronsPageProps {
  projectId: string;
  projectName: string;
  /** Holder machine per space id, from placements; base space id = project id. */
  holders?: Readonly<Record<string, string>>;
  crons: readonly ProjectCronView[];
  targetOptions: readonly ProjectCronTargetOption[];
  loading?: boolean;
  loadError?: string | null;
  onCreateCron(draft: ProjectCronDraft): Promise<ProjectCronView>;
  onUpdateCron(cronId: string, expectedRevision: number, draft: ProjectCronDraft): Promise<ProjectCronView>;
  onDeleteCron(cronId: string, expectedRevision: number): Promise<void>;
  onRunNow(cronId: string): Promise<ProjectCronRunView>;
  onListRuns(cronId: string): Promise<readonly ProjectCronRunView[]>;
}

export function projectCronTargetKey(target: ProjectCronTarget): string {
  return target.scope === 'project'
    ? `project:${target.projectId}`
    : `workspace:${target.projectId}:${target.spaceId}`;
}

export function formatProjectCronTime(value: Date | null, now = Date.now()): string {
  if (value === null) return 'Never';
  const difference = value.getTime() - now;
  const absolute = Math.abs(difference);
  if (absolute < 60_000) return difference >= 0 ? 'due now' : 'just now';
  const suffix = difference >= 0 ? '' : ' ago';
  const prefix = difference >= 0 ? 'in ' : '';
  if (absolute < 3_600_000) return `${prefix}${Math.round(absolute / 60_000)}m${suffix}`;
  if (absolute < 86_400_000) {
    const totalMinutes = Math.round(absolute / 60_000);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return `${prefix}${hours}h${minutes > 0 ? ` ${minutes}m` : ''}${suffix}`;
  }
  const days = Math.round(absolute / 86_400_000);
  return `${prefix}${days}d${suffix}`;
}

type BadgeColor = 'green' | 'blue' | 'amber' | 'red' | 'gray';
const CRON_STATE_COLOR: Record<ProjectCronState, BadgeColor> = { armed: 'green', paused: 'gray', running: 'blue', blocked: 'amber', failed: 'red' };
const RUN_STATE_COLOR: Record<ProjectCronRunState, BadgeColor> = { pending: 'blue', running: 'blue', succeeded: 'green', blocked: 'amber', failed: 'red' };

function editorDraft(projectId: string, source?: ProjectCronView): ProjectCronDraft {
  return source ? {
    name: source.name,
    schedule: source.schedule,
    description: source.description,
    prompt: source.prompt,
    target: source.target,
    readScopes: [...source.readScopes],
    writeScopes: [...source.writeScopes],
    enabled: source.enabled,
  } : {
    name: '',
    schedule: 'every 6h',
    description: '',
    prompt: '',
    target: { scope: 'project', projectId },
    readScopes: [],
    writeScopes: [],
    enabled: true,
  };
}

function Field({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }): ReactElement {
  return <label className={`flex min-w-0 flex-col gap-1 ${className}`}>
    <span className="text-caption font-medium text-muted-foreground">{label}</span>
    {children}
  </label>;
}

// FLUID-GAP: textarea — Fluid has no multi-line text field; plain <textarea> on Fluid tokens.
function TextArea({ value, onChange, className = '', ...rest }: { value: string; onChange(value: string): void; rows: number; placeholder?: string; required?: boolean; maxLength?: number; className?: string }): ReactElement {
  const shape = useShape();
  return <textarea
    {...rest}
    value={value}
    onChange={(event) => onChange(event.currentTarget.value)}
    className={`${shape.input} w-full resize-y border border-border bg-surface-2 p-2 text-body text-foreground placeholder:text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${className}`}
  />;
}

function CronEditor({
  projectId,
  source,
  options,
  onCancel,
  onSave,
}: {
  projectId: string;
  source?: ProjectCronView;
  options: readonly ProjectCronTargetOption[];
  onCancel(): void;
  onSave(draft: ProjectCronDraft): Promise<void>;
}): ReactElement {
  const initial = editorDraft(projectId, source);
  const [name, setName] = useState(initial.name);
  const [schedule, setSchedule] = useState(initial.schedule);
  const [description, setDescription] = useState(initial.description);
  const [prompt, setPrompt] = useState(initial.prompt);
  const [targetKey, setTargetKey] = useState(projectCronTargetKey(initial.target));
  const [readScopes, setReadScopes] = useState(initial.readScopes.join('\n'));
  const [writeScopes, setWriteScopes] = useState(initial.writeScopes.join('\n'));
  const [enabled, setEnabled] = useState(initial.enabled);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scheduleValid = parseProjectCronSchedule(schedule) !== null;

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const target = options.find((option) => projectCronTargetKey(option.target) === targetKey)?.target;
    if (!target) {
      setError('Choose an available canonical agent target.');
      return;
    }
    if (!scheduleValid) {
      setError(PROJECT_CRON_SCHEDULE_HELP);
      return;
    }
    if (!name.trim() || !prompt.trim()) {
      setError('Name and agent instruction are required.');
      return;
    }
    const normalizeScopes = (value: string): string[] => [...new Set(value.split(/[\n,]/u).map((scope) => scope.trim()).filter(Boolean))];
    setSubmitting(true);
    setError(null);
    try {
      await onSave({
        name: name.trim(),
        schedule: schedule.trim(),
        description: description.trim(),
        prompt: prompt.trim(),
        target,
        readScopes: normalizeScopes(readScopes),
        writeScopes: normalizeScopes(writeScopes),
        enabled,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  };

  return <>
    <DialogHeader>
      <DialogTitle>{source ? source.name : 'Create cron'}</DialogTitle>
      <DialogDescription>{source ? 'Edit schedule' : 'New project schedule'}</DialogDescription>
    </DialogHeader>
    <form id="project-cron-editor" className="flex flex-col gap-4" onSubmit={(event) => void submit(event)}>
      <InputGroup>
        <InputField index={0} label="Name" value={name} onChange={setName} placeholder="project-health" required maxLength={120} autoFocus />
        <InputField index={1} label="Schedule" value={schedule} onChange={setSchedule} placeholder="every 6h" required className="font-mono" error={scheduleValid ? undefined : `'${schedule.trim() || '(empty)'}' will never fire.`} />
      </InputGroup>
      <p className="text-caption text-muted-foreground">{PROJECT_CRON_SCHEDULE_HELP}</p>
      <Field label="Talk to">
        <Select value={targetKey} onValueChange={setTargetKey}><SelectTrigger aria-label="Talk to" />{selectOptions(options.map((option) => ({ value: projectCronTargetKey(option.target), label: `${option.label}${option.description ? ` · ${option.description}` : ''}` })))}</Select>
      </Field>
      <Field label="Description"><TextArea rows={2} maxLength={2_000} value={description} onChange={setDescription} placeholder="What this schedule owns and why it runs" /></Field>
      <Field label="Agent instruction"><TextArea required rows={5} maxLength={16_000} value={prompt} onChange={setPrompt} placeholder="Tell the canonical agent exactly what to do." /></Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Read scopes"><TextArea rows={3} value={readScopes} onChange={setReadScopes} placeholder={'repository/**\nlocal://base/reports/**'} className="font-mono" /></Field>
        <Field label="Write scopes"><TextArea rows={3} value={writeScopes} onChange={setWriteScopes} placeholder="local://base/reports/**" className="font-mono" /></Field>
      </div>
      <Switch label="Armed" checked={enabled} onToggle={() => setEnabled((value) => !value)} />
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="project-cron-editor" loading={submitting}>{submitting ? 'Saving…' : source ? 'Save changes' : 'Create cron'}</Button>
    </DialogFooter>
  </>;
}

function CronRunHistory({ runs }: { runs: readonly ProjectCronRunView[] }): ReactElement {
  if (runs.length === 0) return <p className="py-3 text-caption text-muted-foreground">No runs yet. Scheduled and manual runs appear here.</p>;
  return <Table size="compact">
    <TableHeader><TableRow><TableHead>State</TableHead><TableHead>Trigger</TableHead><TableHead>Target</TableHead><TableHead className="text-right">When</TableHead></TableRow></TableHeader>
    <TableBody>
      {runs.map((run, index) => {
        const at = run.completedAt ?? run.startedAt ?? run.scheduledFor;
        return <TableRow key={run.id} index={index}>
          <TableCell><Badge variant="dot" size="compact" color={RUN_STATE_COLOR[run.state]}>{run.state}</Badge></TableCell>
          <TableCell className="text-muted-foreground">{run.trigger} · <span className="tabular-nums">{formatProjectCronTime(run.scheduledFor)}</span></TableCell>
          <TableCell className="max-w-0">
            <span className="block truncate">{run.resolvedSpaceId ? `${run.resolvedSpaceId} · generation ${run.resolvedGeneration}` : 'Target not resolved'}</span>
            {run.message ? <span className="block truncate text-caption text-muted-foreground">{run.message}</span> : null}
          </TableCell>
          <TableCell className="text-right"><time className="tabular-nums text-muted-foreground" dateTime={at.toISOString()}>{formatProjectCronTime(at)}</time></TableCell>
        </TableRow>;
      })}
    </TableBody>
  </Table>;
}

function Stat({ value, label }: { value: number; label: string }): ReactElement {
  return <div className="flex flex-col gap-0.5 px-5 py-4">
    <strong className="text-title font-semibold tabular-nums text-foreground">{value}</strong>
    <span className="text-caption text-muted-foreground">{label}</span>
  </div>;
}

type EditorState = { kind: 'create' } | { kind: 'edit'; cron: ProjectCronView };

export function ProjectCronsPage(props: ProjectCronsPageProps): ReactElement {
  const shape = useShape();
  const [items, setItems] = useState<ProjectCronView[]>(() => [...props.crons]);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [openHistoryId, setOpenHistoryId] = useState<string | null>(null);
  const [historyByCron, setHistoryByCron] = useState<Map<string, readonly ProjectCronRunView[]>>(() => new Map());
  const [historyLoadingId, setHistoryLoadingId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  // The dialog keeps rendering its last editor while it animates closed.
  const lastEditor = useRef<EditorState>({ kind: 'create' });
  if (editor) lastEditor.current = editor;
  const lastDelete = useRef<ProjectCronView | null>(null);
  const deleting = confirmDeleteId ? items.find((cron) => cron.id === confirmDeleteId) ?? null : null;
  if (deleting) lastDelete.current = deleting;

  useEffect(() => setItems([...props.crons]), [props.crons]);

  const targetOptions = useMemo(() => {
    const projectTarget: ProjectCronTarget = { scope: 'project', projectId: props.projectId };
    const byKey = new Map<string, ProjectCronTargetOption>();
    byKey.set(projectCronTargetKey(projectTarget), { target: projectTarget, label: `Project agent · ${props.projectName}` });
    for (const option of props.targetOptions) {
      if (option.target.projectId === props.projectId) byKey.set(projectCronTargetKey(option.target), option);
    }
    return [...byKey.values()];
  }, [props.projectId, props.projectName, props.targetOptions]);

  const armed = items.filter((cron) => cron.enabled).length;
  const failures = items.filter((cron) => cron.lastRunState === 'failed' || cron.lastRunState === 'blocked').length;
  const targetCount = new Set(items.map((cron) => projectCronTargetKey(cron.target))).size;

  const handleError = (cause: unknown): void => setActionError(cause instanceof Error ? cause.message : String(cause));

  const update = async (cron: ProjectCronView, draft: ProjectCronDraft): Promise<void> => {
    setBusyId(cron.id);
    setActionError(null);
    try {
      const updated = await props.onUpdateCron(cron.id, cron.revision, draft);
      setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
    } catch (cause) {
      handleError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const chooseTarget = (cron: ProjectCronView, key: string): Promise<void> => {
    const target = targetOptions.find((option) => projectCronTargetKey(option.target) === key)?.target;
    if (!target || projectCronTargetKey(target) === projectCronTargetKey(cron.target)) return Promise.resolve();
    return update(cron, { ...editorDraft(props.projectId, cron), target });
  };

  const toggleEnabled = (cron: ProjectCronView): Promise<void> => update(cron, { ...editorDraft(props.projectId, cron), enabled: !cron.enabled });

  const runNow = async (cron: ProjectCronView): Promise<void> => {
    setBusyId(cron.id);
    setActionError(null);
    try {
      const run = await props.onRunNow(cron.id);
      setItems((current) => current.map((item) => item.id === cron.id ? {
        ...item,
        state: 'running',
        lastRunAt: run.scheduledFor,
        lastRunState: run.state,
        statusMessage: run.message,
      } : item));
      setHistoryByCron((current) => {
        const next = new Map(current);
        if (next.has(cron.id)) next.set(cron.id, [run, ...(next.get(cron.id) ?? [])]);
        return next;
      });
    } catch (cause) {
      handleError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const toggleHistory = async (cronId: string): Promise<void> => {
    if (openHistoryId === cronId) {
      setOpenHistoryId(null);
      return;
    }
    setOpenHistoryId(cronId);
    if (historyByCron.has(cronId)) return;
    setHistoryLoadingId(cronId);
    setActionError(null);
    try {
      const runs = await props.onListRuns(cronId);
      setHistoryByCron((current) => new Map(current).set(cronId, runs));
    } catch (cause) {
      handleError(cause);
      setOpenHistoryId(null);
    } finally {
      setHistoryLoadingId(null);
    }
  };

  const remove = async (cron: ProjectCronView): Promise<void> => {
    setBusyId(cron.id);
    setActionError(null);
    try {
      await props.onDeleteCron(cron.id, cron.revision);
      setItems((current) => current.filter((item) => item.id !== cron.id));
      setConfirmDeleteId(null);
      if (openHistoryId === cron.id) setOpenHistoryId(null);
    } catch (cause) {
      handleError(cause);
    } finally {
      setBusyId(null);
    }
  };

  const editorView = editor ?? lastEditor.current;
  const deleteView = deleting ?? lastDelete.current;

  return <PageCanvas>
    <PageHeader
      kicker="Automation"
      title="Crons"
      description="Project-owned schedules talk to the project agent or any workspace’s canonical agent."
      actions={<Button variant="primary" type="button" onClick={() => setEditor({ kind: 'create' })} leadingIcon={glyph(Plus)}>New cron</Button>}
    />

    <section aria-label="Project cron summary" className={`${shape.container} mb-6 flex flex-col bg-surface-2 shadow-surface-1`}>
      <div className="grid grid-cols-3 divide-x divide-border">
        <Stat value={armed} label="Armed" />
        <Stat value={targetCount} label="Agent targets" />
        <Stat value={failures} label="Blocked / failed" />
      </div>
      <p className="border-t border-border px-5 py-3 text-caption text-muted-foreground">Scheduled in GitSpace Cloud · each run executes on whichever machine holds its target.</p>
    </section>

    {props.loadError || actionError ? <p role="alert" className="mb-4 text-caption text-destructive">{props.loadError ?? actionError}</p> : null}

    <section aria-label="Project crons">
      {props.loading ? <EmptyState title="Loading schedules…" description="Reading project cron authority." />
        : items.length === 0 ? <EmptyState title="No project crons" description="Create a schedule to prompt a canonical project or workspace agent." action={<Button variant="secondary" type="button" onClick={() => setEditor({ kind: 'create' })} leadingIcon={glyph(Plus)}>Create the first cron</Button>} />
        : <CardGroup border="outlined" separated proximityHover={false} className="gap-4">
          {items.map((cron, index) => {
            const currentTargetKey = projectCronTargetKey(cron.target);
            const currentTargetAvailable = targetOptions.some((option) => projectCronTargetKey(option.target) === currentTargetKey);
            const historyOpen = openHistoryId === cron.id;
            const busy = busyId === cron.id;
            const attention = cron.state === 'blocked' || cron.state === 'failed';
            return <Card key={cron.id} index={index}>
              <CardHeader>
                <CardTitle><span className="flex items-center gap-2">{cron.name}<Badge variant="dot" size="compact" color={CRON_STATE_COLOR[cron.state]}>{cron.state}</Badge></span></CardTitle>
                <CardDescription><span className="font-mono text-foreground">{cron.schedule}</span> · project cron · revision <span className="tabular-nums">{cron.revision}</span></CardDescription>
                <CardAction>
                  <div className="flex items-center gap-2">
                    <Switch label="Armed" checked={cron.enabled} disabled={busy} onToggle={() => void toggleEnabled(cron)} />
                    <DropdownMenu>
                      <DropdownTrigger render={<Button variant="ghost" size="icon" type="button" aria-label={`Actions for ${cron.name}`} disabled={busy}><DotsHorizontal width={16} height={16} strokeWidth={1.5} /></Button>} />
                      <DropdownContent align="end" className="min-w-[200px] w-[200px]">
                        <MenuItem index={0} icon={glyph(Play)} label="Run now" onSelect={() => void runNow(cron)} />
                        <MenuItem index={1} icon={glyph(Edit03)} label="Edit" onSelect={() => setEditor({ kind: 'edit', cron })} />
                        <MenuItem index={2} icon={glyph(Trash01)} label="Delete" onSelect={() => setConfirmDeleteId(cron.id)} />
                      </DropdownContent>
                    </DropdownMenu>
                  </div>
                </CardAction>
              </CardHeader>
              <CardContent>
                <dl className="grid grid-cols-2 gap-x-6 gap-y-3">
                  <div className="col-span-2 flex flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Talk to</dt>
                    <dd><Select disabled={busy} value={currentTargetKey} onValueChange={(value) => void chooseTarget(cron, value)}><SelectTrigger aria-label={`Talk to for ${cron.name}`} />{selectOptions([...(!currentTargetAvailable ? [{ value: currentTargetKey, label: `Unavailable · ${cron.target.scope === 'workspace' ? cron.target.spaceId : cron.target.projectId}` }] : []), ...targetOptions.map((option) => ({ value: projectCronTargetKey(option.target), label: option.label }))])}</Select></dd>
                  </div>
                  <div className="col-span-2 flex flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Description</dt>
                    <dd className="text-body text-foreground">{cron.description || 'No description supplied.'}</dd>
                  </div>
                  <div className="col-span-2 flex flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Runs on</dt>
                    <dd className="text-body text-foreground"><code className="font-mono">{props.holders?.[cron.target.scope === 'workspace' ? cron.target.spaceId : cron.target.projectId] ?? 'the target’s machine'}</code></dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Next run</dt>
                    <dd className="text-body tabular-nums text-foreground">{cron.enabled ? formatProjectCronTime(cron.nextRunAt) : 'Paused'}</dd>
                  </div>
                  <div className="flex flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Last run</dt>
                    <dd className="flex items-center gap-2 text-body tabular-nums text-foreground">{formatProjectCronTime(cron.lastRunAt)}{cron.lastRunState ? <Badge variant="dot" size="compact" color={RUN_STATE_COLOR[cron.lastRunState]}>{cron.lastRunState}</Badge> : null}</dd>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Read</dt>
                    <dd className="truncate font-mono text-caption text-foreground">{cron.readScopes.length > 0 ? cron.readScopes.join(', ') : 'none'}</dd>
                  </div>
                  <div className="flex min-w-0 flex-col gap-1">
                    <dt className="text-caption font-medium text-muted-foreground">Write</dt>
                    <dd className="truncate font-mono text-caption text-foreground">{cron.writeScopes.length > 0 ? cron.writeScopes.join(', ') : 'none'}</dd>
                  </div>
                </dl>
                {cron.statusMessage ? <p className={`pt-3 text-caption ${attention ? 'text-destructive' : 'text-muted-foreground'}`}>{cron.statusMessage}</p> : null}
              </CardContent>
              <CardFooter>
                <Button variant="ghost" size="compact" type="button" aria-expanded={historyOpen} onClick={() => void toggleHistory(cron.id)} leadingIcon={glyph(ClockRewind)}>Run history{historyOpen ? <ChevronUp width={14} height={14} strokeWidth={1.5} /> : <ChevronDown width={14} height={14} strokeWidth={1.5} />}</Button>
              </CardFooter>
              {historyOpen ? <section aria-label={`${cron.name} run history`} className="flex flex-col gap-2 px-4 pt-3">
                <div className="flex items-center justify-between gap-3"><strong className="text-body font-semibold text-foreground">Run history</strong><span className="text-caption text-muted-foreground">Append-only project authority</span></div>
                {historyLoadingId === cron.id ? <p className="py-3 text-caption text-muted-foreground">Loading run history…</p> : <CronRunHistory runs={historyByCron.get(cron.id) ?? []} />}
              </section> : null}
            </Card>;
          })}
        </CardGroup>}
    </section>

    <Dialog open={editor !== null} onOpenChange={(open) => { if (!open) setEditor(null); }}>
      <DialogContent size="lg">
        <CronEditor
          key={editorView.kind === 'edit' ? `${editorView.cron.id}:${editorView.cron.revision}` : 'create'}
          projectId={props.projectId}
          source={editorView.kind === 'edit' ? editorView.cron : undefined}
          options={targetOptions}
          onCancel={() => setEditor(null)}
          onSave={async (draft) => {
            if (editorView.kind === 'edit') {
              const updated = await props.onUpdateCron(editorView.cron.id, editorView.cron.revision, draft);
              setItems((current) => current.map((item) => item.id === updated.id ? updated : item));
            } else {
              const created = await props.onCreateCron(draft);
              setItems((current) => [...current, created].sort((left, right) => left.name.localeCompare(right.name)));
            }
            setEditor(null);
          }}
        />
      </DialogContent>
    </Dialog>

    <Dialog open={confirmDeleteId !== null} onOpenChange={(open) => { if (!open) setConfirmDeleteId(null); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {deleteView?.name ?? 'cron'}</DialogTitle>
          <DialogDescription>The schedule and its run history leave the project cron authority. This cannot be undone.</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="secondary" type="button" onClick={() => setConfirmDeleteId(null)}>Cancel</Button>
          <Button variant="primary" type="button" loading={deleteView !== null && busyId === deleteView.id} onClick={() => { if (deleteView) void remove(deleteView); }}>Confirm delete</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </PageCanvas>;
}
