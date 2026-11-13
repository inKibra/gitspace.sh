import { Button, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DropdownContent, DropdownMenu, DropdownTrigger, MenuItem, Select, SelectTrigger, Switch, useShape } from '@gitspace/ui';
import { Trash01 } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { AUTOMATION_EVENT_ACTIONS, AUTOMATION_EVENT_LABEL, AUTOMATION_GITHUB_EVENTS, AUTOMATION_MODES, AUTOMATION_START_LABELS, AUTOMATION_WATCH_EVERY_LABEL, AUTOMATION_WATCH_LABEL, automationAuthorEvents, automationConditionKinds, automationErrors, automationFields, describeAutomationSchedule, nextAutomationRunAt, parseAutomationSchedule, unknownAutomationPlaceholders, type AutomationAction, type AutomationCondition, type AutomationDraft, type AutomationGitHub, type AutomationMode, type AutomationRunView, type AutomationTest, type AutomationTrigger, type AutomationTriggerKind, type AutomationWatchEvery, type AutomationWatchOn, type AutomationView } from '@gitspace/protocol/automations-contract';
import { MODEL_ROLE_LABELS } from '@gitspace/protocol/inference';
import { formatRelativeTime } from '../relative-time.js';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { AuthorSection, Code, ConditionRow } from './AutomationConditions.js';
import { CheckList, TestResults } from './AutomationRuns.js';
import { type AutomationWorkspace } from './AutomationsPage.js';
import { Field, TextInput, options } from './automation-fields.js';
import { ACTION_LABEL, type ActionKind, type AuthorCondition, CONDITION_LABEL, DEFAULT_ROLE, DELIVERY_OPTIONS, EVENT_NOUN, type EventChoice, type FilterCondition, LABEL_MODE, MINUTES, MODE_LABEL, NEW_AUTOMATION_CRON, NEW_EVENT, PHASE_ACTIONS, PRESET_LABEL, PlayGlyph, PlusGlyph, RECENT_EVENTS, RECORDED_EVENT_LIMIT, SCHEDULE_PRESETS, type ScheduleChoice, TRIGGER_ACTIONS, TRIGGER_KINDS, TRIGGER_NOUN, TRIGGER_OPTION_LABEL, TestGlyph, WATCH_EVERY, WATCH_NOUN, WATCH_ONS, WEEKDAYS, conditionPhrase, formatUtc, missingValues, newCondition, phasesLabel, scheduleChoice, scheduleCron, settle, subjectNoun, twoDigits } from './automation-formatters.js';

type EditorField = 'name' | 'cron' | 'events' | 'conditions' | 'action' | 'mode' | 'role' | 'workspace' | 'instruction';
/** The `field` an `automationInvalid` error names, mapped to the editor control that shows it. */
const INVALID_FIELD: Record<string, EditorField> = {
  name: 'name', 'trigger.cron': 'cron', 'trigger.events': 'events', conditions: 'conditions', 'action.kind': 'action', 'action.mode': 'mode', 'action.role': 'role', 'action.workspaceId': 'workspace', 'action.instruction': 'instruction',
};

function editorFailure(cause: unknown, key: string, operation: string): { key: string; field: EditorField | null; message: string } {
  if (automationErrors.automationInvalid.is(cause)) return { key, field: INVALID_FIELD[cause.data.field] ?? null, message: cause.data.message };
  return { key, field: null, message: rpcErrorMessage(cause, operation) };
}

export function AutomationEditor({ projectId, workspaces, github, modelRoles, source, testFirst, now, onCancel, onSaved, onRan }: {
  projectId: string; workspaces: readonly AutomationWorkspace[]; github: AutomationGitHub; modelRoles: readonly string[]; source: AutomationView | null; testFirst: boolean; now: number;
  onCancel(): void; onSaved(): Promise<void>; onRan(run: AutomationRunView): Promise<void>;
}): ReactElement {
  const shape = useShape();
  const proposal = source?.proposal ?? null;
  const bot = github.bot ?? 'the GitSpace bot';
  const initialTrigger = source?.trigger.kind ?? (github.repository === null ? 'schedule' : 'github');
  const [name, setName] = useState(source?.name ?? '');
  const [triggerKind, setTriggerKind] = useState<AutomationTriggerKind>(initialTrigger);
  const [schedule, setSchedule] = useState<ScheduleChoice>(() => scheduleChoice(source?.trigger.kind === 'schedule' ? source.trigger.cron : NEW_AUTOMATION_CRON));
  const [events, setEvents] = useState<readonly EventChoice[]>(source?.trigger.kind === 'github' ? source.trigger.events : [NEW_EVENT]);
  const watchSource = source?.trigger.kind === 'watch' ? source.trigger : null;
  /** Blank watches this project's repository, or its upstream parent when it is a fork. */
  const [watchRepository, setWatchRepository] = useState(watchSource?.repository ?? '');
  const [watchOn, setWatchOn] = useState<AutomationWatchOn>(watchSource?.on ?? 'release');
  const [watchEvery, setWatchEvery] = useState<AutomationWatchEvery>(watchSource?.every ?? 'daily');
  const [conditions, setConditions] = useState<readonly AutomationCondition[]>(source?.conditions ?? []);
  const [actionKind, setActionKind] = useState<ActionKind>(source?.action.kind ?? (TRIGGER_ACTIONS[initialTrigger].includes('startWorkspace') ? 'startWorkspace' : 'messageProjectAgent'));
  const [mode, setMode] = useState<AutomationMode | null>(source?.action.kind === 'startWorkspace' ? source.action.mode : initialTrigger === 'label' ? null : 'review');
  const [role, setRole] = useState(source?.action.kind === 'startWorkspace' ? source.action.role ?? DEFAULT_ROLE : DEFAULT_ROLE);
  const [wake, setWake] = useState(source?.action.kind === 'sendToLinked' ? source.action.wake : true);
  const [orProjectAgent, setOrProjectAgent] = useState(source?.action.kind === 'sendToLinked' ? source.action.orProjectAgent : false);
  const [workspaceId, setWorkspaceId] = useState(source?.action.kind === 'messageWorkspace' ? source.action.workspaceId : '');
  const [instruction, setInstruction] = useState(source?.action.instruction ?? '');
  /** Null: every phase. */
  const [phases, setPhases] = useState<readonly AutomationMode[] | null>(source?.phases ?? null);
  const [deliveryChoice, setDeliveryChoice] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [pending, setPending] = useState<'save' | 'test' | 'run' | null>(null);
  const [failure, setFailure] = useState<{ key: string; field: EditorField | null; message: string } | null>(null);
  const [tested, setTested] = useState<{ key: string; deliveryId: string | null; value: AutomationTest } | null>(null);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  const instructionFocused = useRef(false);
  const caret = useRef<number | null>(null);
  const testSection = useRef<HTMLElement>(null);
  const testButton = useRef<HTMLButtonElement>(null);
  const eventTrigger = triggerKind === 'github' || triggerKind === 'label';
  const recordedQuery = useResultQuery(rpcClient.automations.events, { projectId, limit: RECORDED_EVENT_LIMIT }, { enabled: eventTrigger });
  const recorded = eventTrigger && recordedQuery.state === 'success' ? recordedQuery.value : [];

  useEffect(() => {
    const element = instructionRef.current;
    if (caret.current === null || !element) return;
    element.focus();
    element.setSelectionRange(caret.current, caret.current);
    caret.current = null;
  }, [instruction]);

  // Opened from a card's Test with a past event: the dialog's first focus lands on Test, with its section in view.
  useEffect(() => {
    if (!testFirst) return;
    testButton.current?.focus();
    testSection.current?.scrollIntoView({ block: 'nearest' });
  }, [testFirst]);

  const cron = scheduleCron(schedule);
  const parsed = triggerKind === 'schedule' ? parseAutomationSchedule(cron) : null;
  const cronError = parsed && 'error' in parsed ? parsed.error : null;
  const trigger: AutomationTrigger = triggerKind === 'github' ? { kind: 'github', events: events.map(entry => ({ event: entry.event, actions: [...entry.actions] })) }
    : triggerKind === 'watch' ? { kind: 'watch', repository: watchRepository.trim() || null, on: watchOn, every: watchEvery }
    : triggerKind === 'label' ? { kind: 'label' } : triggerKind === 'schedule' ? { kind: 'schedule', cron } : { kind: 'manual' };
  const offered = automationConditionKinds(trigger);
  // Conditions the chosen events do not offer stay out of the draft.
  const shownConditions = conditions.filter(condition => offered.includes(condition.kind));
  const filters = shownConditions.filter((condition): condition is FilterCondition => condition.kind !== 'people' && condition.kind !== 'bots');
  const authorEvents = automationAuthorEvents(trigger);
  const authorsQuery = useResultQuery(rpcClient.automations.authors, { projectId, events: [...authorEvents] }, { enabled: offered.includes('people') && authorEvents.length > 0 });
  const authors = offered.includes('people') && authorsQuery.state === 'success' ? authorsQuery.value : { people: [], bots: [] };
  const action: AutomationAction = actionKind === 'messageWorkspace' ? { kind: 'messageWorkspace', workspaceId, instruction }
    : actionKind === 'startWorkspace' ? { kind: 'startWorkspace', mode, ...(role === DEFAULT_ROLE ? {} : { role }), instruction }
      : actionKind === 'sendToLinked' ? { kind: 'sendToLinked', wake, orProjectAgent, instruction }
        : { kind: 'messageProjectAgent', instruction };
  // A person's automation runs at once; a proposal edited here is switched on when saved. Phases apply only to an action
  // that reaches a workspace by phase.
  const draft: AutomationDraft = { name: name.trim(), trigger, conditions: shownConditions, action, enabled: source === null || proposal !== null || source.enabled, ...(phases && PHASE_ACTIONS.includes(actionKind) ? { phases: [...phases] } : {}) };
  const key = JSON.stringify(draft);
  const savedKey = useRef(key).current;
  const unknown = unknownAutomationPlaceholders(instruction, trigger);
  const missingActions = triggerKind === 'github' ? events.filter(entry => AUTOMATION_EVENT_ACTIONS[entry.event].length > 0 && entry.actions.length === 0) : [];
  const emptyConditions = shownConditions.filter(missingValues);
  const incomplete = !draft.name || cronError !== null || missingActions.length > 0 || emptyConditions.length > 0 || (actionKind === 'messageWorkspace' && !workspaceId) || !instruction.trim() || unknown.length > 0;
  const errors: Partial<Record<EditorField, string>> = {};
  if (attempted && !draft.name) errors.name = 'Name the automation.';
  if (cronError) errors.cron = cronError;
  if (attempted && missingActions.length) errors.events = `Choose at least one action for ${missingActions.map(entry => AUTOMATION_EVENT_LABEL[entry.event].toLowerCase()).join(' and ')}.`;
  if (attempted && actionKind === 'messageWorkspace' && !workspaceId) errors.workspace = 'Choose the workspace to message.';
  if (unknown.length) errors.instruction = `${unknown.map(path => `{{${path}}}`).join(', ')} ${unknown.length === 1 ? 'is not a field' : 'are not fields'} of ${TRIGGER_NOUN[triggerKind]}. Insert a field to see the ones it has.`;
  else if (attempted && !instruction.trim()) errors.instruction = 'Write what the agent should do.';
  if (failure?.key === key && failure.field) errors[failure.field] = failure.message;
  const formError = failure?.key === key && failure.field === null ? failure.message : null;

  const choices = workspaces.filter(workspace => workspace.active || workspace.id === workspaceId);
  const nextRun = triggerKind === 'schedule' && cronError === null ? new Date(nextAutomationRunAt(cron, now)) : null;
  const unusedConditions = offered.filter(kind => kind !== 'people' && kind !== 'bots' && !shownConditions.some(condition => condition.kind === kind));
  const completeConditions = shownConditions.filter(condition => !missingValues(condition));
  const [onlyEvent] = events;
  const conditionsReadback = `Runs for ${triggerKind === 'watch' ? WATCH_NOUN[watchOn] : events.length === 1 && onlyEvent ? EVENT_NOUN[onlyEvent.event] : 'events'}${completeConditions.length ? ` ${completeConditions.map(condition => conditionPhrase(condition, bot)).join(', ')}` : ' of every kind'}.`;
  const modeChoices = [...(triggerKind === 'label' ? [{ value: LABEL_MODE, label: 'The label\'s mode' }] : []), ...AUTOMATION_MODES.map(entry => ({ value: entry, label: MODE_LABEL[entry] }))];
  // A saved role the profile no longer offers stays chosen until changed; saving it is refused.
  const roleChoices = [...modelRoles, ...(modelRoles.includes(role) ? [] : [role])].map(entry => ({ value: entry, label: MODEL_ROLE_LABELS[entry] ?? entry }));

  const chosenDelivery = deliveryChoice ?? recorded[0]?.deliveryId ?? RECENT_EVENTS;
  const delivery = eventTrigger && chosenDelivery !== RECENT_EVENTS ? chosenDelivery : null;
  const shownTest = tested?.key === key && tested.deliveryId === delivery ? tested : null;
  const [firstResult] = shownTest?.value.results ?? [];
  const saved = source !== null && proposal === null && key === savedKey;
  const canRun = saved && shownTest !== null && shownTest.deliveryId !== null && firstResult?.runs === true;

  const chooseTrigger = (value: string): void => {
    const kind = TRIGGER_KINDS.find(entry => entry === value);
    if (!kind) return;
    setTriggerKind(kind);
    if (!TRIGGER_ACTIONS[kind].includes(actionKind)) setActionKind('messageProjectAgent');
    if (kind === 'label') setMode(null);
    else if (mode === null) setMode('review');
  };
  const chooseEvent = (index: number, value: string): void => {
    const event = AUTOMATION_GITHUB_EVENTS.find(entry => entry === value);
    if (!event) return;
    setEvents(current => current.map((entry, at) => at === index ? { event, actions: AUTOMATION_EVENT_ACTIONS[event].slice(0, 1) } : entry));
  };
  const toggleAction = (index: number, action: string): void => setEvents(current => current.map((entry, at) => at === index
    ? { ...entry, actions: AUTOMATION_EVENT_ACTIONS[entry.event].filter(known => known === action ? !entry.actions.includes(action) : entry.actions.includes(known)) }
    : entry));
  const addEvent = (): void => {
    const event = AUTOMATION_GITHUB_EVENTS.find(entry => !events.some(chosen => chosen.event === entry));
    if (event) setEvents(current => [...current, { event, actions: AUTOMATION_EVENT_ACTIONS[event].slice(0, 1) }]);
  };
  /** Every phase pressed off one at a time; the last phase stays, and all four read as every phase. */
  const togglePhase = (phase: AutomationMode): void => {
    const chosen = phases ?? AUTOMATION_MODES;
    const next = AUTOMATION_MODES.filter(entry => entry === phase ? !chosen.includes(entry) : chosen.includes(entry));
    if (next.length) setPhases(next.length === AUTOMATION_MODES.length ? null : next);
  };

  const insertField = (path: string): void => {
    const token = `{{${path}}}`;
    const element = instructionRef.current;
    const start = element && instructionFocused.current ? element.selectionStart : instruction.length;
    const end = element && instructionFocused.current ? element.selectionEnd : instruction.length;
    caret.current = start + token.length;
    setInstruction(`${instruction.slice(0, start)}${token}${instruction.slice(end)}`);
  };

  const save = async (): Promise<void> => {
    setAttempted(true);
    if (incomplete || pending) return;
    setPending('save');
    try {
      const result = source
        ? await settle(rpcClient.automations.update({ projectId, automationId: source.id, draft }))
        : await settle(rpcClient.automations.create({ projectId, draft }));
      if (proposal && result.proposal) await settle(rpcClient.automations.approve({ projectId, automationId: result.id, revision: result.revision }));
      await onSaved();
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Save automation'));
    } finally {
      setPending(null);
    }
  };

  const test = async (): Promise<void> => {
    if (pending) return;
    setPending('test');
    try {
      const value = await settle(rpcClient.automations.test(delivery === null ? { projectId, draft } : { projectId, draft, deliveryId: delivery }));
      setTested({ key, deliveryId: delivery, value });
      setFailure(null);
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Test automation'));
    } finally {
      setPending(null);
    }
  };

  const runIt = async (): Promise<void> => {
    if (pending || !source || !canRun || delivery === null) return;
    setPending('run');
    try {
      await onRan(await settle(rpcClient.automations.runOnEvent({ projectId, automationId: source.id, deliveryId: delivery })));
    } catch (cause) {
      setFailure(editorFailure(cause, key, 'Run it'));
    } finally {
      setPending(null);
    }
  };

  const setPreset = (value: string): void => {
    const preset = SCHEDULE_PRESETS.find(entry => entry === value);
    if (!preset) return;
    setSchedule(current => ({ ...current, preset, custom: preset === 'custom' && current.preset !== 'custom' ? scheduleCron(current) : current.custom }));
  };
  const setClock = (value: string): void => {
    const match = /^(\d{2}):(\d{2})$/u.exec(value);
    if (!match) return;
    setSchedule(current => ({ ...current, hour: Number(match[1]), minute: Number(match[2]) }));
  };
  const clock = `${twoDigits(schedule.hour)}:${twoDigits(schedule.minute)}`;

  return <>
    <DialogHeader>
      <DialogTitle>{proposal ? 'Edit the proposal' : source ? 'Edit automation' : 'New automation'}</DialogTitle>
      <DialogDescription>{proposal ? 'Saving switches it on.' : 'When something happens in this project, start a workspace for it, send it to the workspace linked to it, or message an agent.'}</DialogDescription>
    </DialogHeader>
    <form id="automation-editor" noValidate className="flex min-w-0 flex-col gap-5" onSubmit={event => { event.preventDefault(); void save(); }}>
      <Field label="Name" error={errors.name}><TextInput label="Name" value={name} onChange={setName} invalid={errors.name !== undefined} placeholder="Review pull requests" /></Field>

      <section aria-label="When" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">When</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Trigger"><Select value={triggerKind} onValueChange={chooseTrigger}>
            <SelectTrigger aria-label="Trigger" />{options(TRIGGER_KINDS.map(kind => ({ value: kind, label: TRIGGER_OPTION_LABEL[kind] })))}
          </Select></Field>
          {triggerKind === 'schedule' ? <Field label="Repeats"><Select value={schedule.preset} onValueChange={setPreset}>
            <SelectTrigger aria-label="Repeats" />{options(SCHEDULE_PRESETS.map(preset => ({ value: preset, label: PRESET_LABEL[preset] })))}
          </Select></Field> : null}
          {triggerKind === 'label' ? <Field label="Labels"><span className={`${shape.input} min-h-9 border border-border bg-surface-2 px-2 py-2 font-mono text-caption`}>{Object.keys(AUTOMATION_START_LABELS).join(', ')}</span></Field> : null}
        </div>
        {triggerKind === 'github' ? <>
          <ul aria-label="Events" className="flex flex-col gap-3">
            {events.map((entry, index) => {
              const label = AUTOMATION_EVENT_LABEL[entry.event];
              const actions = AUTOMATION_EVENT_ACTIONS[entry.event];
              return <li key={entry.event} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-end gap-2">
                  <div className="min-w-0 flex-1 sm:max-w-[calc(50%-0.375rem)]"><Field label="Event"><Select value={entry.event} onValueChange={value => chooseEvent(index, value)}>
                    <SelectTrigger aria-label={`Event ${index + 1}`} />{options(AUTOMATION_GITHUB_EVENTS.filter(event => event === entry.event || !events.some(other => other.event === event)).map(event => ({ value: event, label: AUTOMATION_EVENT_LABEL[event] })))}
                  </Select></Field></div>
                  {events.length > 1 ? <Button variant="ghost" size="icon" type="button" aria-label={`Remove ${label}`} onClick={() => setEvents(current => current.filter((_, at) => at !== index))}><Trash01 width={14} height={14} strokeWidth={1.5} /></Button> : null}
                </div>
                {actions.length ? <div role="group" aria-label={`${label} actions`} className="flex flex-wrap gap-1.5">{actions.map(known => <Button key={known} size="compact" type="button" aria-pressed={entry.actions.includes(known)}
                  variant={entry.actions.includes(known) ? 'primary' : 'secondary'} onClick={() => toggleAction(index, known)}><span className="font-mono">{known}</span></Button>)}</div>
                  : <p className="text-caption text-muted-foreground">Every push</p>}
              </li>;
            })}
          </ul>
          {errors.events ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.events}</p> : null}
          {events.length < AUTOMATION_GITHUB_EVENTS.length ? <div><Button variant="ghost" size="compact" type="button" leadingIcon={PlusGlyph} onClick={addEvent}>Add an event</Button></div> : null}
        </> : null}
        {triggerKind === 'label' ? <p className="text-caption text-muted-foreground">Each label starts its own mode: <span className="font-mono">gitspace:plan</span> in Plan, <span className="font-mono">gitspace:code</span> in Code, <span className="font-mono">gitspace:review</span> in Review, <span className="font-mono">gitspace:ship</span> in Ship.</p> : null}
        {triggerKind === 'schedule' ? <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {schedule.preset === 'hourly' ? <Field label="At minute"><Select value={String(schedule.minute)} onValueChange={value => setSchedule(current => ({ ...current, minute: Number(value) }))}>
            <SelectTrigger aria-label="At minute" />{options(MINUTES.map(minute => ({ value: String(minute), label: `:${twoDigits(minute)}` })))}
          </Select></Field> : null}
          {schedule.preset === 'weekly' ? <Field label="On"><Select value={String(schedule.weekday)} onValueChange={value => setSchedule(current => ({ ...current, weekday: Number(value) }))}>
            <SelectTrigger aria-label="On" />{options(WEEKDAYS.map((day, index) => ({ value: String(index), label: day })))}
          </Select></Field> : null}
          {schedule.preset === 'daily' || schedule.preset === 'weekly' ? <Field label="At (UTC)"><TextInput label="At (UTC)" type="time" value={clock} onChange={setClock} /></Field> : null}
          {schedule.preset === 'custom' ? <div className="sm:col-span-2"><Field label="Cron expression (UTC)"><TextInput label="Cron expression (UTC)" value={schedule.custom} onChange={custom => setSchedule(current => ({ ...current, custom }))} invalid={errors.cron !== undefined} mono placeholder={NEW_AUTOMATION_CRON} /></Field></div> : null}
        </div> : null}
        {triggerKind === 'watch' ? <>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div className="sm:col-span-3"><Field label="Repository"><TextInput label="Blank: this project's repository" value={watchRepository} onChange={setWatchRepository} mono placeholder="owner/name" /></Field></div>
            <Field label="Watch for"><Select value={watchOn} onValueChange={value => { const on = WATCH_ONS.find(entry => entry === value); if (on) setWatchOn(on); }}>
              <SelectTrigger aria-label="Watch for" />{options(WATCH_ONS.map(on => ({ value: on, label: AUTOMATION_WATCH_LABEL[on] })))}
            </Select></Field>
            <Field label="Check"><Select value={watchEvery} onValueChange={value => { const every = WATCH_EVERY.find(entry => entry === value); if (every) setWatchEvery(every); }}>
              <SelectTrigger aria-label="Check" />{options(WATCH_EVERY.map(every => ({ value: every, label: AUTOMATION_WATCH_EVERY_LABEL[every] })))}
            </Select></Field>
          </div>
          <p aria-label="Watch readback" className="text-caption text-muted-foreground">
            {watchRepository.trim() ? <>Releases of <span className="font-mono">{watchRepository.trim()}</span> you choose to watch reach the agent as trusted. </> : 'Blank watches this project\'s repository, or its upstream parent when the project is a fork. '}
            Arrives at once when your GitHub App covers the repository and receives {watchOn === 'deployment' ? 'deployment statuses' : watchOn === 'tag' ? 'pushes' : 'releases'}; otherwise checked {AUTOMATION_WATCH_EVERY_LABEL[watchEvery].toLowerCase()}. Switching it on records what already exists, so it runs only on what comes after.
          </p>
        </> : null}
        {triggerKind === 'manual' ? <p className="text-caption text-muted-foreground">It runs only when you choose Run now on its card.</p> : null}
        {triggerKind === 'schedule' ? errors.cron
          ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.cron}</p>
          : <p aria-label="Schedule readback" className="text-caption text-muted-foreground"><span className="font-medium text-foreground">{describeAutomationSchedule(cron)}</span>{nextRun ? <> · next {formatUtc(nextRun)} ({formatRelativeTime(nextRun, now)})</> : null}</p>
          : null}
      </section>

      {triggerKind === 'github' || triggerKind === 'watch' ? <section aria-label="Only if" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">Only if</strong>
        <p aria-label="Conditions readback" className="text-body [overflow-wrap:anywhere]">{conditionsReadback}</p>
        {filters.length ? <ul aria-label="Filters" className="flex flex-col divide-y divide-border border-y border-border">
          {filters.map(condition => <ConditionRow key={condition.kind} condition={condition} bot={bot} missing={attempted && missingValues(condition)}
            onChange={next => setConditions(current => current.map(entry => entry.kind === next.kind ? next : entry))}
            onRemove={() => setConditions(current => current.filter(entry => entry.kind !== condition.kind))} />)}
        </ul> : null}
        {unusedConditions.length ? <div><DropdownMenu>
          <DropdownTrigger render={<Button variant="ghost" size="compact" type="button" leadingIcon={PlusGlyph}>Add a filter</Button>} />
          <DropdownContent align="start" className="min-w-[200px] w-[200px]">
            {unusedConditions.map((kind, index) => <MenuItem key={kind} index={index} label={CONDITION_LABEL[kind]} onSelect={() => setConditions(current => [...current.filter(entry => entry.kind !== kind), newCondition(kind)])} />)}
          </DropdownContent>
        </DropdownMenu></div> : null}
        {offered.includes('people') ? <div className="flex flex-col divide-y divide-border border-y border-border">
          {(['people', 'bots'] satisfies AuthorCondition['kind'][]).map(kind => {
            const condition = shownConditions.find((entry): entry is AuthorCondition => entry.kind === kind);
            return <AuthorSection key={kind} kind={kind} condition={condition} authors={authors[kind]} now={now} missing={attempted && condition !== undefined && missingValues(condition)}
              onChange={next => setConditions(current => [...current.filter(entry => entry.kind !== kind), ...(next ? [next] : [])])} />;
          })}
        </div> : null}
        {errors.conditions ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{errors.conditions}</p> : null}
        <p className="text-caption text-muted-foreground">Values can be patterns: <span className="font-mono">{triggerKind === 'watch' ? 'v*' : 'release/*'}</span>, <span className="font-mono">docs/**</span>.{triggerKind === 'watch' ? '' : ' Events from authors without write access who are not on the trust list never match.'}</p>
      </section> : null}

      <section aria-label="Then" className="flex min-w-0 flex-col gap-3">
        <strong className="text-body font-semibold">Then</strong>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Action" error={errors.action}><Select value={actionKind} onValueChange={value => { const kind = TRIGGER_ACTIONS[triggerKind].find(entry => entry === value); if (kind) setActionKind(kind); }}>
            <SelectTrigger aria-label="Action" />{options(TRIGGER_ACTIONS[triggerKind].map(kind => ({ value: kind, label: ACTION_LABEL[kind] })))}
          </Select></Field>
          {actionKind === 'startWorkspace' ? <Field label="Mode" error={errors.mode}><Select value={mode ?? LABEL_MODE} onValueChange={value => setMode(AUTOMATION_MODES.find(entry => entry === value) ?? null)}>
            <SelectTrigger aria-label="Mode" />{options(modeChoices)}
          </Select></Field> : null}
          {actionKind === 'startWorkspace' ? <Field label="Model role" error={errors.role}><Select value={role} onValueChange={setRole}>
            <SelectTrigger aria-label="Model role" />{options(roleChoices)}
          </Select></Field> : null}
          {actionKind === 'sendToLinked' ? <Field label="Delivery"><Select value={wake ? 'wake' : 'notice'} onValueChange={value => setWake(value === 'wake')}>
            <SelectTrigger aria-label="Delivery" />{options(DELIVERY_OPTIONS)}
          </Select></Field> : null}
          {actionKind === 'messageWorkspace' ? <Field label="Workspace" error={errors.workspace}><Select value={workspaceId} onValueChange={setWorkspaceId} disabled={choices.length === 0}>
            <SelectTrigger aria-label="Workspace" placeholder={choices.length ? 'Choose a workspace' : 'No open workspaces'} />{options(choices.map(workspace => ({ value: workspace.id, label: workspace.active ? workspace.name : `${workspace.name} (archived)` })))}
          </Select></Field> : null}
        </div>
        {actionKind === 'sendToLinked' ? <Switch label="When it has no linked workspace, send it to the project agent" checked={orProjectAgent} onToggle={() => setOrProjectAgent(current => !current)} /> : null}
        {PHASE_ACTIONS.includes(actionKind) ? <div className="flex min-w-0 flex-col gap-1.5">
          <span className="text-caption font-medium text-muted-foreground">Only while {actionKind === 'sendToLinked' ? 'the linked workspace' : 'the workspace'} is in</span>
          <div role="group" aria-label="Phases" className="flex flex-wrap gap-1.5">
            {AUTOMATION_MODES.map(entry => {
              const chosen = phases === null || phases.includes(entry);
              return <Button key={entry} size="compact" type="button" aria-pressed={chosen} variant={chosen ? 'primary' : 'secondary'} disabled={chosen && phases?.length === 1} onClick={() => togglePhase(entry)}>{MODE_LABEL[entry]}</Button>;
            })}
            <Button size="compact" type="button" aria-pressed={phases === null} variant={phases === null ? 'primary' : 'secondary'} onClick={() => setPhases(null)}>Every phase</Button>
          </div>
          <p aria-label="Phases readback" className="text-caption text-muted-foreground"><span className="font-medium text-foreground">{phasesLabel(phases)}</span>. A workspace in another phase skips it, unless you make an exception for that workspace and phase under By workspace.</p>
        </div> : null}
        <Field label="Instruction" error={errors.instruction}>
          <textarea ref={instructionRef} aria-label="Instruction" aria-invalid={errors.instruction !== undefined || undefined} rows={5} value={instruction}
            placeholder={eventTrigger ? 'What the agent should do, e.g. Review {{pull_request.html_url}} against {{pull_request.base.ref}}.' : 'What the agent should do, e.g. Check for outdated dependencies and open a pull request for the ones whose tests pass.'}
            onFocus={() => { instructionFocused.current = true; }}
            onChange={event => setInstruction(event.currentTarget.value)}
            className={`${shape.input} w-full min-w-0 resize-y border bg-surface-2 p-2 text-body text-foreground outline-none placeholder:text-muted-foreground focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] ${errors.instruction ? 'border-destructive' : 'border-border'}`} />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <DropdownMenu>
            <DropdownTrigger render={<Button variant="secondary" size="compact" type="button" leadingIcon={PlusGlyph}>Insert a field</Button>} />
            <DropdownContent align="start" className="min-w-[280px] w-[280px]">
              {automationFields(trigger).map((field, index) => <MenuItem key={field.path} index={index} label={`${field.label} · {{${field.path}}}`} onSelect={() => insertField(field.path)} />)}
            </DropdownContent>
          </DropdownMenu>
          <span className="min-w-0 text-caption text-muted-foreground">A field in <span className="font-mono">{'{{…}}'}</span> is {eventTrigger ? 'replaced by the event\'s value; Test with a past event shows the result.' : 'filled in when it runs; Test shows the result.'}</span>
        </div>
        {actionKind === 'startWorkspace' ? <p className="text-caption text-muted-foreground">The event arrives with the instruction as the workspace's first message, run with the chosen model role of the project's inference profile, and the workspace is linked to {subjectNoun(trigger)}.</p> : null}
      </section>

      {eventTrigger ? <section ref={testSection} aria-label="Test with a past event" className={`${shape.container} flex min-w-0 flex-col gap-3 border border-border p-4`}>
        <strong className="text-body font-semibold">Test with a past event</strong>
        <p className="text-caption text-muted-foreground">Runs the trigger and conditions against a delivery GitSpace recorded and shows what would happen. Nothing is started until you choose Run it.</p>
        <div className="flex flex-wrap items-end gap-2">
          <div className="min-w-0 flex-[1_1_16rem]"><Field label="Recorded event"><Select value={recorded.length ? chosenDelivery : ''} onValueChange={setDeliveryChoice} disabled={recorded.length === 0}>
            <SelectTrigger aria-label="Recorded event" placeholder={recordedQuery.state === 'pending' ? 'Loading recorded events…' : 'No recorded events yet'} />
            {options(recorded.length ? [...recorded.map(event => ({ value: event.deliveryId, label: `${event.label} · ${formatRelativeTime(event.receivedAt, now)}` })), { value: RECENT_EVENTS, label: 'Recent events this trigger starts on' }] : [])}
          </Select></Field></div>
          <Button ref={testButton} variant="secondary" type="button" leadingIcon={TestGlyph} loading={pending === 'test'} disabled={pending !== null} onClick={() => void test()}>Test</Button>
        </div>
        {recordedQuery.state === 'failure' && eventTrigger ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{rpcErrorMessage(recordedQuery.error, 'Read recorded events')}</p> : null}
        {shownTest ? <div className="flex flex-col gap-3 border-t border-border pt-3">
          {shownTest.deliveryId === null ? <TestResults results={shownTest.value.results} /> : <>
            {shownTest.value.checks.length ? <CheckList checks={shownTest.value.checks} /> : null}
            {firstResult ? <p aria-label="Test result" className="text-body [overflow-wrap:anywhere]">{firstResult.result}</p> : null}
            {firstResult?.runs ? <>
              <strong className="text-caption font-medium text-muted-foreground">Its first message:</strong>
              <blockquote aria-label="Rendered instruction" className={`${shape.input} whitespace-pre-wrap border border-border bg-surface-2 p-2 text-body [overflow-wrap:anywhere]`}>{shownTest.value.instruction}</blockquote>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" size="compact" type="button" leadingIcon={PlayGlyph} loading={pending === 'run'} disabled={!canRun || pending !== null} onClick={() => void runIt()}>Run it</Button>
                {canRun ? null : <span className="text-caption text-muted-foreground">{proposal ? 'Switch it on first to run it' : 'Save it first to run it'}</span>}
              </div>
            </> : null}
          </>}
        </div> : null}
      </section> : <section aria-label="Test" className={`${shape.container} flex min-w-0 flex-col gap-3 border border-border p-4`}>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="compact" type="button" leadingIcon={TestGlyph} loading={pending === 'test'} disabled={pending !== null || cronError !== null} onClick={() => void test()}>Test</Button>
          <span className="min-w-0 text-caption text-muted-foreground">{triggerKind === 'watch' ? 'Reads what the repository published lately and shows what it would do with each, and the instruction the agent would read. Nothing runs.' : 'Shows when it would run and the instruction the agent would read. Nothing runs.'}</span>
        </div>
        {shownTest ? <div className="flex flex-col gap-3 border-t border-border pt-3">
          <TestResults results={shownTest.value.results} />
          <strong className="text-caption font-medium text-muted-foreground">The agent reads</strong>
          <blockquote aria-label="Rendered instruction" className={`${shape.input} whitespace-pre-wrap border border-border bg-surface-2 p-2 text-body [overflow-wrap:anywhere]`}>{shownTest.value.instruction}</blockquote>
        </div> : null}
      </section>}
      {formError ? <p role="alert" className="text-caption text-destructive [overflow-wrap:anywhere]">{formError}</p> : null}
    </form>
    <DialogFooter>
      <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>
      <Button variant="primary" type="submit" form="automation-editor" loading={pending === 'save'} disabled={pending !== null}>{proposal ? 'Save and switch on' : source ? 'Save changes' : 'Create automation'}</Button>
    </DialogFooter>
  </>;
}
