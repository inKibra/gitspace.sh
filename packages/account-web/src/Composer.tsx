import type { SkillView } from '@gitspace/protocol';
import { captureMention, captureMentionIds, parseBrowserShareLink, withoutCaptureSummaries, type RuntimeBrowserCaptureView, type RuntimeBrowserConnectedTab, type RuntimeBrowserSharePreview } from '@gitspace/protocol-runtime';
import type { RuntimeSessionCommand, RuntimeSessionResult } from '@gitspace/protocol-runtime/session-controls';
import { Button, Dropdown, DropdownContent, DropdownMenu, DropdownTrigger, InputMessage, MenuItem, Select, SelectContent, SelectItem, SelectTrigger, ThinkingStep, ThinkingSteps, ThinkingStepsContent, ThinkingStepsHeader, useIcons, useShape, type IconName, type QueuedMessage } from '@gitspace/ui';
import { Attachment01, CpuChip01, DotsHorizontal, XClose, Zap } from '@untitledui/icons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { connectedTabText, TabChip } from './connected-tab.js';
import { CaptureChip } from './capture-chip.js';
import { glyph } from './glyph.js';
import type { AgentScopeView, GitSpaceShellProps, ProviderAuthView, SessionControlsProps } from './GitSpaceShell.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { SessionTreeExplorer } from './SessionTreeExplorer.js';
import { ModelCombobox, modelOptions } from './ModelCombobox.js';
import { navigateProductUrl, setProductRoute } from './routes.js';
import { useInference } from './InferenceContext.js';
import type { WorkspaceDraftBinding } from './workspace-draft.js';
import { uploadArtifactFile, uploadRejection, type ArtifactUploadClient } from './inspector/artifact-upload.js';
import { previewShare } from './share/share-client.js';

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

type ShareLink = { text: string; shareId: string; secret: string };
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
  workspace: Pick<AgentScopeView, 'projectId' | 'kind' | 'phase'>;
  controls?: SessionControlsProps;
  providers?: readonly ProviderAuthView[];
  skills?: readonly SkillView[];
  running: boolean;
  onSend?: GitSpaceShellProps['onSend'];
  draft?: WorkspaceDraftBinding;
  /** Stores attachments that are not sent inline in the session's `uploads/` artifact folder. */
  artifactUpload?: ArtifactUploadClient;
  pending: boolean;
  recovering?: boolean;
  error?: string;
  controlsError?: string;
  onRetryControls?: () => void;
  /** Runs a command of this workspace's session; with it, a share link of this account in the draft moves out of its
   * text into a tab chip, and the tab is connected to the workspace (`browserShareConnect`) before the message is sent. */
  sessionCommand?: (command: RuntimeSessionCommand) => Promise<RuntimeSessionResult>;
}

export function Composer({ workspace, controls, providers, skills = [], running, onSend, draft: workspaceDraft, artifactUpload, pending, recovering = false, error, controlsError, onRetryControls, sessionCommand }: ComposerProps) {
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
  const [uploading, setUploading] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const sharing = sessionCommand !== undefined;
  // Share links pasted into the draft, swapped out of its text into tab chips.
  const [tabs, setTabs] = useState<readonly ShareLink[]>([]);
  const [shareChips, setShareChips] = useState<ReadonlyMap<string, ShareChip>>(new Map());
  // The tabs the last message connected, for the line confirming they joined.
  const [joined, setJoined] = useState<readonly RuntimeBrowserConnectedTab[]>([]);
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
  const submit = async (draft: string, draftAttachments: File[], behavior: SendBehavior = 'followUp'): Promise<boolean> => {
    const text = draft.trim();
    if (!text || !onSend || pending || recovering || inferenceUnavailable || uploading !== null || connecting) return false;
    setSubmitError(null);
    setJoined([]);
    const sentDraft = workspaceDraft?.capture();
    try {
      // Each pasted tab joins this workspace before the message naming it is sent; a share that ended is not connected.
      const connected: RuntimeBrowserConnectedTab[] = [];
      const links = sessionCommand ? tabs.filter((link) => shareEnded(shareChips.get(link.text)) === null) : [];
      if (sessionCommand && links.length) {
        setConnecting(true);
        try {
          for (const link of links) {
            const tab = (await sessionCommand({ type: 'browserShareConnect', shareId: link.shareId, secret: link.secret })).browserConnectedTab;
            if (!tab) throw new Error('The workspace did not connect the shared tab.');
            connected.push(tab);
          }
        } finally { setConnecting(false); }
      }
      // What the agent reads in place of the links and chips: the tabs, the captures (the workspace adds each one's
      // summary), then the message.
      const prompt = [...connected.map(connectedTabText), ...(captures.length ? [captures.map(captureMention).join(' ')] : []), text].join('\n');
      const files = draftAttachments.filter((file) => !file.type.startsWith('image/'));
      const uploads = files.filter((file) => !file.type.startsWith('text/') || file.size > 256 * 1024);
      const uploaded = new Map<File, string>();
      if (uploads.length) {
        if (!artifactUpload) throw new Error('Files other than images and small text files can only be attached in an open workspace.');
        for (const file of uploads) {
          const rejection = uploadRejection(file);
          if (rejection) throw new Error(`${file.name}: ${rejection}`);
        }
        // Sequential, like the Inspector's uploads: one chunk body in flight keeps requests under the Worker's size cap.
        for (const file of uploads) {
          setUploading(file.name);
          const artifact = await uploadArtifactFile(artifactUpload, file, { signal: new AbortController().signal, onSession: () => undefined });
          uploaded.set(file, artifact.url);
        }
      }
      const images = await Promise.all(draftAttachments.filter((file) => file.type.startsWith('image/')).map(imageAttachment));
      const attached = await Promise.all(files.map(async (file) => {
        const url = uploaded.get(file);
        if (url === undefined) return `<attachment name="${file.name}">\n${await file.text()}\n</attachment>`;
        return `<attachment name="${file.name}" url="${url}" type="${file.type || 'application/octet-stream'}" size="${file.size}" />`;
      }));
      await onSend([prompt, ...attached].join('\n\n'), behavior, images, sentDraft);
      if (workspaceDraft && sentDraft !== undefined) workspaceDraft.accepted(sentDraft);
      // The input sends its text trimmed; a link swapped out of the draft can leave a space behind.
      else setLocalMessage(current => current.trim() === text ? '' : current);
      setAttachments([]);
      setTabs([]);
      setCaptures([]);
      setJoined(connected);
      return true;
    } catch (failure) {
      setSubmitError(rpcErrorMessage(failure, 'Send message'));
      return false;
    } finally {
      setUploading(null);
    }
  };
  const runControl = (operation: Promise<void>): void => {
    setSubmitError(null);
    void operation.catch((failure) => setSubmitError(rpcErrorMessage(failure, 'Session control operation')));
  };

  // The cloud session owns the queue. The input reports human intent;
  // each edit/remove is reconciled against the canonical queue.
  const queue = useMemo<QueuedMessage[]>(() => controls
    ? [
      ...controls.value.queue.steering.map((text, index) => ({ id: `steering:${index}`, text: withoutCaptureSummaries(text), files: [], kind: 'steering' as const })),
      ...controls.value.queue.followUp.map((text, index) => ({ id: `followUp:${index}`, text: withoutCaptureSummaries(text), files: [], kind: 'followUp' as const })),
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
      setSubmitError(rpcErrorMessage(failure, 'Update message queue'));
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
        <Button variant="ghost" size="icon-compact" aria-label="Remove tab" disabled={connecting} onClick={() => setTabs((current) => current.filter((item) => item.text !== link.text))}><XClose width={14} height={14} /></Button>
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
    <InputMessage
      data-slot="input-message"
      onBlurCapture={() => workspaceDraft?.onBlur()}
      value={message}
      onValueChange={setMessage}
      onSend={(text, files, meta) => { if (meta?.queuedId) return; void submit(text, files); }}
      placeholder={recovering ? 'Recovering agent…' : `Ask the ${workspace.kind === 'project' ? 'project' : 'workspace'} agent…`}
      disabled={!onSend || pending || recovering || inferenceUnavailable || uploading !== null || connecting}
      files={attachments}
      onFilesChange={setAttachments}
      accept="image/png,image/jpeg,image/webp,text/*,application/pdf"
      maxFiles={8}
      history={controls?.value.history.map((entry) => withoutCaptureSummaries(entry.text)) ?? []}
      status={streaming ? 'streaming' : 'idle'}
      streamingSubmitBehavior="queue"
      queue={queue}
      onQueueChange={onQueueChange}
      autoDispatchQueue={false}
      onQueueSteer={steerQueued}
      onStop={controls ? () => runControl(controls.onStop()) : undefined}
      leftSlot={({ openFilePicker }) => <>
        <Button variant="ghost" size="icon-compact" type="button" aria-label="Attach files" onClick={() => openFilePicker()}><Attachment01 width={16} height={16} strokeWidth={1.5} /></Button>
        {controls?.selectionReadOnly ? <span className="text-caption text-muted-foreground" title="This child’s admitted selection is read-only">{controls.value.roleLabel ?? controls.value.role ?? 'No role'} · {selectedModelKey} · {controls.value.thinking ?? 'auto'}</span> : controls ? <>
          <ModelCombobox size="compact" variant="borderless" side="top" icon={glyph(CpuChip01)} ariaLabel="Model" value={selectedModelKey}
            options={[...(invalidModel ? [{ value: selectedModelKey, label: `${selectedModelKey} · unavailable` }] : []), ...modelOptions(controls.value.models)]}
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
    {uploading !== null ? <p role="status" className="text-caption text-muted-foreground">Uploading {uploading}…</p> : null}
    {connecting ? <p role="status" className="text-caption text-muted-foreground">Connecting the shared tab…</p> : null}
    {error || submitError ? <p role="alert" className="text-caption text-destructive">{error ?? submitError}</p> : null}
  </div>;
}
