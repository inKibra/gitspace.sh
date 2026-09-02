import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { AvailableModel, DeploymentStatusView, DeviceCapability, DeviceView, OmpSettingValue, UserSettings } from '@gitspace/protocol';
import type { ApiClientDraft } from './device.js';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardMedia,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Elevated,
  InputCopy,
  InputField,
  InputGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  Switch,
  TabsSubtle,
  TabsSubtleItem,
  TabsSubtlePanel,
  useShape,
} from '@gitspace/ui';
import { ArrowLeft, Check, CpuChip01, GitBranch01, Globe02, Key01, Monitor01, Rocket02, Server01, Settings02, Terminal, User01, Zap } from '@untitledui/icons';
import { glyph } from './glyph.js';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { ProvidersSection, type ProvidersSectionProps } from './ProvidersSection.js';
import { desiredLabel, machineRollup, RELEASE_STATUS_COLOR, RELEASE_TARGET_LABEL, shortSha, type ReleaseRecordView } from './release.js';

// `omp-providers` is the onboarding step for provider sign-in; in settings
// mode it is reached as `?section=omp-providers`, which opens the OMP section
// on its Providers tab.
type Section = 'profile' | 'omp' | 'omp-providers' | 'git' | 'machines' | 'connections' | 'hostnames' | 'source' | 'defaults';
const OMP_TABS = ['Models', 'Agents', 'Providers', 'Advanced'] as const;
type OmpTab = (typeof OMP_TABS)[number];
export interface SettingsMachineView { id: string; label: string; state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error'; kind: 'physical' | 'sandbox'; provider: 'physical' | 'cloudflare-sandbox'; notes: string; desiredState: 'online' | 'offline' | 'removed'; lifecycleRevision: number; operationId: string | null; error: string | null }
export interface OmpSettingView {
  path: string;
  tab: string;
  label: string;
  description: string | null;
  kind: 'boolean' | 'enum' | 'number' | 'string' | 'array' | 'record' | 'other';
  valueJson: string;
  options: readonly string[];
  credential: boolean;
}
export interface SettingsPageProps {
  mode: 'settings' | 'onboarding';
  settings: UserSettings;
  machines: readonly SettingsMachineView[];
  ompSettings: readonly OmpSettingView[];
  ompGeneration: number;
  providers: ProvidersSectionProps;
  /** Models runnable on this machine, for the role pickers. */
  models: readonly AvailableModel[];
  gitIdentity: { generation: number; publicKey: string; fingerprint: string; updatedAt: string; updatedBy: string } | null;
  onChange: (settings: UserSettings) => void;
  onSave: (settings: UserSettings) => Promise<void>;
  onSetOmpSetting: (path: string, value: OmpSettingValue) => Promise<void>;
  onUpdateMachine: (machineId: string, notes: string) => Promise<void>;
  onCreateSandbox: () => Promise<void>;
  onControlMachine: (action: 'sleep' | 'resume', machineId: string) => Promise<void>;
  onDestroyMachine: (machineId: string) => Promise<void>;
  /** Enrolled browsers and API clients; null while loading. */
  devices: readonly DeviceView[] | null;
  onRevokeDevice: (deviceId: string) => Promise<void>;
  /** Revoke this browser's own device and return to the enrollment screen. */
  onSignOut: () => Promise<void>;
  /** Mint a delegated API client from this browser; resolves to the one-time `gsk_` key. */
  onCreateApiClient: (draft: ApiClientDraft) => Promise<string>;
  /** Projects this account can scope an API client to. */
  projects: ReadonlyArray<{ id: string; name: string }>;
  onBack: () => void;
  onComplete: (settings: UserSettings) => Promise<void>;
  ompSync: { status: 'connecting' | 'synced' | 'offline' | 'conflict' | 'error'; message: string | null };
  /** What GitSpace runs here and across the fleet; null until the home machine answers. */
  deployment: DeploymentStatusView | null;
  /** Point the account back at our channel build; every target converges on it. */
  onRevertDeployment: () => Promise<void>;
  saving: boolean;
  error: string | null;
}

const ICONS = { user: glyph(User01), bot: glyph(Zap), cpu: glyph(CpuChip01), git: glyph(GitBranch01), server: glyph(Server01), monitor: glyph(Monitor01), globe: glyph(Globe02), settings: glyph(Settings02), key: glyph(Key01), rocket: glyph(Rocket02) };

// ── Composition helpers ──
// A settings list is an inline, outlined, separated CardGroup; each row is a
// compact Card whose trailing footer slot carries the control. CardGroup
// injects `index` into its direct children, so SettingRow forwards it.
function SettingRows({ children }: { children: ReactNode }) { return <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>{children}</CardGroup>; }
function SettingRow({ title, description, children, index }: { title: ReactNode; description?: ReactNode; children: ReactNode; index?: number }) {
  return <Card size="compact" index={index}>
    <CardHeader><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}</CardHeader>
    <CardFooter>{children}</CardFooter>
  </Card>;
}
function Group({ title, children }: { title: ReactNode; children: ReactNode }) { return <section className="flex flex-col gap-3"><h2 className="text-subtitle font-semibold text-foreground">{title}</h2>{children}</section>; }
function Panel({ title, description, children, footer }: { title: ReactNode; description?: ReactNode; children?: ReactNode; footer: ReactNode }) {
  const shape = useShape();
  return <Elevated offset={1} className={`${shape.container} flex flex-col gap-4 p-4`}>
    <div className="flex flex-col gap-1"><strong className="text-body font-semibold text-foreground">{title}</strong>{description ? <p className="text-caption text-muted-foreground">{description}</p> : null}</div>
    {children}
    <div className="flex items-center justify-end gap-2">{footer}</div>
  </Elevated>;
}
function TextField({ label, value, onChange, ...rest }: { label: string; value: string; onChange: (value: string) => void; type?: string; placeholder?: string; disabled?: boolean; autoComplete?: string; onBlur?: () => void }) {
  const { onBlur, ...input } = rest;
  return <InputGroup className="w-64" onBlur={onBlur}><InputField index={0} label={label} labelHidden value={value} onChange={onChange} {...input} /></InputGroup>;
}
function selectOptions(options: readonly { value: string; label: ReactNode }[]): ReactNode {
  return <SelectContent>{options.map((option, index) => <SelectItem value={option.value} index={index} key={option.value}>{option.label}</SelectItem>)}</SelectContent>;
}
function subtleTabs(items: readonly string[], value: string, onChange: (value: string) => void, idPrefix: string): ReactNode {
  const selectedIndex = Math.max(0, items.indexOf(value));
  return <TabsSubtle selectedIndex={selectedIndex} idPrefix={idPrefix} onSelect={(index) => onChange(items[index] ?? items[0] ?? '')}>{items.map((item, index) => <TabsSubtleItem index={index} label={item} key={item} />)}</TabsSubtle>;
}
function replace<T extends keyof UserSettings>(settings: UserSettings, key: T, value: UserSettings[T]): UserSettings { return { ...settings, [key]: value }; }
function icon(Icon: typeof Check, size = 16): ReactNode { return <Icon width={size} height={size} strokeWidth={1.5} />; }

function ProfileSettings({ settings, onChange }: Pick<SettingsPageProps, 'settings' | 'onChange'>) {
  const update = (field: keyof UserSettings['profile'], value: string | null) => onChange(replace(settings, 'profile', { ...settings.profile, [field]: value }));
  return <Group title="Identity"><SettingRows>
    <SettingRow title="Display name" description="Shown on your machines and shared work."><TextField label="Display name" value={settings.profile.displayName} placeholder="Your name" onChange={(value) => update('displayName', value)} /></SettingRow>
    <SettingRow title="GitSpace handle" description={settings.profile.handle ? 'Your permanent GitSpace account namespace.' : 'Globally reserves your permanent gitspace.sh namespace.'}>
      <TextField label="GitSpace handle" value={settings.profile.handle ?? ''} placeholder="handle" disabled={settings.profile.handle !== null} onChange={(value) => update('handle', value.toLowerCase().replace(/[^a-z0-9-]/g, '') || null)} />
      <span className="text-caption text-muted-foreground">.gitspace.sh</span>
    </SettingRow>
    <SettingRow title="Appearance" description="Light, dark, or follow the system. Applies on every machine.">{subtleTabs(['system', 'light', 'dark'], settings.defaults.appearance, (value) => onChange(replace(settings, 'defaults', { ...settings.defaults, appearance: value as UserSettings['defaults']['appearance'] })), 'appearance')}</SettingRow>
    <SettingRow title="Account storage" description="Settings are canonical in GitSpace Cloud."><Badge color="green"><span className="tabular-nums">Revision {settings.revision}</span></Badge></SettingRow>
  </SettingRows></Group>;
}

function parseValue(item: OmpSettingView): OmpSettingValue { return JSON.parse(item.valueJson) as OmpSettingValue; }
function settle(promise: Promise<void>): void { void promise.catch(() => undefined); }
function draftText(item: OmpSettingView, value: OmpSettingValue): string { return item.credential ? '' : typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value, null, 2); }
function OmpControl({ item, onSet, disabled }: { item: OmpSettingView; onSet: (value: OmpSettingValue) => Promise<void>; disabled: boolean }) {
  const shape = useShape();
  const value = parseValue(item);
  const [text, setText] = useState(draftText(item, value));
  useEffect(() => setText(draftText(item, value)), [item.valueJson, item.credential]);
  if (item.kind === 'boolean') return <Switch label="Enabled" checked={value === true} disabled={disabled} onToggle={() => settle(onSet(value !== true))} />;
  if (item.kind === 'enum') return <Select value={typeof value === 'string' ? value : ''} disabled={disabled} onValueChange={(next) => settle(onSet(next))}><SelectTrigger aria-label={item.label} />{selectOptions(item.options.map((option) => ({ value: option, label: option })))}</Select>;
  if (item.kind === 'number') return <TextField label={item.label} type="number" value={typeof value === 'number' ? String(value) : ''} disabled={disabled} onChange={(next) => settle(onSet(Number(next)))} />;
  if (item.kind === 'array' || item.kind === 'record') {
    // FLUID-GAP: multi-line JSON editor (no textarea/code editor in the registry)
    return <textarea aria-label={item.label} rows={4} value={text} disabled={disabled} className={`${shape.input} w-64 border border-border bg-surface-2 p-2 font-mono text-caption text-foreground disabled:opacity-50`} onChange={(event) => setText(event.currentTarget.value)} onBlur={() => { try { settle(onSet(JSON.parse(text) as OmpSettingValue)); } catch { /* keep invalid draft visible */ } }} />;
  }
  return <TextField label={item.label} type={item.credential ? 'password' : 'text'} value={text} placeholder={item.credential ? 'Enter a replacement value' : undefined} disabled={disabled} onChange={setText} onBlur={() => { if (!item.credential || text) settle(onSet(text)); }} />;
}
function OmpRows({ items, saving, onSetOmpSetting }: { items: readonly OmpSettingView[] } & Pick<SettingsPageProps, 'saving' | 'onSetOmpSetting'>) {
  return <SettingRows>{items.map((item) => <SettingRow key={item.path} title={item.label} description={item.description ?? item.path}><OmpControl item={item} disabled={saving} onSet={(value) => onSetOmpSetting(item.path, value)} /></SettingRow>)}</SettingRows>;
}
const THINKING_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'xhigh'] as const;
/** A model role is `provider/model[:thinking]`; the picker splits it into a model select and a thinking select. */
function RoleModelPicker({ role, label, value, models, disabled, onChange }: { role: string; label: string; value: string; models: readonly AvailableModel[]; disabled: boolean; onChange(value: string): void }) {
  const separator = value.lastIndexOf(':');
  const modelKey = separator > value.indexOf('/') ? value.slice(0, separator) : value;
  const thinking = separator > value.indexOf('/') ? value.slice(separator + 1) : 'auto';
  const known = models.some((model) => `${model.provider}/${model.id}` === modelKey);
  const options = [
    { value: '', label: role === 'task' ? 'Current session model' : 'Not set' },
    ...(modelKey && !known ? [{ value: modelKey, label: `${modelKey} (not available here)` }] : []),
    ...models.map((model) => ({ value: `${model.provider}/${model.id}`, label: `${model.name || model.id} · ${model.provider}` })),
  ];
  return <span className="flex items-center gap-2">
    <Select value={modelKey} disabled={disabled} onValueChange={(next) => onChange(next ? (thinking === 'auto' ? next : `${next}:${thinking}`) : '')}>
      <SelectTrigger aria-label={`Model for ${label}`} placeholder="Choose a model" />
      {selectOptions(options)}
    </Select>
    <Select size="compact" value={thinking} disabled={disabled || !modelKey} onValueChange={(next) => onChange(next === 'auto' ? modelKey : `${modelKey}:${next}`)}>
      <SelectTrigger variant="borderless" aria-label={`Thinking for ${label}`} />
      {selectOptions(THINKING_LEVELS.map((level) => ({ value: level, label: level })))}
    </Select>
  </span>;
}
function OmpSettings({ ompSettings, ompGeneration, onSetOmpSetting, saving, providers, models, initialTab }: Pick<SettingsPageProps, 'ompSettings' | 'ompGeneration' | 'ompSync' | 'onSetOmpSetting' | 'saving' | 'providers' | 'models'> & { initialTab: OmpTab }) {
  const [tab, setTab] = useState<OmpTab>(initialTab);
  const rolesItem = ompSettings.find((item) => item.path === 'modelRoles');
  const cycleItem = ompSettings.find((item) => item.path === 'cycleOrder');
  const overridesItem = ompSettings.find((item) => item.path === 'task.agentModelOverrides');
  const roles = rolesItem ? parseValue(rolesItem) as Record<string, string> : {};
  const cycle = cycleItem ? parseValue(cycleItem) as string[] : [];
  const overrides = overridesItem ? parseValue(overridesItem) as Record<string, string | string[]> : {};
  const roleLabels: Readonly<Record<string, string>> = { default: 'Default', task: 'Current model', slow: 'Thinking', smol: 'Fast', plan: 'Architect', designer: 'Designer', vision: 'Vision', commit: 'Commit', tiny: 'Tiny', advisor: 'Advisor' };
  const roleIds = [...new Set([...Object.keys(roleLabels), ...Object.keys(roles)])];
  const agentDefaults: Readonly<Record<string, string>> = { scout: 'smol', reviewer: 'slow', 'security-reviewer': 'slow', librarian: 'slow', task: 'task', designer: 'designer', sonic: 'tiny' };
  const agentNames = [...new Set([...Object.keys(agentDefaults), ...Object.keys(overrides)])];
  const advanced = ompSettings.filter((item) => item.path !== 'modelRoles' && item.path !== 'cycleOrder' && item.path !== 'task.agentModelOverrides' && !item.path.startsWith('providers') && !item.credential);
  const advancedGroups = useMemo(() => Map.groupBy(advanced, (item) => item.tab), [advanced]);
  const advancedTabs = [...advancedGroups.keys()].sort();
  const [advancedTab, setAdvancedTab] = useState(advancedTabs[0] ?? 'other');
  const providerSettings = ompSettings.filter((item) => item.path.startsWith('providers') || item.credential);
  const agentSettings = ompSettings.filter((item) => item.path.startsWith('agents') || (item.path.startsWith('task.agent') && item.path !== 'task.agentModelOverrides'));
  const setRole = async (role: string, model: string): Promise<void> => {
    if (rolesItem) await onSetOmpSetting(rolesItem.path, { ...roles, [role]: model });
  };
  const toggleCycle = async (role: string): Promise<void> => {
    if (!cycleItem) return;
    const next = cycle.includes(role) ? cycle.filter((candidate) => candidate !== role) : [...cycle, role];
    if (next.length) await onSetOmpSetting(cycleItem.path, next);
  };
  const setAgentRole = async (agent: string, role: string): Promise<void> => {
    if (overridesItem) await onSetOmpSetting(overridesItem.path, { ...overrides, [agent]: `pi/${role}` });
  };
  let content: ReactNode;
  if (tab === 'Models') {
    content = <Group title={<>Model roles · <span className="tabular-nums">generation {ompGeneration}</span></>}>
      <SettingRows>{roleIds.map((role) => <SettingRow key={role} title={roleLabels[role] ?? role} description={role}>
        <Switch label="Quick cycle" checked={cycle.includes(role)} disabled={saving || !cycleItem} onToggle={() => settle(toggleCycle(role))} />
        <RoleModelPicker role={role} label={roleLabels[role] ?? role} value={roles[role] ?? ''} models={models} disabled={saving || !rolesItem} onChange={(value) => settle(setRole(role, value))} />
      </SettingRow>)}</SettingRows>
      <p className="text-caption text-muted-foreground">Quick cycle controls one-click cycling. At least one role remains selected. Role names match the workspace composer.</p>
    </Group>;
  } else if (tab === 'Agents') {
    content = <>
      <Group title="Agent model roles"><SettingRows>{agentNames.map((agent) => { const selected = String(overrides[agent] ?? `pi/${agentDefaults[agent] ?? 'task'}`).replace(/^pi\//u, ''); return <SettingRow key={agent} title={agent} description={roleLabels[selected] ?? selected}><Select value={selected} disabled={!overridesItem || saving} onValueChange={(value) => settle(setAgentRole(agent, value))}><SelectTrigger aria-label={`Role for ${agent}`} />{selectOptions(roleIds.map((role) => ({ value: role, label: roleLabels[role] ?? role })))}</Select></SettingRow>; })}</SettingRows></Group>
      <Group title="Agent runtime settings"><OmpRows items={agentSettings} saving={saving} onSetOmpSetting={onSetOmpSetting} /></Group>
    </>;
  } else if (tab === 'Providers') {
    content = <>
      <ProvidersSection {...providers} />
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced" index={0}>
          <AccordionTrigger>Advanced provider settings</AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3 pb-2">
              <span className="text-caption text-muted-foreground">Raw OMP <code>providers.*</code> settings · <span className="tabular-nums">generation {ompGeneration}</span></span>
              <OmpRows items={providerSettings} saving={saving} onSetOmpSetting={onSetOmpSetting} />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>;
  } else {
    const visible = advancedGroups.get(advancedTab) ?? [];
    content = <>
      {subtleTabs(advancedTabs, advancedTab, setAdvancedTab, 'omp-advanced')}
      <TabsSubtlePanel index={Math.max(0, advancedTabs.indexOf(advancedTab))} selectedIndex={Math.max(0, advancedTabs.indexOf(advancedTab))} idPrefix="omp-advanced">
        <Group title={<>{advancedTab} · <span className="tabular-nums">generation {ompGeneration}</span></>}><OmpRows items={visible} saving={saving} onSetOmpSetting={onSetOmpSetting} /></Group>
      </TabsSubtlePanel>
    </>;
  }
  const tabIndex = OMP_TABS.indexOf(tab);
  return <>
    {subtleTabs(OMP_TABS, tab, (value) => setTab(value as OmpTab), 'omp-tabs')}
    <TabsSubtlePanel index={tabIndex} selectedIndex={tabIndex} idPrefix="omp-tabs" className="flex flex-col gap-8">{content}</TabsSubtlePanel>
  </>;
}
function OmpSyncBadge({ ompSync }: Pick<SettingsPageProps, 'ompSync'>) {
  return <Badge color={ompSync.status === 'synced' ? 'green' : ompSync.status === 'offline' || ompSync.status === 'connecting' ? 'gray' : 'amber'}>{ompSync.status === 'synced' ? <>Synced</> : ompSync.message ?? ompSync.status}</Badge>;
}

function GitSettings({ settings, gitIdentity, onChange }: Pick<SettingsPageProps, 'settings' | 'gitIdentity' | 'onChange'>) {
  const update = (field: keyof UserSettings['git'], value: string) => onChange(replace(settings, 'git', { ...settings.git, [field]: value }));
  return <>
    <Group title="Commit identity"><SettingRows>
      <SettingRow title="Author name" description="Applied to GitSpace repositories on every machine."><TextField label="Author name" value={settings.git.authorName} placeholder="Your name" onChange={(value) => update('authorName', value)} /></SettingRow>
      <SettingRow title="Author email" description="Applied to GitSpace repositories on every machine."><TextField label="Author email" type="email" value={settings.git.authorEmail} placeholder="you@example.com" onChange={(value) => update('authorEmail', value)} /></SettingRow>
    </SettingRows></Group>
    <Group title="SSH identity">
      {gitIdentity
        ? <SettingRows><Card size="compact"><CardMedia icon={ICONS.git} /><CardHeader><CardTitle>GitSpace Ed25519</CardTitle><CardDescription><span className="font-mono">{gitIdentity.fingerprint}</span> · <span className="tabular-nums">generation {gitIdentity.generation}</span></CardDescription></CardHeader><CardFooter><Badge color="green">Shared</Badge></CardFooter></Card></SettingRows>
        : <EmptyState icon={icon(GitBranch01, 20)} title="Git identity unavailable" description="The connected machine could not materialize the cloud identity." />}
      {gitIdentity ? <InputCopy value={gitIdentity.publicKey} label="Copy GitSpace public key" /> : null}
    </Group>
  </>;
}

const API_CLIENT_TTLS: ReadonlyArray<{ value: string; label: string; ms: number | null }> = [
  { value: 'never', label: 'Until revoked', ms: null },
  { value: '7d', label: '7 days', ms: 7 * 86_400_000 },
  { value: '30d', label: '30 days', ms: 30 * 86_400_000 },
  { value: '90d', label: '90 days', ms: 90 * 86_400_000 },
];
const API_CLIENT_CAPABILITIES: ReadonlyArray<{ id: DeviceCapability; label: string; description: string }> = [
  { id: 'rpc.read', label: 'Read', description: 'Queries and event streams' },
  { id: 'rpc.write', label: 'Write', description: 'Create and change workspaces, settings, crons' },
  { id: 'session.prompt', label: 'Talk to agents', description: 'Prompt, steer, and answer' },
  { id: 'fleet.control', label: 'Fleet', description: 'Create, sleep, resume, destroy machines' },
];

/** Mints a delegated API client; the key is shown once, then only its device row remains. */
function ApiClientDialog({ open, onOpenChange, projects, onCreate }: { open: boolean; onOpenChange: (open: boolean) => void; projects: ReadonlyArray<{ id: string; name: string }>; onCreate: (draft: ApiClientDraft) => Promise<string> }) {
  const [label, setLabel] = useState('');
  const [projectId, setProjectId] = useState('');
  const [capabilities, setCapabilities] = useState<DeviceCapability[]>(['rpc.read', 'session.prompt']);
  const [ttl, setTtl] = useState('never');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);
  const close = (next: boolean): void => {
    onOpenChange(next);
    if (!next) { setKey(null); setError(null); setLabel(''); }
  };
  const submit = async (): Promise<void> => {
    setPending(true);
    setError(null);
    try {
      setKey(await onCreate({
        label: label.trim(),
        scope: projectId ? { kind: 'project', projectId } : { kind: 'user' },
        capabilities,
        ttlMs: API_CLIENT_TTLS.find((option) => option.value === ttl)?.ms ?? null,
        rpcUrl: new URL(new URL(window.location.href).searchParams.get('rpc') ?? '/rpc', window.location.origin).toString(),
      }));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent>
      <DialogHeader><DialogTitle>{key ? 'API client created' : 'New API client'}</DialogTitle><DialogDescription>{key ? 'Copy the key now; it is not stored anywhere and cannot be shown again. Revoke it from this list at any time.' : 'A signed device key for scripts and services. It can do at most what this browser can, within the scope you choose.'}</DialogDescription></DialogHeader>
      {key
        ? <InputCopy label="API key" value={key} />
        : <form id="api-client-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <InputGroup className="w-full"><InputField index={0} label="Label" value={label} placeholder="CI deploy bot" onChange={setLabel} autoFocus required /></InputGroup>
            <SettingRows>
              <SettingRow title="Scope" description="Everything, or one project.">
                <Select value={projectId} onValueChange={(value) => setProjectId(value ?? '')}><SelectTrigger aria-label="Scope" />{selectOptions([{ value: '', label: 'Whole account' }, ...projects.map((project) => ({ value: project.id, label: project.name }))])}</Select>
              </SettingRow>
              {API_CLIENT_CAPABILITIES.map((capability) => <SettingRow key={capability.id} title={capability.label} description={capability.description}>
                <Switch label={capability.label} checked={capabilities.includes(capability.id)} onToggle={() => setCapabilities((current) => current.includes(capability.id) ? current.filter((id) => id !== capability.id) : [...current, capability.id])} />
              </SettingRow>)}
              <SettingRow title="Expires" description="Expired keys stop working without a revoke.">{subtleTabs(API_CLIENT_TTLS.map((option) => option.value), ttl, setTtl, 'api-client-ttl')}</SettingRow>
            </SettingRows>
            {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
          </form>}
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={() => close(false)}>{key ? 'Done' : 'Cancel'}</Button>
        {key ? null : <Button variant="primary" type="submit" form="api-client-form" loading={pending} disabled={!label.trim() || capabilities.length === 0}>Create key</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ConnectionsSettings({ devices, onRevokeDevice, onSignOut, onCreateApiClient, projects }: Pick<SettingsPageProps, 'devices' | 'onRevokeDevice' | 'onSignOut' | 'onCreateApiClient' | 'projects'>) {
  const [apiClientOpen, setApiClientOpen] = useState(false);
  return <>
    <Group title="Devices">
      {devices === null
        ? <EmptyState icon={icon(Monitor01)} title="Loading devices…" />
        : devices.length === 0
          ? <EmptyState icon={icon(Monitor01)} title="No devices enrolled" description="Browsers and API clients that hold a signed key for your account appear here." />
          : <SettingRows>{devices.map((device) => <SettingRow key={device.deviceId} title={<>{device.label}{device.current ? <Badge color="green">This browser</Badge> : null}</>} description={<>{device.kind === 'browser' ? 'Browser' : 'API client'} · {device.scope} · enrolled {new Date(device.boundAt).toLocaleString()}{device.expiresAt ? ` · expires ${new Date(device.expiresAt).toLocaleString()}` : ''}{device.revokedAt ? ` · revoked ${new Date(device.revokedAt).toLocaleString()}` : ''}</>}>
            {device.revokedAt
              ? <Badge color="gray">Revoked</Badge>
              : !device.active
                ? <Badge color="amber">Inactive</Badge>
              : device.current
                ? <Button variant="ghost" size="compact" onClick={() => { if (window.confirm('Sign out this browser? You will need a new enrollment link to reconnect.')) settle(onSignOut()); }}>Sign out</Button>
                : <Button variant="ghost" size="compact" onClick={() => { if (window.confirm(`Revoke ${device.label}? It will lose access within seconds.`)) settle(onRevokeDevice(device.deviceId)); }}>Revoke</Button>}
          </SettingRow>)}</SettingRows>}
      <div className="pt-3"><Button variant="secondary" size="compact" onClick={() => setApiClientOpen(true)} leadingIcon={glyph(Key01)}>New API client</Button></div>
      <ApiClientDialog open={apiClientOpen} onOpenChange={setApiClientOpen} projects={projects} onCreate={onCreateApiClient} />
    </Group>
  </>;
}

function MachineSettings({ machines, onUpdateMachine, onCreateSandbox, onControlMachine, onDestroyMachine }: Pick<SettingsPageProps, 'machines' | 'onUpdateMachine' | 'onCreateSandbox' | 'onControlMachine' | 'onDestroyMachine'>) {
  const shape = useShape();
  const [setup, setSetup] = useState(false);
  const [sandboxSetup, setSandboxSetup] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const editingMachine = machines.find((machine) => machine.id === editing) ?? null;
  return <>
    <Group title="Your machines">
      {machines.length ? <SettingRows>{machines.map((machine) => <Card key={machine.id} size="compact">
        <CardMedia icon={machine.kind === 'sandbox' ? ICONS.server : ICONS.monitor} />
        <CardHeader>
          <CardTitle>{machine.label}</CardTitle>
          <CardDescription>{machine.kind === 'sandbox' ? 'Cloud sandbox' : <span className="font-mono">{machine.id}</span>}{machine.notes ? <> · {machine.notes}</> : null}</CardDescription>
          {machine.error ? <p role="alert" className="text-caption text-destructive">{machine.error}</p> : null}
        </CardHeader>
        <CardFooter>
          <Badge color={machine.state === 'online' ? 'green' : machine.state === 'error' ? 'amber' : 'gray'}>{machine.state}</Badge>
          <Button variant="ghost" onClick={() => { setEditing(machine.id); setNotes(machine.notes); }}>Notes</Button>
          {machine.provider !== 'physical' && (machine.state === 'online' || machine.state === 'offline' || machine.state === 'error') ? <Button variant="ghost" onClick={() => settle(onControlMachine(machine.state === 'online' ? 'sleep' : 'resume', machine.id))}>{machine.state === 'online' ? 'Sleep' : 'Resume'}</Button> : null}
          {machine.provider !== 'physical' && machine.state !== 'deleting' ? <Button variant="ghost" onClick={() => { if (window.confirm(`Destroy ${machine.label}? This cannot be undone.`)) settle(onDestroyMachine(machine.id)); }}>Destroy</Button> : null}
        </CardFooter>
      </Card>)}</SettingRows>
        : <EmptyState icon={icon(Server01, 20)} title="No machines connected" description="Set up GitSpace from the computer you want to use." />}
      {editingMachine ? <Panel title={`Machine notes · ${editingMachine.label}`} description="Shared purpose, tools, constraints, and credential boundaries." footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => settle(onUpdateMachine(editingMachine.id, notes).then(() => setEditing(null)))}>Save notes</Button></>}>
        {/* FLUID-GAP: multi-line textarea (no textarea in the registry) */}
        <textarea aria-label="Machine notes" rows={4} value={notes} className={`${shape.input} w-full border border-border bg-surface-2 p-2 text-body text-foreground`} onChange={(event) => setNotes(event.currentTarget.value)} />
      </Panel> : null}
    </Group>
    {setup ? <Panel title="Set up a computer" description="Enrollment happens in the CLI; cloud fleet state updates after the machine connects." footer={<Button variant="secondary" onClick={() => setSetup(false)}>Done</Button>}>
      <ol className="flex flex-col gap-4">
        <li className="flex items-start gap-3"><Badge color="gray" className="tabular-nums">1</Badge><div className="flex min-w-0 flex-1 flex-col gap-2"><strong className="text-body font-semibold text-foreground">First computer</strong><InputCopy value="gssh user identity init && gssh user auth login && gssh web" /></div></li>
        <li className="flex items-start gap-3"><Badge color="gray" className="tabular-nums">2</Badge><div className="flex min-w-0 flex-1 flex-col gap-2"><strong className="text-body font-semibold text-foreground">Additional computer</strong><InputCopy value="gssh machine enroll --invite <token> && gssh machine serve start" /></div></li>
      </ol>
    </Panel> : sandboxSetup ? <Panel title="Create managed sandbox" description="Creates a Cloudflare Sandbox container, enrolls a managed 1.x machine identity, starts the GitSpace runtime, and waits for its RPC endpoint. Cloudflare usage charges may apply." footer={<><Button variant="secondary" onClick={() => setSandboxSetup(false)}>Cancel</Button><Button variant="primary" onClick={() => settle(onCreateSandbox().then(() => setSandboxSetup(false)))}>Create sandbox</Button></>} />
    : <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" onClick={() => setSetup(true)}>{icon(Terminal)}Add a computer</Button>
      <Button variant="secondary" onClick={() => setSandboxSetup(true)}>{icon(Server01)}Create sandbox</Button>
    </div>}
  </>;
}
function HostnameSettings({ settings }: Pick<SettingsPageProps, 'settings'>) {
  return <Group title="Account hostname">{settings.profile.handle
    ? <SettingRows><Card size="compact"><CardMedia icon={ICONS.globe} /><CardHeader><CardTitle>{settings.profile.handle}.gitspace.sh</CardTitle><CardDescription>Reserved by your cloud account</CardDescription></CardHeader><CardFooter><Badge color="green">Reserved</Badge></CardFooter></Card></SettingRows>
    : <EmptyState icon={icon(Globe02, 20)} title="No hostname reserved" description="Choose a handle in Profile to reserve its gitspace.sh namespace." />}</Group>;
}

/** `sha ?? 'stable'` plus the running generation, as one running-row badge. */
function RunningBadge({ sha, generation }: { sha: string | null; generation: string | null }) {
  return <Badge color={sha === null ? 'gray' : 'blue'}><span className="font-mono">{sha === null ? 'stable' : shortSha(sha)}{generation ? ` · ${generation.slice(0, 8)}` : ''}</span></Badge>;
}
function ReleaseRow({ release, desired, index }: { release: ReleaseRecordView; desired: boolean; index?: number }) {
  const machines = machineRollup(release);
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle>{release.label}{desired ? <Badge color="blue">Desired</Badge> : null}</CardTitle>
      <CardDescription><span className="font-mono">{shortSha(release.sha)}</span> · built {new Date(release.createdAt).toLocaleString()}{release.workspaceId ? ` · from workspace ${release.workspaceId}` : ''}</CardDescription>
      {release.error ? <p role="alert" className="text-caption text-destructive">{release.error}</p> : null}
    </CardHeader>
    <CardFooter>
      {release.artifacts.worker ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[release.status.worker]}>{RELEASE_TARGET_LABEL.worker} · {release.status.worker}</Badge> : null}
      {release.artifacts.machine ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[machines.status]}>{machines.text}</Badge> : null}
      {release.artifacts.frontend ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[release.status.frontend]}>{RELEASE_TARGET_LABEL.frontend} · {release.status.frontend}</Badge> : null}
    </CardFooter>
  </Card>;
}
export function SourceSettings({ deployment, onRevertDeployment, saving }: Pick<SettingsPageProps, 'deployment' | 'onRevertDeployment' | 'saving'>) {
  if (!deployment) return <Group title="Running"><EmptyState icon={icon(Rocket02, 20)} title="Loading source status…" description="Asking the home machine what GitSpace runs." /></Group>;
  const others = Object.entries(deployment.current.machines).filter(([machineId]) => machineId !== deployment.thisMachine.machineId);
  const releases = [...deployment.releases].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const channel = deployment.desired.sha === null;
  return <>
    <Group title="Running"><SettingRows>
      <SettingRow title={<>This machine<Badge color="green">Home</Badge></>} description={<span className="font-mono">{deployment.thisMachine.machineId}</span>}><RunningBadge sha={deployment.thisMachine.sha} generation={deployment.thisMachine.generation} /></SettingRow>
      <SettingRow title="Worker" description="The tenant worker answering this account, by its own version stamp."><Badge color={deployment.current.worker.sha === null ? 'gray' : 'blue'}><span className="font-mono">{deployment.current.worker.version ?? 'unknown'}</span></Badge></SettingRow>
      {others.map(([machineId, running]) => <SettingRow key={machineId} title={machineId} description="Last reported by the machine itself."><RunningBadge sha={running.sha} generation={running.generation} /></SettingRow>)}
    </SettingRows></Group>
    <Group title="Desired"><SettingRows>
      <SettingRow title={<>{desiredLabel(deployment)}<Badge color={channel ? 'gray' : 'blue'}>{channel ? 'Channel' : 'Release'}</Badge></>} description={channel ? 'Every target follows our channel build.' : <>{deployment.desired.targets.map((target) => RELEASE_TARGET_LABEL[target]).join(', ') || 'No targets'} · since {new Date(deployment.desired.updatedAt).toLocaleString()}</>}>
        <Button variant="secondary" size="compact" disabled={channel || saving} onClick={() => { if (window.confirm('Go back to the stable GitSpace build? The worker swaps now; machines and the frontend follow.')) settle(onRevertDeployment()); }}>Back to stable</Button>
      </SettingRow>
    </SettingRows></Group>
    <Group title="Releases">{releases.length
      ? <SettingRows>{releases.map((release) => <ReleaseRow key={release.sha} release={release} desired={deployment.desired.sha === release.sha} />)}</SettingRows>
      : <EmptyState icon={icon(Rocket02, 20)} title="No releases yet" description="Launch GitSpace from a workspace of the GitSpace project to build one." />}</Group>
  </>;
}
function DefaultsSettings({ settings, machines, onChange }: Pick<SettingsPageProps, 'settings' | 'machines' | 'onChange'>) {
  const update = (value: Partial<UserSettings['defaults']>) => onChange(replace(settings, 'defaults', { ...settings.defaults, ...value }));
  return <>
    <Group title="Placement"><SettingRows><SettingRow title="Default machine" description="New spaces open here when available."><Select value={settings.defaults.machineId ?? ''} onValueChange={(value) => update({ machineId: value || null })}><SelectTrigger aria-label="Default machine" />{selectOptions([{ value: '', label: 'Automatic' }, ...machines.map((machine) => ({ value: machine.id, label: machine.label }))])}</Select></SettingRow></SettingRows></Group>
    <Group title="Composer"><SettingRows><SettingRow title="Primary Enter action" description="Choose queue or steer while an agent is working.">{subtleTabs(['queue', 'steer'], settings.defaults.enterAction, (value) => update({ enterAction: value as 'queue' | 'steer' }), 'enter-action')}</SettingRow></SettingRows></Group>
    <Group title="Setup"><SettingRows><SettingRow title="Run setup again" description="Walk through profile, OMP, providers, Git, machine, and defaults from the start."><Button variant="secondary" size="compact" asChild><a href="/settings?mode=onboarding">Open setup</a></Button></SettingRow></SettingRows></Group>
  </>;
}

const sectionInfo: Array<{ id: Section; label: string; icon: (typeof ICONS)[keyof typeof ICONS]; kicker: string; title: string; description: string }> = [
  { id: 'profile', label: 'Profile', icon: ICONS.user, kicker: 'Account', title: 'Your GitSpace profile', description: 'Cloud-owned identity and namespace shared by every machine.' },
  { id: 'omp', label: 'OMP', icon: ICONS.bot, kicker: 'OMP', title: 'Models, agents, providers, and runtime', description: 'The complete OMP configuration used during onboarding and by every GitSpace machine.' },
  { id: 'omp-providers', label: 'Providers', icon: ICONS.cpu, kicker: 'Model providers', title: 'Connect your model providers', description: 'Sign in to the providers this machine’s agents will use. You can skip this and connect later from Settings → OMP → Providers.' },
  { id: 'git', label: 'Git', icon: ICONS.git, kicker: 'Git', title: 'Shared Git identity', description: 'One GitSpace SSH identity and commit attribution shared by your enrolled machines.' },
  { id: 'machines', label: 'Machines', icon: ICONS.server, kicker: 'Machines', title: 'Machines', description: 'Live fleet state and placement notes from GitSpace Cloud.' },
  { id: 'connections', label: 'Connections', icon: ICONS.key, kicker: 'Connections', title: 'Browsers and API clients', description: 'Every device holding a signed key for your account. Revoke any of them here; API clients can do at most what the browser that created them can.' },
  { id: 'hostnames', label: 'Domains', icon: ICONS.globe, kicker: 'Domains', title: 'Hostname', description: 'Your globally reserved GitSpace namespace.' },
  { id: 'source', label: 'Source', icon: ICONS.rocket, kicker: 'Source', title: 'What GitSpace runs', description: 'The build behind this account: the worker, every machine, and the frontend. Launch a workspace into it from the GitSpace project; come back to stable here.' },
  { id: 'defaults', label: 'Defaults', icon: ICONS.settings, kicker: 'Defaults', title: 'Workspace defaults', description: 'Cloud-owned defaults for new work.' },
];
// The settings tab strip; the providers step only exists as an onboarding step.
const settingsTabs = sectionInfo.filter((item) => item.id !== 'omp-providers');
export function requestedSettingsSection(search: string): { section: Section; ompTab: OmpTab } {
  const requested = new URLSearchParams(search).get('section');
  if (requested === 'omp-providers') return { section: 'omp', ompTab: 'Providers' };
  const section = settingsTabs.find((item) => item.id === requested)?.id ?? 'profile';
  return { section, ompTab: 'Models' };
}
function SaveState({ saving, error }: Pick<SettingsPageProps, 'saving' | 'error'>) {
  if (error) return <span role="alert" className="text-caption text-destructive">{error}</span>;
  return saving ? <span className="text-caption text-muted-foreground">Saving…</span> : null;
}
function SettingsContent({ section, ompTab = 'Models', ...props }: { section: Section; ompTab?: OmpTab } & SettingsPageProps) {
  if (section === 'omp') return <OmpSettings {...props} initialTab={ompTab} />;
  if (section === 'omp-providers') return <ProvidersSection {...props.providers} />;
  if (section === 'git') return <GitSettings {...props} />;
  if (section === 'machines') return <MachineSettings {...props} />;
  if (section === 'connections') return <ConnectionsSettings {...props} />;
  if (section === 'hostnames') return <HostnameSettings settings={props.settings} />;
  if (section === 'source') return <SourceSettings {...props} />;
  if (section === 'defaults') return <DefaultsSettings {...props} />;
  return <ProfileSettings {...props} />;
}
function SectionHeader({ section, actions, ...props }: { section: Section; actions?: ReactNode } & Pick<SettingsPageProps, 'ompSync'>) {
  const info = sectionInfo.find((item) => item.id === section) ?? sectionInfo[0]!;
  return <PageHeader kicker={info.kicker} title={info.title} description={info.description} actions={<>{section === 'omp' ? <OmpSyncBadge ompSync={props.ompSync} /> : null}{actions}</>} />;
}
function SettingsShell(props: SettingsPageProps) {
  const [requested] = useState(() => requestedSettingsSection(typeof window === 'undefined' ? '' : window.location.search));
  const [section, setSection] = useState<Section>(requested.section);
  const selectedIndex = settingsTabs.findIndex((item) => item.id === section);
  return <PageCanvas>
    <div className="pb-4"><Button variant="ghost" size="compact" aria-label="Back to workspace" onClick={props.onBack} leadingIcon={glyph(ArrowLeft)}>Back to workspace</Button></div>
    <SectionHeader section={section} ompSync={props.ompSync} actions={<><SaveState {...props} /><Button variant="primary" disabled={props.saving} onClick={() => settle(props.onSave(props.settings))}>{props.saving ? 'Saving' : 'Save changes'}</Button></>} />
    <div className="pb-6"><TabsSubtle selectedIndex={selectedIndex} idPrefix="settings-section" onSelect={(index) => setSection(settingsTabs[index]?.id ?? 'profile')}>{settingsTabs.map(({ id, label, icon: Icon }, index) => <TabsSubtleItem key={id} index={index} label={label} icon={Icon} />)}</TabsSubtle></div>
    <TabsSubtlePanel index={selectedIndex} selectedIndex={selectedIndex} idPrefix="settings-section" className="flex flex-col gap-8"><SettingsContent section={section} ompTab={requested.ompTab} {...props} /></TabsSubtlePanel>
  </PageCanvas>;
}
function OnboardingShell(props: SettingsPageProps) {
  const [step, setStep] = useState(0);
  const steps: Array<{ label: string; section: Section }> = [{ label: 'Profile', section: 'profile' }, { label: 'OMP', section: 'omp' }, { label: 'Providers', section: 'omp-providers' }, { label: 'Git', section: 'git' }, { label: 'Machine', section: 'machines' }, { label: 'Defaults', section: 'defaults' }];
  const current = steps[step]!;
  const last = step === steps.length - 1;
  const profileIncomplete = step === 0 && (!props.settings.profile.displayName.trim() || !props.settings.profile.handle);
  const advance = async () => { if (last) await props.onComplete({ ...props.settings, onboardingComplete: true }); else { await props.onSave(props.settings); setStep((value) => value + 1); } };
  return <PageCanvas>
    <div className="flex items-center justify-between gap-4 pb-4">
      <span className="flex items-center gap-2 text-body font-semibold text-foreground">{icon(Zap)}GitSpace</span>
      <span className="flex items-center gap-3"><SaveState {...props} /><Badge color="gray"><span className="tabular-nums">{step + 1} of {steps.length}</span></Badge></span>
    </div>
    <SectionHeader section={current.section} ompSync={props.ompSync} actions={<span aria-hidden className="flex items-center gap-1.5">{steps.map(({ label }, index) => <i key={label} className={`h-1.5 w-1.5 rounded-full ${index === step ? 'bg-foreground' : 'bg-border'}`} />)}</span>} />
    <div className="flex flex-col gap-8"><SettingsContent section={current.section} {...props} /></div>
    <footer className="mt-10 flex items-center justify-between gap-4 border-t border-border pt-6">
      <Button variant="secondary" disabled={step === 0 || props.saving} onClick={() => setStep((value) => value - 1)}>Back</Button>
      <Button variant="primary" disabled={profileIncomplete || props.saving} onClick={() => settle(advance())}>{last ? 'Open GitSpace' : 'Continue'}</Button>
    </footer>
  </PageCanvas>;
}
// Rendered as the whole app (not inside the sidebar shell), so the root owns
// the viewport column that PageCanvas scrolls within.
export function SettingsPage(props: SettingsPageProps) { return <div className="flex h-full min-h-0 flex-col bg-background text-foreground">{props.mode === 'onboarding' ? <OnboardingShell {...props} /> : <SettingsShell {...props} />}</div>; }
