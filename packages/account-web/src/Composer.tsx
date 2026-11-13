import type { SkillView } from '@gitspace/protocol';
import { automationEventCount, parseAutomationMessage, type AutomationMessage } from '@gitspace/protocol/automations-contract';
import { captureMention, captureMentionIds, parseBrowserShareLink, withoutCaptureSummaries, type RuntimeBrowserCaptureView, type RuntimeBrowserConnectedTab, type RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import { CHAT_ATTACHMENT_ACCEPT, chatAttachmentTag } from '@gitspace/protocol-runtime/chat-attachments';
import type { RuntimeMessageDecision, RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Button, Dropdown, DropdownContent, DropdownMenu, DropdownTrigger, InputMessage, MenuItem, Select, SelectContent, SelectItem, SelectTrigger, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, badgeColors, useIcons, useShape, type IconName, type QueuedMessage } from '@gitspace/ui';
import { Attachment01, CpuChip01, DotsHorizontal, XClose, Zap } from '@untitledui/icons';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { connectedTabText, TabChip } from './connected-tab.js';
import { CaptureChip } from './capture-chip.js';
import { glyph } from './glyph.js';
import type { AgentScopeView, GitSpaceShellProps, ProviderAuthView, SessionControlsProps } from './GitSpaceShell.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { SessionTreeExplorer } from './SessionTreeExplorer.js';
import { ModelCombobox, modelOptions } from './ModelCombobox.js';
import { automationsUrl, navigateProductUrl, setProductRoute } from './routes.js';
import { useInference } from './InferenceContext.js';
import type { WorkspaceDraftBinding } from './workspace-draft.js';
import { uploadArtifactFile, uploadRejection, type ArtifactUploadClient } from './inspector/artifact-upload.js';
import { previewShare } from './share/share-client.js';
import { StagedChips, stagedMessage, useComposerStaging } from './chat/staging.js';
import { OutgoingMessages, useOutbox, type Outbox, type OutgoingMessage, type SentMessage } from './chat/outbox.js';
import { DictationControl } from './chat/dictation.js';

export type SendBehavior = 'steer' | 'followUp';

function options(items: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{items.map((item, index) => <SelectItem value={item.value} index={index} key={item.value}>{item.label}</SelectItem>)}</SelectContent>;
}

export type ShareLink = { text: string; shareId: string; secret: string };
type ShareChip = { state: 'reading' } | { state: 'ready'; preview: RuntimeBrowserSharePreview } | { state: 'failed'; message: string };
const SHARE_ENDED: Record<NonNullable<RuntimeBrowserSharePreview['ended']>, string> = { revoked: 'Sharing stopped', expired: 'This share expired', closed: 'The shared tab was closed' };

/** Why a pasted share can no longer connect: it ended or its time ran out. Null while it may. */
function shareEnded(chip: ShareChip | undefined): string | null {
  if (chip?.state !== 'ready') return null;
  if (chip.preview.ended) return SHARE_ENDED[chip.preview.ended];
  return Date.parse(chip.preview.expiresAt) <= Date.now() ? SHARE_ENDED.expired : null;
}

/** The share links of this account in `text` (whitespace-separated words), each once. */
function shareLinksIn(text: string): ShareLink[] {
  const links = new Map<string, ShareLink>();
  for (const word of text.match(/\S+/gu) ?? []) {
    const link = parseBrowserShareLink(word, window.location.origin);
    if (link) links.set(word, { text: word, ...link });
  }
  return [...links.values()];
}

/** The greeting of a pasted share link (asked as this browser's device, so it names the shared tab's Chrome), or why
 * there is none. */
async function readShareChip(link: ShareLink): Promise<ShareChip> {
  try {
    return { state: 'ready', preview: await previewShare(link.shareId, link.secret, true) };
  } catch (failure) {
    return { state: 'failed', message: rpcErrorMessage(failure, 'Read share link') };
  }
}

// ThinkingStep hides `pending` rows (the registry reveals steps as they
// happen); a plan needs its future tasks visible, so state rides the icon.
const STEP_ICON: Record<'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked', IconName> = { pending: 'circle', in_progress: 'loader', completed: 'check', abandoned: 'x', blocked: 'lock' };

/** The agent's plan, rendered with the registry's reasoning-steps component above the composer. */
function PlanSteps({ controls }: { controls: SessionControlsProps }) {
  const shape = useShape();
  const [open, setOpen] = useState(false);
  const tasks = controls.value.todos.flatMap((phase) => phase.tasks.map((task) => ({ phase: phase.name, ...task })));
  if (!tasks.length) return null;
  const completed = tasks.filter((task) => task.status === 'completed').length;
  return <ThinkingSteps open={open} onOpenChange={setOpen} className={`${shape.container} self-start bg-surface-3 shadow-surface-3 ${open ? 'w-full p-2' : 'w-fit'}`}>
    <ThinkingStepsHeader className="min-h-10">Plan · {completed}/{tasks.length}</ThinkingStepsHeader>
    <ThinkingStepsContent className="max-h-[min(calc(var(--app-viewport-height,100dvh)*0.4),24rem)] overflow-y-auto overscroll-contain">
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

/** An automation run's message waiting in the conversation's inbox: GitHub's events, not the person's words, delivered
 * as one message when the turn ends. Later events of its run join it while it waits. */
function AutomationQueueRow({ message, dismissing, onDeliver, onDismiss, onOpen }: { message: AutomationMessage; dismissing: boolean; onDeliver(): void; onDismiss(): void; onOpen: (() => void) | null }) {
  const shape = useShape();
  return <li aria-label={`Automation ${message.name}`} className={`${shape.container} flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 bg-surface-3 py-1.5 pl-2.5 pr-1.5 shadow-surface-1`}>
    <span aria-hidden className="flex size-6 shrink-0 items-center justify-center rounded-full" style={{ color: badgeColors.amber, background: `color-mix(in oklab, ${badgeColors.amber} 14%, transparent)` }}><Zap width={14} height={14} strokeWidth={1.75} /></span>
    <span className="flex min-w-0 flex-[1_1_12rem] flex-col">
      <span className="truncate text-caption font-medium text-foreground">{[message.name, message.subject].filter(Boolean).join(' · ')}</span>
      <span className="text-caption text-muted-foreground">{automationEventCount(message.events)} · delivered when this turn ends</span>
    </span>
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      <Button variant="ghost" size="compact" type="button" onClick={onDeliver}>Deliver now</Button>
      <Button variant="ghost" size="compact" type="button" loading={dismissing} disabled={dismissing} onClick={onDismiss}>Dismiss</Button>
      {onOpen ? <Button variant="ghost" size="compact" type="button" onClick={onOpen}>Open run</Button> : null}
    </span>
  </li>;
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

/** Credentials and connection actions always refer to the canonical profile for the next execution. */
function ProviderNotice({ provider, profileId }: { provider: ProviderAuthView; profileId?: string }) {
  const shape = useShape();
  return <div role="status" className={`${shape.container} flex items-center justify-between gap-3 bg-surface-3 px-3 py-2 text-caption shadow-surface-1`}>
    <span className="min-w-0 truncate text-foreground">{provider.name} isn’t connected in this inference profile</span>
    <Button variant="tertiary" size="compact" asChild><a href={`/inference?section=providers${profileId ? `&profile=${encodeURIComponent(profileId)}` : ''}`} onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); const url = setProductRoute(new URL(window.location.href), 'inference'); url.searchParams.set('section', 'providers'); if (profileId) url.searchParams.set('profile', profileId); navigateProductUrl(url); }}>Connect</a></Button>
  </div>;
}

export interface ComposerProps {
  workspace: Pick<AgentScopeView, 'id' | 'projectId' | 'kind' | 'phase'>;
  controls?: SessionControlsProps;
  providers?: readonly ProviderAuthView[];
  skills?: readonly SkillView[];
  running: boolean;
  onSend?: GitSpaceShellProps['onSend'];
  draft?: WorkspaceDraftBinding;
  /** Stores every attachment in the session's drive under `uploads/<date>/` before the message naming it is sent. */
  artifactUpload?: ArtifactUploadClient;
  pending: boolean;
  recovering?: boolean;
  error?: string;
  controlsError?: string;
  onRetryControls?: () => void;
  /** Runs a command of this workspace's session; with it, a share link of this account in the draft moves out of its
   * text into a tab chip, and the tab is connected to the workspace (`browserShareConnect`) before the message is sent. */
  sessionCommand?: (command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>;
  /** Holds each message from Enter until the transcript shows it; the transcript shows its messages. */
  outbox: Outbox;
}

/** A composer with no transcript beside it: the messages it is sending show above it until the session's queue or
 * `sent` (the person's messages, as a transcript would show them) has each. */
export function StandaloneComposer({ sent = [], ...props }: Omit<ComposerProps, 'outbox'> & { sent?: readonly SentMessage[] }) {
  const queue = props.controls?.value.queue;
  const arrivals = useMemo(() => ({ sent, queue: [...(queue?.steering ?? []), ...(queue?.followUp ?? [])], latest: true }), [sent, queue]);
  const outbox = useOutbox(arrivals);
  return <>
    <div className="mx-auto w-full max-w-xl"><OutgoingMessages outbox={outbox} /></div>
    <Composer {...props} outbox={outbox} />
  </>;
}

export function Composer({ workspace, controls, providers, skills = [], running, onSend, draft: workspaceDraft, artifactUpload, pending, recovering = false, error, controlsError, onRetryControls, sessionCommand, outbox }: ComposerProps) {
  const icons = useIcons();
  const inference = useInference();
  const assignment = inference?.state?.assignments.find((entry) => entry.projectId === workspace.projectId);
  const profile = inference?.state?.profiles.find((entry) => entry.id === assignment?.profileId);
  const inferenceUnavailable = inference !== null && !profile;
  const selectedModelKey = `${controls?.value.provider ?? ''}/${controls?.value.model ?? ''}`;
  const invalidModel = !!controls?.value.model && !controls.value.models.some((model) => `${model.provider}/${model.id}` === selectedModelKey);
  const [localMessage, setLocalMessage] = useState('');
  const message = workspaceDraft?.text ?? localMessage;
  const setMessage = workspaceDraft?.onChange ?? setLocalMessage;
  const [attachments, setAttachments] = useState<File[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // Files already stored by an earlier attempt to send them, so sending again does not store them twice.
  const stored = useRef(new WeakMap<File, { url: string; hash: string }>());
  // One message sends at a time, so they reach the runtime in the order they were sent.
  const sending = outbox.messages.some((outgoing) => outgoing.status === 'sending');
  const sharing = sessionCommand !== undefined;
  // Share links pasted into the draft, swapped out of its text into tab chips.
  const [tabs, setTabs] = useState<readonly ShareLink[]>([]);
  const [shareChips, setShareChips] = useState<ReadonlyMap<string, ShareChip>>(new Map());
  // The tabs the last message connected, for the line confirming they joined.
  const [joined, setJoined] = useState<readonly RuntimeBrowserConnectedTab[]>([]);
  const staging = useComposerStaging();
  useEffect(() => {
    if (!sharing) return;
    const links = shareLinksIn(message);
    if (!links.length) return;
    const words = new Set(links.map((link) => link.text));
    setTabs((current) => [...current, ...links.filter((link) => !current.some((tab) => tab.text === link.text))]);
    setMessage(message.replace(/(\S+)\s*/gu, (match: string, word: string) => words.has(word) ? '' : match));
  }, [message, sharing]);
  // Greetings are read once per link and kept while the composer is shown, so removing and pasting a link again does not reread it.
  useEffect(() => {
    const unread = tabs.filter((link) => !shareChips.has(link.text));
    if (!unread.length) return;
    setShareChips((current) => new Map([...current, ...unread.map((link): [string, ShareChip] => [link.text, { state: 'reading' }])]));
    for (const link of unread) void readShareChip(link).then((chip) => setShareChips((current) => new Map(current).set(link.text, chip)));
  }, [tabs]);
  // Captures mentioned in the draft (`capture://<id>`: the Browser tab's Mention, the extension's Copy mention), swapped
  // out of its text into chips, each named once the workspace's captures are read (null: not found or not readable).
  const [captures, setCaptures] = useState<readonly string[]>([]);
  const [captureViews, setCaptureViews] = useState<ReadonlyMap<string, RuntimeBrowserCaptureView | null>>(new Map());
  useEffect(() => {
    const ids = captureMentionIds(message);
    if (!ids.length) return;
    setCaptures((current) => [...current, ...ids.filter((id) => !current.includes(id))]);
    setMessage(message.replace(/capture:\/\/([0-9a-f-]{36})\s*/giu, (match: string, id: string) => ids.includes(id.toLowerCase()) ? '' : match));
  }, [message]);
  useEffect(() => {
    const unread = captures.filter((id) => !captureViews.has(id));
    if (!unread.length) return;
    const named = (views: readonly RuntimeBrowserCaptureView[]) => setCaptureViews((current) => new Map([...current, ...unread.map((id): [string, RuntimeBrowserCaptureView | null] => [id, views.find((view) => view.capture.captureId === id) ?? null])]));
    if (!sessionCommand) { named([]); return; }
    void sessionCommand({ type: 'browserCaptures' }).then((result) => named(result.browserCaptures ?? []), () => named([]));
  }, [captures]);
  // Sends a message of the outbox: each pasted tab joins this workspace, each file is stored in the drive, then the
  // message goes. A failure stays on the message.
  const send = async (outgoing: OutgoingMessage): Promise<void> => {
    if (!onSend) return;
    const progress = new Map(outgoing.files.map((file): [File, number] => [file, stored.current.has(file) ? file.size : 0]));
    outbox.update(outgoing.id, { status: 'sending', error: null, progress: outgoing.files.length ? new Map(progress) : null });
    try {
      const connected: RuntimeBrowserConnectedTab[] = [];
      if (sessionCommand) for (const { link } of outgoing.tabs) {
        const tab = (await sessionCommand({ type: 'browserShareConnect', shareId: link.shareId, secret: link.secret })).browserConnectedTab;
        if (!tab) throw new Error('The workspace did not connect the shared tab.');
        connected.push(tab);
      }
      // What the agent reads in place of the links and chips: the tabs, the captures (the workspace adds each one's
      // summary), then the message with the staged choices' lines.
      const lead = [...connected.map(connectedTabText), ...(outgoing.captures.length ? [outgoing.captures.map(({ id }) => captureMention(id)).join(' ')] : [])];
      const attached: string[] = [];
      const folder = `uploads/${new Date().toISOString().slice(0, 10)}`;
      // Sequential, like the Inspector's uploads: one chunk body in flight keeps requests under the Worker's size cap.
      for (const file of outgoing.files) {
        let artifact = stored.current.get(file);
        if (!artifact) {
          if (!artifactUpload) throw new Error('Files can only be attached in an open workspace.');
          try {
            artifact = await uploadArtifactFile(artifactUpload, file, { signal: new AbortController().signal, folder, onSession: (session) => { progress.set(file, session.received); outbox.update(outgoing.id, { progress: new Map(progress) }); } });
          } catch (failure) {
            throw new Error(`${file.name} did not upload: ${rpcErrorMessage(failure, 'Upload')}`);
          }
          stored.current.set(file, artifact);
          progress.set(file, file.size);
          outbox.update(outgoing.id, { progress: new Map(progress) });
        }
        attached.push(chatAttachmentTag({ name: file.name, url: artifact.url, type: file.type, size: file.size, hash: artifact.hash }));
      }
      let body = '';
      const deliver = async (message: string, decisions?: RuntimeMessageDecision[]) => {
        body = [[...lead, message].join('\n'), ...attached].join('\n\n');
        await onSend(body, 'followUp', outgoing.draft, decisions);
      };
      if (staging) await staging.deliver(outgoing.text, deliver);
      else await deliver(outgoing.text);
      outbox.update(outgoing.id, { status: 'sent', body, progress: null });
      setJoined(connected);
    } catch (failure) {
      outbox.update(outgoing.id, { status: 'failed', error: rpcErrorMessage(failure, 'Send message'), progress: null });
    }
  };
  // The composer empties at once for the next message; the sent one shows in the outbox until the transcript has it.
  const submit = (draft: string, draftAttachments: File[]): boolean => {
    const text = draft.trim();
    if ((!text && !staging?.chips.length) || !onSend || pending || recovering || inferenceUnavailable || sending) return false;
    const rejection = draftAttachments.length && !artifactUpload ? 'Files can only be attached in an open workspace.'
      : draftAttachments.flatMap((file) => { const reason = uploadRejection(file); return reason ? [`${file.name}: ${reason}`] : []; })[0];
    if (rejection) { setSubmitError(rejection); return false; }
    setSubmitError(null);
    setJoined([]);
    const outgoing = outbox.add({
      text,
      shown: staging ? stagedMessage(text, staging.chips) : text,
      files: draftAttachments,
      // A pasted share that ended is not connected.
      tabs: (sessionCommand ? tabs : []).flatMap((link) => {
        const chip = shareChips.get(link.text);
        if (shareEnded(chip) !== null) return [];
        const preview = chip?.state === 'ready' ? chip.preview : null;
        return [{ link, host: preview?.page.site ?? 'Shared tab', browser: preview?.browser ?? null }];
      }),
      captures: captures.map((id) => ({ id, name: captureViews.get(id)?.capture.name ?? 'Capture' })),
      draft: workspaceDraft?.capture(),
    });
    // The workspace draft empties without a save of its own: the runtime clears the sent draft once it accepts the send.
    if (workspaceDraft && outgoing.draft) workspaceDraft.accepted(outgoing.draft);
    else setLocalMessage('');
    setAttachments([]);
    setTabs([]);
    setCaptures([]);
    void send(outgoing);
    return true;
  };
  outbox.actions.current = {
    // The failed message's text, files, tabs and captures go back into the composer ahead of what was added since.
    edit(outgoing) {
      if (outgoing.text) setMessage(message.trim() ? `${outgoing.text}\n\n${message}` : outgoing.text);
      setAttachments((current) => [...outgoing.files, ...current.filter((file) => !outgoing.files.includes(file))]);
      setTabs((current) => [...outgoing.tabs.map(({ link }) => link).filter((link) => !current.some((tab) => tab.text === link.text)), ...current]);
      setCaptures((current) => [...outgoing.captures.map(({ id }) => id).filter((id) => !current.includes(id)), ...current]);
      outbox.remove(outgoing.id);
    },
    retry(outgoing) {
      if (!sending && !pending && !recovering) void send(outgoing);
    },
  };
  const runControl = (operation: Promise<void>): void => {
    setSubmitError(null);
    void operation.catch((failure) => setSubmitError(rpcErrorMessage(failure, 'Session control operation')));
  };

  // The cloud session owns the queue. The input reports human intent;
  // each edit/remove is reconciled against the canonical queue. Follow-ups
  // that are automation runs' messages show as their runs' rows instead.
  const { queue, automationRuns } = useMemo(() => {
    const followUps = (controls?.value.queue.followUp ?? []).map((text, index) => ({ text, index, automation: parseAutomationMessage(text) }));
    return {
      queue: [
        ...(controls?.value.queue.steering ?? []).map((text, index): QueuedMessage => ({ id: `steering:${index}`, text: withoutCaptureSummaries(text), files: [], kind: 'steering' })),
        ...followUps.flatMap(({ text, index, automation }): QueuedMessage[] => automation ? [] : [{ id: `followUp:${index}`, text: withoutCaptureSummaries(text), files: [], kind: 'followUp' }]),
      ],
      automationRuns: followUps.flatMap(({ index, automation }) => automation ? [{ index, message: automation }] : []),
    };
  }, [controls]);
  const onQueueChange = async (next: QueuedMessage[]): Promise<boolean | void> => {
    if (!controls) return false;
    setSubmitError(null);
    try {
      if (next.length === 0 && queue.length > 1) {
        // Clearing the session's queue drops automation runs' messages too: those stay, and the person's messages
        // are removed one by one, last first, so the indexes still to remove stay put.
        if (!automationRuns.length) await controls.onClearQueue();
        else for (const item of [...queue].reverse()) if (item.kind) await controls.onRemoveQueuedMessage(item.kind, Number(item.id.split(':')[1]));
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
      if (added) return submit(added.text, added.files);
    } catch (failure) {
      setSubmitError(rpcErrorMessage(failure, 'Update message queue'));
      return false;
    }
  };
  const steerQueued = (item: QueuedMessage): void => {
    if (!controls || item.kind !== 'followUp') return;
    runControl(controls.onPromoteQueuedMessage(Number(item.id.split(':')[1])));
  };
  const [dismissing, setDismissing] = useState<string | null>(null);
  const dismissRun = (runId: string): void => {
    if (!controls) return;
    setSubmitError(null);
    setDismissing(runId);
    void controls.onDismissAutomationRun(runId)
      .catch((failure: unknown) => setSubmitError(rpcErrorMessage(failure, 'Dismiss automation run')))
      .finally(() => setDismissing(null));
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

  return <div className="pointer-events-none mx-auto flex w-full max-w-xl flex-col gap-2 [&>*]:pointer-events-auto">
    {controlsError ? <div role="alert" className="flex max-h-40 min-w-0 flex-col gap-2 overflow-y-auto rounded-lg bg-surface-3 p-3 text-caption shadow-surface-1"><p className="whitespace-pre-wrap break-words text-destructive">{controlsError}</p>{onRetryControls ? <Button variant="ghost" size="compact" className="self-start" disabled={pending} onClick={onRetryControls}>Retry provider catalog and controls</Button> : null}</div> : null}
    {!controlsError && inference && !profile ? <div className="flex flex-wrap items-center justify-between gap-2 text-caption">
      <span role="alert" className="text-destructive">{inference.loading ? 'Loading inference profile…' : inference.error ?? 'The project’s inference assignment is unavailable. Refresh before sending.'}<Button variant="ghost" size="compact" disabled={inference.loading} onClick={() => void inference.refresh()}>Refresh profiles</Button></span>
    </div> : null}
    {invalidModel ? <p role="status" className="text-caption text-muted-foreground">The selected model {selectedModelKey} is no longer available. The next run will use an authorized fallback and record the model change in the conversation.</p> : null}
    {controls && !controls.selectionReadOnly && !controls.value.model && controls.value.models.length > 0 ? <p role="status" className="text-caption text-destructive">No model: {controls.value.roleLabel ?? 'the Default role'} has none in this inference profile. Pick a model before sending.</p> : null}
    {controls ? <PlanSteps controls={controls} /> : null}
    {controls?.onReadHistory && showHistory ? <SessionTreeExplorer key={controls.value.sessionId} historyAnchorId={controls.value.historyAnchorId} onReadHistory={controls.onReadHistory} onNavigate={controls.onNavigateTree} onClose={() => setShowHistory(false)} /> : null}
    {message.startsWith('/') && commands.length ? <CommandPalette draft={message} commands={commands} onPick={(command) => { setMessage(''); command.run(); }} /> : null}
    {selectedProvider && !selectedProvider.hasAuth ? <ProviderNotice provider={selectedProvider} profileId={profile?.id} /> : null}
    {workspaceDraft?.error ? <p role="alert" className="text-caption text-destructive">{workspaceDraft.error}</p> : null}
    {joined.map((tab) => <p key={`${tab.pairingId}:${tab.targetId}`} role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><span aria-hidden className="size-2 shrink-0 rounded-full bg-foreground/40" />Tab connected: {URL.canParse(tab.url) ? new URL(tab.url).host : tab.url} joined this workspace&apos;s group in {tab.browser}. The agent may use it while it stays there.</p>)}
    {tabs.length ? <ul aria-label="Shared tabs" className="flex flex-col gap-1.5">{tabs.map((link) => {
      const chip = shareChips.get(link.text);
      const preview = chip?.state === 'ready' ? chip.preview : null;
      const ended = shareEnded(chip);
      const caption = ended ? `${ended} · it won't join this workspace`
        : chip?.state === 'failed' ? chip.message
        : preview && !preview.online ? `${preview.browser ?? 'Its Chrome'} is offline · open that Chrome to connect this tab`
        : preview ? 'Pasted tab link · joins this workspace when you send' : 'Reading the shared tab…';
      return <li key={link.text} aria-label={`Tab ${preview ? preview.page.title || preview.page.site : 'from a share link'}`} className="flex min-w-0 flex-wrap items-center gap-2">
        <TabChip host={preview?.page.site ?? 'Shared tab'} detail={preview?.browser ?? null} />
        <span className={`min-w-0 text-caption ${chip?.state === 'failed' ? 'text-destructive' : 'text-muted-foreground'}`}>{caption}</span>
        <Button variant="ghost" size="icon-compact" aria-label="Remove tab" onClick={() => setTabs((current) => current.filter((item) => item.text !== link.text))}><XClose width={14} height={14} /></Button>
      </li>;
    })}</ul> : null}
    {captures.length ? <ul aria-label="Mentioned captures" className="flex flex-wrap gap-1.5">{captures.map((id) => {
      const view = captureViews.get(id);
      const { steps, video, image } = view?.capture.tracks ?? {};
      const detail = !view ? (captureViews.has(id) ? 'not found in this workspace' : 'reading…') : steps ? `${steps.count} steps` : video ? 'video' : image ? 'screenshot' : 'capture';
      return <li key={id} aria-label={`Capture ${view?.capture.name ?? id}`} className="flex min-w-0 items-center gap-1">
        <CaptureChip name={view?.capture.name ?? 'Capture'} detail={detail} />
        <Button variant="ghost" size="icon-compact" aria-label="Remove capture" onClick={() => setCaptures((current) => current.filter((item) => item !== id))}><XClose width={14} height={14} /></Button>
      </li>;
    })}</ul> : null}
    {staging ? <StagedChips staging={staging} disabled={pending || sending} /> : null}
    {controls && automationRuns.length ? <ul aria-label="Automation runs waiting" className="flex flex-col gap-1.5">{automationRuns.map(({ index, message: run }) => <AutomationQueueRow key={run.run ?? `followUp:${index}`} message={run} dismissing={run.run !== null && dismissing === run.run}
      onDeliver={() => runControl(controls.onPromoteQueuedMessage(index))}
      onDismiss={() => { if (run.run === null) runControl(controls.onRemoveQueuedMessage('followUp', index)); else dismissRun(run.run); }}
      onOpen={run.run === null ? null : () => navigateProductUrl(automationsUrl(workspace.projectId, run.run))} />)}</ul> : null}
    <InputMessage
      data-slot="input-message"
      onBlurCapture={() => workspaceDraft?.onBlur()}
      value={message}
      onValueChange={setMessage}
      onSend={(text, files, meta) => { if (meta?.queuedId) return; submit(text, files); }}
      placeholder={recovering ? 'Recovering agent…' : staging?.chips.length ? 'Say why, or add context; your choices go with it…' : `Ask the ${workspace.kind === 'project' ? 'project' : 'workspace'} agent…`}
      sendable={!!staging?.chips.length}
      disabled={!onSend || recovering || inferenceUnavailable}
      busy={pending || sending}
      files={attachments}
      onFilesChange={setAttachments}
      accept={CHAT_ATTACHMENT_ACCEPT}
      maxFiles={8}
      history={controls?.value.history.map((entry) => withoutCaptureSummaries(entry.text)) ?? []}
      status={streaming ? 'streaming' : 'idle'}
      streamingSubmitBehavior="queue"
      queue={queue}
      onQueueChange={onQueueChange}
      autoDispatchQueue={false}
      onQueueSteer={steerQueued}
      onStop={controls ? () => runControl(controls.onStop()) : undefined}
      leftSlot={({ openFilePicker, insertText }) => <>
        <Button variant="ghost" size="icon-compact" type="button" aria-label="Attach files" onClick={() => openFilePicker()}><Attachment01 width={16} height={16} strokeWidth={1.5} /></Button>
        {onSend ? <DictationControl identity={{ projectId: workspace.projectId, workspaceId: workspace.id }} insertText={insertText} disabled={recovering} /> : null}
        {controls?.selectionReadOnly ? <span className="text-caption text-muted-foreground" title="This child’s admitted selection is read-only">{controls.value.roleLabel ?? controls.value.role ?? 'No role'} · {selectedModelKey} · {controls.value.thinking ?? 'auto'}</span> : controls ? <>
          <ModelCombobox size="compact" variant="borderless" side="top" icon={glyph(CpuChip01)} ariaLabel="Model" value={selectedModelKey}
            options={[...(invalidModel ? [{ value: selectedModelKey, label: `${selectedModelKey} · unavailable` }] : []), ...modelOptions(controls.value.models, true)]}
            onValueChange={(value) => { const selected = controls.value.models.find((model) => `${model.provider}/${model.id}` === value); if (selected) runControl(controls.onSetModel(selected.provider, selected.id)); }} />
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
            <MenuItem index={0} icon={icons.user} label={`Role: ${controls.value.roleLabel ?? 'Default'}`} disabled={controls.selectionReadOnly} onSelect={() => void controls.onCycleRole('forward')} closeOnClick={false} />
            <MenuItem index={1} icon={glyph(Zap)} label="Fast mode" checked={controls.value.fastMode} onSelect={() => void controls.onSetFast(!controls.value.fastMode)} />
            {workspace.kind === 'workspace' && workspace.phase === 'code' ? <MenuItem index={3} icon={icons.rocket} label="Goal mode" checked={!!controls.value.goal} onSelect={() => void controls.onSetGoal(!controls.value.goal)} /> : null}
            <MenuItem index={4} icon={icons['rotate-ccw']} label="Compact context" onSelect={() => void controls.onCompact()} />
            <MenuItem index={5} icon={icons.clock} label="Session history" disabled={!controls.onReadHistory} onSelect={() => setShowHistory((value) => !value)} />
            <MenuItem index={6} icon={icons.brain} label={`Thinking: ${controls.value.thinking ?? 'auto'}`} disabled={controls.selectionReadOnly} onSelect={() => { const next = thinkingLevels[(thinkingLevels.indexOf(controls.value.thinking ?? 'auto') + 1) % thinkingLevels.length]; void controls.onSetThinking(next === 'auto' ? null : next); }} closeOnClick={false} className="md:hidden" />
          </DropdownContent>
        </DropdownMenu>
      </> : null}
    />
    {error || submitError ? <p role="alert" className="text-caption text-destructive">{error ?? submitError}</p> : null}
  </div>;
}
