import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { AvailableModel, ComposioSetupRpcView, DeploymentStatusView, DeviceCapability, DeviceView, RuntimeSettingValue, UserSettings } from '@gitspace/protocol';
import { inferenceSettingSection } from '@gitspace/protocol/inference';
import { cloudImageOperationActive, cloudImageOperationCancellable, cloudImageSelectionSchema, type CloudImageChoice, type CloudImageSelection, type CloudImageState } from '@gitspace/protocol/cloud-image';
import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import type { MachineDiscardConfirmation, MachineDiscardRequired } from '@gitspace/protocol/machine-discard';
import type { ApiClientDraft } from './device.js';
import type { McpAccessView } from '@gitspace/protocol/mcp-access';
import type { McpAccessActions, McpAccessValue } from './mcp-access.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { rpcClient } from './rpc-client.js';
import type { RuntimeAccountBrowserRelayStatus } from '@gitspace/protocol-runtime';
import { pairAccountBrowser, confirmAccountBrowser } from './browser-relay-client.js';
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
import { ModelCombobox, modelOptions } from './ModelCombobox.js';
import { desiredLabel, machineRollup, ompRollup, RELEASE_STATUS_COLOR, RELEASE_TARGET_LABEL, RELEASE_TARGETS, shortSha, type ReleaseRecordView } from './release.js';
import { AddMachinePanel } from './AddMachinePanel.js';
import { navigateProductUrl } from './routes.js';
import { ConnectBrowserDialog, type BrowserConnectionActions } from './ConnectBrowserDialog.js';

// Onboarding embeds the same Default profile surface used by Inference.
type Section = 'profile' | 'runtime' | 'runtime-providers' | 'git' | 'machines' | 'connections' | 'hostnames' | 'source' | 'defaults';
const SETTINGS_TABS = ['Models', 'Agents', 'Providers', 'Advanced'] as const;
type SettingsTab = (typeof SETTINGS_TABS)[number];
export interface SettingsMachineView { id: string; label: string; state: 'provisioning' | 'online' | 'sleeping' | 'offline' | 'resuming' | 'deleting' | 'error'; kind: 'physical' | 'sandbox'; provider: 'physical' | 'cloudflare-sandbox'; notes: string; desiredState: 'online' | 'offline' | 'removed'; lifecycleRevision: number; operationId: string | null; error: string | null }
export interface RuntimeSettingView {
  path: string;
  tab: string;
  label: string;
  description: string | null;
  kind: 'boolean' | 'enum' | 'number' | 'string' | 'array' | 'record' | 'other';
  valueJson: string;
  defaultJson?: string;
  options: readonly string[];
  credential: boolean;
}
export interface SettingsPageProps extends BrowserConnectionActions, McpAccessActions {
  mode: 'settings' | 'onboarding';
  settings: UserSettings;
  machines: readonly SettingsMachineView[];
  runtimeSettings: readonly RuntimeSettingView[];
  runtimeGeneration: number;
  inferenceSetup: ReactNode;
  gitIdentity: { generation: number; publicKey: string; fingerprint: string; updatedAt: string; updatedBy: string } | null;
  onChange: (settings: UserSettings) => void;
  onSave: (settings: UserSettings) => Promise<void>;
  onSetRuntimeSetting: (path: string, value: RuntimeSettingValue) => Promise<void>;
  onUpdateMachine: (machineId: string, notes: string) => Promise<void>;
  onCreateSandbox: (image?: CloudImageSelection) => Promise<void>;
  cloudImages: readonly CloudImageState[];
  cloudImageDefault: CloudImageChoice | null;
  cloudImageError: string | null;
  onChangeCloudImage: (machineId: string, selection: CloudImageSelection, previousOperationId?: string, discardUncheckpointedCandidate?: boolean) => Promise<void>;
  onRecoverCloudImage: (machineId: string, operationId: string, cancel: boolean) => Promise<void>;
  onSetCloudImageDefault: (selection: CloudImageSelection) => Promise<void>;
  onControlMachine: (action: 'sleep' | 'resume', machineId: string, discardConfirmation?: MachineDiscardConfirmation) => Promise<void>;
  onDestroyMachine: (machineId: string, discardConfirmation?: MachineDiscardConfirmation) => Promise<void>;
  /** Enrolled browsers and API clients; null while loading. */
  devices: readonly DeviceView[] | null;
  onRevokeDevice: (deviceId: string) => Promise<void>;
  /** Revoke this browser's own device and return to the enrollment screen. */
  onSignOut: () => Promise<void>;
  /** Mint a delegated API client from this browser; resolves to the one-time `gsk_` key. */
  onCreateApiClient: (draft: ApiClientDraft) => Promise<string>;
  composioSetup: ComposioSetupRpcView | null;
  onPutComposioSetup: (apiKey: string) => Promise<void>;
  onDeleteComposioSetup: () => Promise<void>;
  browserRelay: RuntimeAccountBrowserRelayStatus | null;
  onSetupBrowserRelay: () => Promise<void>;
  onStartBrowserRelay: () => Promise<void>;
  onUnpairBrowserRelay: (pairingId: string) => Promise<void>;
  onTestBrowserRelay: () => Promise<void>;
  /** Projects this account can scope an API client to. */
  projects: ReadonlyArray<{ id: string; name: string }>;
  onBack: () => void;
  onComplete: (settings: UserSettings) => Promise<void>;
  runtimeSync: { status: 'connecting' | 'synced' | 'offline' | 'conflict' | 'error'; message: string | null };
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

function parseValue(item: RuntimeSettingView): RuntimeSettingValue { return JSON.parse(item.valueJson) as RuntimeSettingValue; }
function settle(promise: Promise<void>): void { void promise.catch(() => undefined); }
function draftText(item: RuntimeSettingView, value: RuntimeSettingValue): string { return item.credential ? '' : typeof value === 'string' ? value : value === null ? '' : JSON.stringify(value, null, 2); }
function SettingControl({ item, onSet, disabled }: { item: RuntimeSettingView; onSet: (value: RuntimeSettingValue) => Promise<void>; disabled: boolean }) {
  const shape = useShape();
  const value = parseValue(item);
  const [text, setText] = useState(draftText(item, value));
  const [error, setError] = useState<string | null>(null);
  const draftSetter = useRef<typeof onSet | null>(null);
  useEffect(() => { if (!draftSetter.current) setText(draftText(item, value)); }, [item.valueJson, item.credential]);
  const discard = <Button variant="ghost" size="compact" onClick={() => { draftSetter.current = null; setText(draftText(item, value)); setError(null); }}>Discard draft</Button>;
  if (item.kind === 'boolean') return <Select value={value === null ? 'default' : String(value)} disabled={disabled} onValueChange={(next) => settle(onSet(next === 'default' ? null : next === 'true'))}><SelectTrigger aria-label={item.label} />{selectOptions([{ value: 'default', label: 'Use runtime default' }, { value: 'true', label: 'Enabled' }, { value: 'false', label: 'Disabled' }])}</Select>;
  if (item.kind === 'enum') return <Select value={typeof value === 'string' ? value : 'default'} disabled={disabled} onValueChange={(next) => settle(onSet(next === 'default' ? null : next))}><SelectTrigger aria-label={item.label} />{selectOptions([{ value: 'default', label: 'Use runtime default' }, ...item.options.map((option) => ({ value: option, label: option }))])}</Select>;
  if (item.kind === 'number') return <TextField label={item.label} type="number" placeholder="Runtime default" value={typeof value === 'number' ? String(value) : ''} disabled={disabled} onChange={(next) => settle(onSet(next.trim() === '' ? null : Number(next)))} />;
  if (item.kind === 'array' || item.kind === 'record') {
    // FLUID-GAP: multi-line JSON editor (no textarea/code editor in the registry)
    return <span className="flex flex-col gap-2"><textarea aria-label={item.label} aria-invalid={!!error} rows={4} value={text} disabled={disabled} className={`${shape.input} w-64 border border-border bg-surface-2 p-2 font-mono text-caption text-foreground disabled:opacity-50`} onChange={(event) => { draftSetter.current ??= onSet; setText(event.currentTarget.value); setError(null); }} onBlur={() => {
      const update = draftSetter.current;
      if (!update || text === draftText(item, value)) return;
      let parsed: RuntimeSettingValue;
      try { parsed = JSON.parse(text) as RuntimeSettingValue; }
      catch { setError('Invalid JSON. Correct the draft before saving.'); return; }
      void update(parsed).then(() => { draftSetter.current = null; setError(null); }, (cause) => setError(rpcErrorMessage(cause, 'Save configuration')));
    }} />{error ? <span role="alert" className="max-w-64 text-caption text-destructive">{error}{discard}</span> : null}</span>;
  }
  return <span className="flex flex-col gap-2"><TextField label={item.label} type={item.credential ? 'password' : 'text'} value={text} placeholder={item.credential ? 'Enter a replacement value' : undefined} disabled={disabled} onChange={(next) => { draftSetter.current ??= onSet; setText(next); setError(null); }} onBlur={() => {
    const update = draftSetter.current;
    if (!update || (item.credential && !text)) return;
    void update(text).then(() => { draftSetter.current = null; setError(null); }, (cause) => setError(rpcErrorMessage(cause, 'Save configuration')));
  }} />{error ? <span role="alert" className="max-w-64 text-caption text-destructive">{error}{discard}</span> : null}</span>;
}
function SettingRowsEditor({ items, saving, onSetRuntimeSetting }: { items: readonly RuntimeSettingView[] } & Pick<SettingsPageProps, 'saving' | 'onSetRuntimeSetting'>) {
  return <SettingRows>{items.map((item) => <SettingRow key={item.path} title={item.label} description={item.description ?? item.path}><SettingControl item={item} disabled={saving} onSet={(value) => onSetRuntimeSetting(item.path, value)} /></SettingRow>)}</SettingRows>;
}
const THINKING_LEVELS = ['auto', 'off', 'low', 'medium', 'high', 'xhigh'] as const;
/** A model role is `provider/model[:thinking]`; the picker splits it into a model select and a thinking select. */
function RoleModelPicker({ role, label, value, models, modelsReady, disabled, onChange }: { role: string; label: string; value: string; models: readonly AvailableModel[]; modelsReady: boolean; disabled: boolean; onChange(value: string): void }) {
  const separator = value.lastIndexOf(':');
  const modelKey = separator > value.indexOf('/') ? value.slice(0, separator) : value;
  const thinking = separator > value.indexOf('/') ? value.slice(separator + 1) : 'auto';
  const known = models.some((model) => `${model.provider}/${model.id}` === modelKey);
  const options = [
    ...(modelKey && !known ? [{ value: modelKey, label: modelsReady ? `${modelKey} (not available here)` : modelKey }] : []),
    ...modelOptions(models),
  ];
  return <span className="flex items-center gap-2">
    {modelKey && !known && modelsReady ? <span role="alert" className="max-w-64 text-caption text-destructive">This model is unavailable in this profile. Connect its provider or choose an available model.</span> : null}
    <ModelCombobox options={options} value={modelKey} disabled={disabled || !modelsReady} clearable ariaLabel={`Model for ${label}`}
      placeholder={role === 'task' ? 'Current session model' : 'Not set'}
      onValueChange={(next) => onChange(next ? (thinking === 'auto' ? next : `${next}:${thinking}`) : '')} />
    <Select size="compact" value={thinking} disabled={disabled || !modelKey} onValueChange={(next) => onChange(next === 'auto' ? modelKey : `${modelKey}:${next}`)}>
      <SelectTrigger variant="borderless" aria-label={`Thinking for ${label}`} />
      {selectOptions(THINKING_LEVELS.map((level) => ({ value: level, label: level })))}
    </Select>
  </span>;
}
export function RuntimeSettingsEditor({ runtimeSettings, runtimeGeneration, onSetRuntimeSetting, saving, providers, models = [], modelsReady = false, sections, initialTab }: Pick<SettingsPageProps, 'runtimeSettings' | 'runtimeGeneration' | 'onSetRuntimeSetting' | 'saving'> & { providers?: ProvidersSectionProps; models?: readonly AvailableModel[]; modelsReady?: boolean; sections: readonly SettingsTab[]; initialTab?: SettingsTab }) {
  const [tab, setTab] = useState<SettingsTab>(initialTab ?? sections[0] ?? 'Advanced');
  const rolesItem = runtimeSettings.find((item) => item.path === 'modelRoles');
  const cycleItem = runtimeSettings.find((item) => item.path === 'cycleOrder');
  const overridesItem = runtimeSettings.find((item) => item.path === 'task.agentModelOverrides');
  const roles = rolesItem ? parseValue(rolesItem) as Record<string, string> : {};
  const cycle = cycleItem ? parseValue(cycleItem) as string[] : [];
  const overrides = overridesItem ? parseValue(overridesItem) as Record<string, string | string[]> : {};
  const roleLabels: Readonly<Record<string, string>> = { default: 'Default', task: 'Task', slow: 'Thinking', smol: 'Fast', plan: 'Architect', designer: 'Designer', vision: 'Vision', commit: 'Commit', tiny: 'Tiny', advisor: 'Advisor' };
  const roleIds = [...new Set([...Object.keys(roleLabels), ...Object.keys(roles)])];
  const agentDefaults: Readonly<Record<string, string>> = { scout: 'smol', reviewer: 'slow', 'security-reviewer': 'slow', librarian: 'slow', task: 'task', designer: 'designer', sonic: 'tiny' };
  const agentNames = [...new Set([...Object.keys(agentDefaults), ...Object.keys(overrides)])];
  const advanced = runtimeSettings.filter((item) => inferenceSettingSection(item.path) === null && !item.credential);
  const advancedGroups = useMemo(() => Map.groupBy(advanced, (item) => item.tab), [advanced]);
  const advancedTabs = [...advancedGroups.keys()].sort();
  const [advancedTab, setAdvancedTab] = useState(advancedTabs[0] ?? 'other');
  const visibleAdvancedTab = advancedGroups.has(advancedTab) ? advancedTab : advancedTabs[0] ?? 'other';
  const providerSettings = runtimeSettings.filter((item) => inferenceSettingSection(item.path) === 'Providers' && !item.credential);
  const agentSettings = runtimeSettings.filter((item) => inferenceSettingSection(item.path) === 'Agents' && item.path !== 'task.agentModelOverrides' && !item.credential);
  const setRole = async (role: string, model: string): Promise<void> => {
    if (rolesItem) await onSetRuntimeSetting(rolesItem.path, { ...roles, [role]: model });
  };
  const toggleCycle = async (role: string): Promise<void> => {
    if (!cycleItem) return;
    const next = cycle.includes(role) ? cycle.filter((candidate) => candidate !== role) : [...cycle, role];
    if (next.length) await onSetRuntimeSetting(cycleItem.path, next);
  };
  const setAgentRole = async (agent: string, role: string): Promise<void> => {
    if (overridesItem) await onSetRuntimeSetting(overridesItem.path, { ...overrides, [agent]: `pi/${role}` });
  };
  let content: ReactNode;
  if (tab === 'Models') {
    content = <Group title={<>Model roles · <span className="tabular-nums">generation {runtimeGeneration}</span></>}>
      <SettingRows>{roleIds.map((role) => <SettingRow key={role} title={roleLabels[role] ?? role} description={role}>
        <Switch label="Quick cycle" checked={cycle.includes(role)} disabled={saving || !cycleItem} onToggle={() => settle(toggleCycle(role))} />
        <RoleModelPicker role={role} label={roleLabels[role] ?? role} value={roles[role] ?? ''} models={models} modelsReady={modelsReady} disabled={saving || !rolesItem} onChange={(value) => settle(setRole(role, value))} />
      </SettingRow>)}</SettingRows>
      <p className="text-caption text-muted-foreground">Quick cycle controls one-click cycling. At least one role remains selected. Role names match the workspace composer.</p>
      <SettingRowsEditor items={runtimeSettings.filter((item) => inferenceSettingSection(item.path) === 'Models' && item.path !== 'modelRoles' && item.path !== 'cycleOrder' && !item.credential)} saving={saving} onSetRuntimeSetting={onSetRuntimeSetting} />
    </Group>;
  } else if (tab === 'Agents') {
    content = <>
      <Group title="Agent model roles"><SettingRows>{agentNames.map((agent) => { const raw = overrides[agent]; const selected = String(raw ?? `pi/${agentDefaults[agent] ?? 'task'}`).replace(/^pi\//u, ''); const known = roleIds.includes(selected); return <SettingRow key={agent} title={agent} description={known ? roleLabels[selected] ?? selected : `Custom selector: ${Array.isArray(raw) ? raw.join(', ') : selected}`}><Select value={selected} disabled={!overridesItem || saving} onValueChange={(value) => settle(setAgentRole(agent, value))}><SelectTrigger aria-label={`Role for ${agent}`} />{selectOptions([...(known ? [] : [{ value: selected, label: `Custom: ${selected}` }]), ...roleIds.map((role) => ({ value: role, label: roleLabels[role] ?? role }))])}</Select></SettingRow>; })}</SettingRows></Group>
      <Group title="Agent runtime settings"><SettingRowsEditor items={agentSettings} saving={saving} onSetRuntimeSetting={onSetRuntimeSetting} /></Group>
    </>;
  } else if (tab === 'Providers') {
    content = <>
      {providers ? <ProvidersSection {...providers} /> : null}
      <Accordion type="single" collapsible>
        <AccordionItem value="advanced" index={0}>
          <AccordionTrigger>Advanced provider settings</AccordionTrigger>
          <AccordionContent>
            <div className="flex flex-col gap-3 pb-2">
              <span className="text-caption text-muted-foreground">Profile <code>providers.*</code> settings · <span className="tabular-nums">generation {runtimeGeneration}</span></span>
              <SettingRowsEditor items={providerSettings} saving={saving} onSetRuntimeSetting={onSetRuntimeSetting} />
            </div>
          </AccordionContent>
        </AccordionItem>
      </Accordion>
    </>;
  } else {
    const visible = advancedGroups.get(visibleAdvancedTab) ?? [];
    content = <>
      {subtleTabs(advancedTabs, visibleAdvancedTab, setAdvancedTab, 'runtime-advanced')}
      <TabsSubtlePanel index={Math.max(0, advancedTabs.indexOf(visibleAdvancedTab))} selectedIndex={Math.max(0, advancedTabs.indexOf(visibleAdvancedTab))} idPrefix="runtime-advanced">
        <Group title={<>{visibleAdvancedTab} · <span className="tabular-nums">generation {runtimeGeneration}</span></>}><SettingRowsEditor items={visible} saving={saving} onSetRuntimeSetting={onSetRuntimeSetting} /></Group>
      </TabsSubtlePanel>
    </>;
  }
  const tabIndex = sections.indexOf(tab);
  return <>
    {subtleTabs(sections, tab, (value) => setTab(value as SettingsTab), 'omp-tabs')}
    <TabsSubtlePanel index={tabIndex} selectedIndex={tabIndex} idPrefix="omp-tabs" className="flex flex-col gap-8">{content}</TabsSubtlePanel>
  </>;
}
function RuntimeSyncBadge({ runtimeSync }: Pick<SettingsPageProps, 'runtimeSync'>) {
  return <Badge color={runtimeSync.status === 'synced' ? 'green' : runtimeSync.status === 'offline' || runtimeSync.status === 'connecting' ? 'gray' : 'amber'}>{runtimeSync.status === 'synced' ? <>Synced</> : runtimeSync.message ?? runtimeSync.status}</Badge>;
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
      <p className="text-caption text-muted-foreground">Add this public key to <a href="https://github.com/settings/ssh/new" target="_blank" rel="noopener noreferrer" className="underline underline-offset-2">GitHub as an authentication key</a>. GitHub imports use it even when you paste an HTTPS browser URL. Your GitHub account still needs access to the repository.</p>
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
  { id: 'fleet.control', label: 'Fleet', description: 'Create, stop, start, destroy machines' },
  { id: 'deployment.control', label: 'Deployment', description: 'Select cloud images and control GitSpace runtime releases (account scope required)' },
  { id: 'devices.manage', label: 'Device management', description: 'Revoke enrolled browsers and API clients (whole account required)' },
  { id: 'account.admin', label: 'Account administration', description: 'Manage provider keys, inference, session approval policy and review decisions (whole account and Write required)' },
  { id: 'lifecycle.control', label: 'Lifecycle control', description: 'Approve execution content and browser origins through API/MCP, cancel and recover runs, retire resources (whole account and Write required)' },
];

function ApiClientPermissions({ projects, projectId, setProjectId, capabilities, setCapabilities, ttl, setTtl, id }: {
  projects: ReadonlyArray<{ id: string; name: string }>;
  projectId: string;
  setProjectId: (value: string) => void;
  capabilities: DeviceCapability[];
  setCapabilities: (value: DeviceCapability[]) => void;
  ttl: string;
  setTtl: (value: string) => void;
  id: string;
}) {
  return <SettingRows>
    <SettingRow title="Scope" description="Everything, or one project.">
      <Select value={projectId} onValueChange={(value) => setProjectId(value ?? '')}><SelectTrigger aria-label="Scope" placeholder="Whole account" />{selectOptions([{ value: '', label: 'Whole account' }, ...projects.map((project) => ({ value: project.id, label: project.name }))])}</Select>
    </SettingRow>
    {API_CLIENT_CAPABILITIES.map((capability) => <SettingRow key={capability.id} title={capability.label} description={capability.description}>
      <Switch label={capability.label} checked={capabilities.includes(capability.id)} onToggle={() => setCapabilities(capabilities.includes(capability.id) ? capabilities.filter((value) => value !== capability.id) : [...capabilities, capability.id])} />
    </SettingRow>)}
    <SettingRow title="Expires" description="Expired access stops working without a revoke.">
      <Select value={ttl} onValueChange={(value) => { if (value) setTtl(value); }}><SelectTrigger aria-label="Expires" id={`${id}-ttl`} />{selectOptions(API_CLIENT_TTLS)}</Select>
    </SettingRow>
  </SettingRows>;
}

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
      setError(rpcErrorMessage(failure, 'Create API client'));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={open} onOpenChange={close}>
    <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
      <DialogHeader><DialogTitle>{key ? 'API client created' : 'New API client'}</DialogTitle><DialogDescription>{key ? 'Copy the key now; it is not stored anywhere and cannot be shown again. Revoke it from this list at any time.' : 'A signed device key for scripts and services. It can do at most what this browser can, within the scope you choose.'}</DialogDescription></DialogHeader>
      {key
        ? <InputCopy label="API key" value={key} />
        : <form id="api-client-form" className="flex flex-col gap-4" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
            <InputGroup className="w-full"><InputField index={0} label="Label" value={label} placeholder="CI deploy bot" onChange={setLabel} autoFocus required /></InputGroup>
            <ApiClientPermissions projects={projects} projectId={projectId} setProjectId={setProjectId} capabilities={capabilities} setCapabilities={setCapabilities} ttl={ttl} setTtl={setTtl} id="api-client" />
            {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
          </form>}
      <DialogFooter>
        <Button variant="secondary" type="button" onClick={() => close(false)}>{key ? 'Done' : 'Cancel'}</Button>
        {key ? null : <Button variant="primary" type="submit" form="api-client-form" loading={pending} disabled={!label.trim() || capabilities.length === 0}>Create key</Button>}
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}

function ComposioSetupDialog({ open, onOpenChange, setup, onPut, onDelete }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  setup: ComposioSetupRpcView | null;
  onPut: (apiKey: string) => Promise<void>;
  onDelete: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    setPending(true);
    setError(null);
    try {
      await onPut(apiKey);
      setApiKey('');
      onOpenChange(false);
    } catch (failure) {
      setError(rpcErrorMessage(failure, 'Save integration API key'));
    } finally {
      setPending(false);
    }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>{setup?.source === 'account' ? 'Replace Composio API key' : 'Set up Composio'}</DialogTitle>
        <DialogDescription>Paste an API key from your Composio dashboard. GitSpace validates it, encrypts it in your account vault, and never shows it again.</DialogDescription>
      </DialogHeader>
      <form id="composio-setup-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <InputGroup className="w-full"><InputField index={0} label="Composio API key" type="password" autoComplete="off" value={apiKey} onChange={setApiKey} placeholder="Enter API key" autoFocus required /></InputGroup>
        {error ? <p role="alert" className="pt-2 text-caption text-destructive">{error}</p> : null}
      </form>
      <DialogFooter>
        {setup?.source === 'account' ? <Button variant="ghost" type="button" disabled={pending} onClick={() => { if (window.confirm('Remove your Composio API key? Connected plugins will stop working unless a platform key is available.')) settle(onDelete().then(() => onOpenChange(false))); }}>Remove</Button> : null}
        <Button variant="secondary" type="button" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button variant="primary" type="submit" form="composio-setup-form" loading={pending} disabled={apiKey.trim().length < 16}>Save API key</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
export function BrowserRelayWalkthrough({ open, onOpenChange, relay, onSetup, onStart, onTest, onUnpair }: {
  open: boolean;
  onOpenChange(open: boolean): void;
  relay: RuntimeAccountBrowserRelayStatus | null;
  onSetup(): Promise<void>;
  onStart(): Promise<void>;
  onTest(): Promise<void>;
  onUnpair(pairingId: string): Promise<void>;
}) {
  const [pairing, setPairing] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => { generation.current++; setPairing(null); }, [open]);
  const run = async (name: string, operation: () => Promise<void>) => {
    if (pending) return;
    setPending(name); setError(null);
    try { await operation(); } catch (cause) { setError(rpcErrorMessage(cause, 'Account browser relay')); } finally { setPending(null); }
  };
  return <Dialog open={open} onOpenChange={onOpenChange}><DialogContent className="max-w-3xl">
    <DialogHeader><DialogTitle>Connect your Chrome profile</DialogTitle><DialogDescription>The extension connects directly to your account. No machine or localhost relay is required.</DialogDescription></DialogHeader>
    <div className="flex max-h-[65vh] flex-col gap-4 overflow-y-auto">
      <SettingRows>
        <SettingRow title="1. Download the extension" description="Download and unzip the account-specific extension into a folder you can keep.">
          <Button variant="secondary" disabled={pending !== null} loading={pending === 'download'} onClick={() => void run('download', onSetup)}>Download extension</Button>
        </SettingRow>
        <SettingRow title="2. Load it in Chrome" description="Open chrome://extensions, enable Developer mode, choose Load unpacked, and select the unzipped folder.">
          <Button variant="secondary" onClick={() => void navigator.clipboard.writeText('chrome://extensions')}>Copy extensions address</Button>
        </SettingRow>
        <SettingRow title="3. Pair this account" description={<span>Paste this one-time JSON into the extension popup. Chrome keeps a non-exportable private key; your account stores only its public key.{pairing ? <code className="mt-2 block select-all whitespace-pre-wrap break-all font-mono text-caption">{pairing}</code> : null}</span>}>
          <Button variant="primary" disabled={pending !== null} loading={pending === 'pairing'} onClick={() => void run('pairing', async () => { const current = generation.current; const value = await pairAccountBrowser(); if (current === generation.current) setPairing(JSON.stringify(value, null, 2)); await onStart(); })}>Get pairing JSON</Button>
          {pairing ? <Button variant="secondary" onClick={() => void navigator.clipboard.writeText(pairing)}>Copy pairing JSON</Button> : null}
        </SettingRow>
        <SettingRow title="4. Confirm your Chrome identity" description="Compare the SHA-256 fingerprint with the extension popup. Confirm only if every character matches. Pairing codes expire after ten minutes; confirmed identities do not. Choose project browsers separately in project Settings.">
          <Button variant="secondary" disabled={pending !== null} onClick={() => void run('refresh', onStart)}>Refresh status</Button>
        </SettingRow>
        {relay?.pairings.map(browser => <SettingRow key={browser.pairingId} title={browser.state === 'confirmed' ? browser.browser ?? 'Confirmed Chrome' : 'Unconfirmed browser'} description={<span>{browser.state === 'awaiting-key' ? <span>Waiting for extension. Code expires {new Date(browser.expiresAt).toLocaleTimeString()}.</span> : <code className="block break-all font-mono">SHA-256 {browser.pairedKeyFingerprint}</code>}<code className="block break-all text-muted-foreground">{browser.pairingId}</code></span>}>
          <Badge color={browser.connected ? 'green' : 'gray'}>{browser.connected ? 'Connected' : 'Disconnected'}</Badge>
          {browser.state === 'pending-confirmation' ? <Button variant="primary" disabled={pending !== null} onClick={() => void run('confirm', async () => { await confirmAccountBrowser(browser.pairingId, browser.pairedKeyFingerprint); await onStart(); })}>Fingerprints match — confirm</Button> : null}
          <Button variant="secondary" disabled={pending !== null} loading={pending === `unpair:${browser.pairingId}`} onClick={() => void run(`unpair:${browser.pairingId}`, () => onUnpair(browser.pairingId))}>Forget paired browser</Button>
        </SettingRow>)}
      </SettingRows>
      <p className="text-caption text-muted-foreground">Only the main agent can use your signed-in profile. Approved origins and signed grants limit it to this workspace’s Chrome tab group. Drag tabs out to revoke their access. Resetting the extension identity requires forgetting the paired browser before pairing again.</p>
      {error ? <p role="alert" className="text-caption text-destructive">{error}</p> : null}
    </div>
    <DialogFooter><Button variant="secondary" onClick={() => onOpenChange(false)}>Close</Button><Button variant="primary" disabled={pending !== null} loading={pending === 'test'} onClick={() => void run('test', onTest)}>Check connection</Button></DialogFooter>
  </DialogContent></Dialog>;
}


function DeviceRows({ devices, kind, onRevokeDevice, onSignOut }: Pick<SettingsPageProps, 'devices' | 'onRevokeDevice' | 'onSignOut'> & { kind: 'browser' | 'client' }) {
  if (devices === null) return <EmptyState icon={icon(Monitor01)} title="Loading devices…" />;
  const matching = devices.filter(device => device.kind === kind);
  if (matching.length === 0) return <EmptyState icon={icon(kind === 'browser' ? Monitor01 : Key01)} title={kind === 'browser' ? 'No browsers connected' : 'No API clients'} description={kind === 'browser' ? 'Connected browsers each have their own revocable key.' : 'Create a scoped key for scripts and services.'} />;
  return <SettingRows>{matching.map(device => <SettingRow key={device.deviceId} title={<>{device.label}{device.current ? <Badge color="green">This browser</Badge> : null}</>} description={<>{device.scope === 'user' ? 'Whole account' : device.scope} · enrolled {new Date(device.boundAt).toLocaleString()}{device.expiresAt ? ` · expires ${new Date(device.expiresAt).toLocaleString()}` : ''}{device.revokedAt ? ` · revoked ${new Date(device.revokedAt).toLocaleString()}` : ''}</>}>
    {device.revokedAt ? <Badge color="gray">Revoked</Badge> : !device.active ? <Badge color="amber">Inactive</Badge> : device.current
      ? <Button variant="ghost" size="compact" onClick={() => { if (window.confirm('Sign out this browser? Browsers and API clients it authorized also lose access. Use your recovery key to reconnect independently.')) settle(onSignOut()); }}>Sign out</Button>
      : <Button variant="ghost" size="compact" onClick={() => { if (window.confirm(`Revoke ${device.label}? It${device.kind === 'browser' ? ' and browsers or API clients it authorized' : ''} will lose access within seconds.`)) settle(onRevokeDevice(device.deviceId)); }}>Revoke</Button>}
  </SettingRow>)}</SettingRows>;
}

/** One-time bearer values live only in this mounted Connections section. */
export function McpAccessSettings({ projects, canManageMcp, canEnableMcp, onMcpStatus, onMcpEnable, onMcpRotate, onMcpDisable }: McpAccessActions & { projects: ReadonlyArray<{ id: string; name: string }> }) {
  const [view, setView] = useState<McpAccessView | null>(null);
  const [action, setAction] = useState<'enable' | 'rotate' | 'disable' | null>(null);
  const [secret, setSecret] = useState<{ token: string; endpoint: string } | null>(null);
  const [pending, setPending] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [projectId, setProjectId] = useState('');
  const [capabilities, setCapabilities] = useState<DeviceCapability[]>(['rpc.read', 'session.prompt']);
  const [ttl, setTtl] = useState('never');
  const alive = useRef(false);
  const status = useRef(onMcpStatus);
  status.current = onMcpStatus;
  const refresh = async (): Promise<void> => {
    setLoading(true);
    try {
      const result = await status.current();
      if (alive.current) {
        // Never allow a credential returned by a server into status state.
        const { token: _token, ...next } = result as McpAccessValue;
        setView(next);
      }
    } catch (failure) {
      if (alive.current) { setView(null); setError(rpcErrorMessage(failure, 'Read MCP status')); }
    } finally {
      if (alive.current) setLoading(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    if (canManageMcp) void refresh();
    else { setView(null); setLoading(false); setSecret(null); setAction(null); }
    return () => { alive.current = false; };
  }, [canManageMcp]);
  const close = (): void => { if (!pending) { setAction(null); setSecret(null); } };
  const submit = async (): Promise<void> => {
    if (!view || !action || pending) return;
    setPending(true);
    setError(null);
    try {
      const result = action === 'enable'
        ? await onMcpEnable(view.revision, { scope: projectId ? { kind: 'project', projectId } : { kind: 'user' }, capabilities, ttlMs: API_CLIENT_TTLS.find(option => option.value === ttl)?.ms ?? null })
        : action === 'rotate' ? await onMcpRotate(view.revision) : await onMcpDisable(view.revision);
      if (alive.current) {
        const { token, ...next } = result;
        setView(next);
        setSecret(token ? { token, endpoint: next.endpoint } : null);
        setAction(null);
      }
    } catch (failure) {
      if (alive.current) { setError(rpcErrorMessage(failure, 'Change MCP access')); setAction(null); }
    } finally {
      // Reconcile once, including ambiguous failures; never retry a mutation.
      if (alive.current) { await refresh(); setPending(false); }
    }
  };
  const open = (next: 'enable' | 'rotate' | 'disable'): void => {
    setError(null);
    setSecret(null);
    setProjectId('');
    setCapabilities(['rpc.read', 'session.prompt']);
    setTtl('never');
    setAction(next);
  };
  const scope = view?.scope;
  return <Group title="MCP">
    <SettingRows>
      <SettingRow title="GitSpace MCP" description="Connect an MCP client over Streamable HTTP. Access stays off until you enable it.">
        <Badge color={view?.active ? 'green' : view?.enabled ? 'amber' : 'gray'}>{loading ? 'Loading…' : view?.active ? 'Active' : view?.enabled ? 'Inactive grant' : view ? 'Disabled' : 'Unavailable'}</Badge>
      </SettingRow>
      {view ? <>
        <SettingRow title="Endpoint" description={view.endpoint}>{null}</SettingRow>
        {view.enabled ? <SettingRow title="Access" description={<>{scope?.kind === 'project' ? `Project: ${projects.find(project => project.id === scope.projectId)?.name ?? scope.projectId}` : 'Whole account'}<span className="mt-1 block">{view.capabilities.join(', ')}</span><span className="mt-1 block">{view.expiresAt ? `Expires ${new Date(view.expiresAt).toLocaleString()}` : 'Until revoked'}</span></>}>{null}</SettingRow> : null}
      </> : null}
    </SettingRows>
    {!canManageMcp ? <p className="text-caption text-muted-foreground">Manage MCP from an active account-scoped browser with Device management permission.</p> : <>
      {view?.enabled && !view.active ? <p className="text-caption text-muted-foreground">The dedicated grant was revoked or expired. Disable MCP, then enable it again to authorize a new grant.</p> : null}
      {!view?.enabled && !canEnableMcp ? <p className="text-caption text-muted-foreground">This browser cannot delegate access. Use a delegating account browser to enable MCP.</p> : null}
      <div className="flex flex-wrap gap-2 pt-3">
        {view?.enabled ? <>
          <Button variant="secondary" size="compact" disabled={pending || loading || !view.active} onClick={() => open('rotate')}>Rotate token</Button>
          <Button variant="secondary" size="compact" disabled={pending || loading} onClick={() => open('disable')}>Disable MCP</Button>
        </> : <Button variant="primary" size="compact" disabled={!view || !canEnableMcp || loading || pending} onClick={() => open('enable')}>Enable MCP</Button>}
        <Button variant="ghost" size="compact" disabled={pending || loading} onClick={() => { setError(null); void refresh(); }}>Refresh status</Button>
      </div>
    </>}
    {error ? <p role="alert" className="mt-3 text-caption text-destructive">{error}</p> : null}
    <Dialog open={action !== null || secret !== null} onOpenChange={(next) => { if (!next) close(); }}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{secret ? 'Copy your MCP token' : action === 'enable' ? 'Enable GitSpace MCP' : action === 'rotate' ? 'Rotate MCP token?' : 'Disable MCP?'}</DialogTitle>
          <DialogDescription>{secret ? 'Shown once. Copy it now and keep it private. Closing this dialog clears the token; it cannot be retrieved later.' : action === 'enable' ? 'Authorize the dedicated GitSpace MCP client with the scope, permissions, and lifetime you choose. The private signing key stays in the vault.' : action === 'rotate' ? 'The current bearer token stops working immediately. Update every connected MCP client with the new token.' : 'The bearer token stops working immediately and the dedicated client grant is revoked. Enabling again requires fresh authorization.'}</DialogDescription>
        </DialogHeader>
        {secret ? <div className="flex min-w-0 flex-col gap-4">
          <InputCopy label="Streamable HTTP URL" value={secret.endpoint} />
          <InputCopy label="Bearer token" value={secret.token} />
          <InputCopy label="MCP client configuration" value={JSON.stringify({ mcpServers: { gitspace: { type: 'http', url: secret.endpoint, headers: { Authorization: `Bearer ${secret.token}` } } } }, null, 2)} />
          <p className="text-caption text-muted-foreground">Choose Streamable HTTP in your client and send the token in the Authorization header, not the URL. Clients may use different configuration formats.</p>
        </div> : action === 'enable' ? <fieldset disabled={pending} className="min-w-0">
          <ApiClientPermissions projects={projects} projectId={projectId} setProjectId={setProjectId} capabilities={capabilities} setCapabilities={setCapabilities} ttl={ttl} setTtl={setTtl} id="mcp-client" />
        </fieldset> : null}
        <DialogFooter>
          <Button variant="secondary" disabled={pending} onClick={close}>{secret ? 'Done' : 'Cancel'}</Button>
          {!secret ? <Button variant="primary" loading={pending} disabled={pending || !view || (action === 'enable' && (!canEnableMcp || capabilities.length === 0))} onClick={() => void submit()}>{action === 'enable' ? 'Enable MCP' : action === 'rotate' ? 'Rotate and invalidate old token' : 'Disable MCP'}</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </Group>;
}

function ConnectionsSettings({
  devices, onRevokeDevice, onSignOut, onCreateApiClient, projects,
  canManageMcp, canEnableMcp, onMcpStatus, onMcpEnable, onMcpRotate, onMcpDisable,
  composioSetup, onPutComposioSetup, onDeleteComposioSetup,
  browserRelay, onSetupBrowserRelay, onStartBrowserRelay, onUnpairBrowserRelay, onTestBrowserRelay,
  canConnectBrowser, onCreateBrowserInvitation, onBrowserInvitationStatus, onCancelBrowserInvitation, onBrowserConnected,
}: Pick<SettingsPageProps, 'devices' | 'onRevokeDevice' | 'onSignOut' | 'onCreateApiClient' | 'projects' | 'composioSetup' | 'onPutComposioSetup' | 'onDeleteComposioSetup' | 'browserRelay' | 'onSetupBrowserRelay' | 'onStartBrowserRelay' | 'onUnpairBrowserRelay' | 'onTestBrowserRelay'> & BrowserConnectionActions & McpAccessActions) {
  const [apiClientOpen, setApiClientOpen] = useState(false);
  const [browserOpen, setBrowserOpen] = useState(false);
  const [composioOpen, setComposioOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('setup') === 'composio');
  const [relayGuideOpen, setRelayGuideOpen] = useState(false);
  const [relayPending, setRelayPending] = useState(false);
  const [relayError, setRelayError] = useState<string | null>(null);
  const runRelayAction = async (action: () => Promise<void>) => {
    setRelayPending(true);
    setRelayError(null);
    try {
      await action();
    } catch (failure) {
      setRelayError(rpcErrorMessage(failure, 'Browser relay operation'));
    } finally {
      setRelayPending(false);
    }
  };
  return <>
    <McpAccessSettings projects={projects} canManageMcp={canManageMcp} canEnableMcp={canEnableMcp} onMcpStatus={onMcpStatus} onMcpEnable={onMcpEnable} onMcpRotate={onMcpRotate} onMcpDisable={onMcpDisable} />
    <Group title="Plugin providers">
      <SettingRows>
        <SettingRow title="Composio" description={composioSetup?.source === 'account' ? <>Encrypted account credential · updated {composioSetup.updatedAt?.toLocaleString() ?? 'recently'}</> : composioSetup?.source === 'platform' ? 'Provided by this GitSpace deployment' : 'Connect hosted apps without copying OAuth credentials into workspaces.'}>
          <Badge color={composioSetup?.configured ? 'green' : 'gray'}>{composioSetup?.configured ? 'Configured' : 'Not configured'}</Badge>
          <Button variant="secondary" size="compact" onClick={() => setComposioOpen(true)}>{composioSetup?.source === 'account' ? 'Replace key' : 'Set up'}</Button>
        </SettingRow>
      </SettingRows>
      <ComposioSetupDialog open={composioOpen} onOpenChange={setComposioOpen} setup={composioSetup} onPut={onPutComposioSetup} onDelete={onDeleteComposioSetup} />
    </Group>
    <Group title="Browser control">
      <SettingRows>
        <SettingRow title="Account Browser Relay" description="Connect Chrome directly to this account. Machines are not required.">
          <Button variant="secondary" size="compact" onClick={() => setRelayGuideOpen(true)}>Setup guide</Button>
          <Button variant="secondary" size="compact" disabled={relayPending} onClick={() => void runRelayAction(onTestBrowserRelay)}>Check connection</Button>
        </SettingRow>
      </SettingRows>
      <p className="text-caption text-muted-foreground">Headless Chromium is the default and needs no browser approval. Only the main agent may request Browser Relay for your signed-in session. Relay tabs belong to one coloured group per workspace: drag tabs in to share them and out to take them back. Approve hosts in Environment or through an API/MCP key with lifecycle.control, whole-account scope, and Write. Yolo does not approve origins. Project approval applies only where the committed bundle lists the origin; older branches gain it after merging or rebasing base to include it. Each new group asks for approval outside yolo. JavaScript and screenshots are included in the origin grant. Browser tools and remote callers use the same signed workspace-group grant. Shell and codemode run as the machine user and are trusted as that user; browser controls do not isolate same-user code. Browser content may enter agent history. Use a separate personal project for personal browser tasks.</p>
      {relayError ? <p role="alert" className="text-caption text-destructive">{relayError}</p> : null}
      <BrowserRelayWalkthrough open={relayGuideOpen} onOpenChange={setRelayGuideOpen} relay={browserRelay} onSetup={onSetupBrowserRelay} onStart={onStartBrowserRelay} onTest={onTestBrowserRelay} onUnpair={onUnpairBrowserRelay} />
    </Group>
    <Group title="Browsers">
      <DeviceRows devices={devices} kind="browser" onRevokeDevice={onRevokeDevice} onSignOut={onSignOut} />
      <div className="pt-3"><Button variant="secondary" size="compact" disabled={!canConnectBrowser} onClick={() => setBrowserOpen(true)} leadingIcon={glyph(Monitor01)}>Connect another browser</Button></div>
      {!canConnectBrowser && devices !== null ? <p className="text-caption text-muted-foreground">This browser cannot grant full account access. Use your recovery key on the other browser instead.</p> : null}
      {browserOpen ? <ConnectBrowserDialog open={browserOpen} onOpenChange={setBrowserOpen} canConnectBrowser={canConnectBrowser} onCreateBrowserInvitation={onCreateBrowserInvitation} onBrowserInvitationStatus={onBrowserInvitationStatus} onCancelBrowserInvitation={onCancelBrowserInvitation} onBrowserConnected={onBrowserConnected} /> : null}
    </Group>
    <Group title="API clients">
      <DeviceRows devices={devices} kind="client" onRevokeDevice={onRevokeDevice} onSignOut={onSignOut} />
      <div className="pt-3"><Button variant="secondary" size="compact" onClick={() => setApiClientOpen(true)} leadingIcon={glyph(Key01)}>New API client</Button></div>
      <ApiClientDialog open={apiClientOpen} onOpenChange={setApiClientOpen} projects={projects} onCreate={onCreateApiClient} />
    </Group>
  </>;
}

function CloudImagePicker({ value, onChange }: { value: CloudImageSelection; onChange(value: CloudImageSelection): void }) {
  return <div className="space-y-3">
    <Select value={value.kind} onValueChange={(kind) => onChange(kind === 'custom' ? { kind, image: '' } : { kind: 'platform-default' })}>
      <SelectTrigger aria-label="Cloud image source" />{selectOptions([{ value: 'platform-default', label: 'Platform default (pin current digest)' }, { value: 'custom', label: 'Custom immutable OCI image' }])}
    </Select>
    {value.kind === 'custom' ? <TextField label="Immutable OCI image" value={value.image} placeholder="registry.example.com/team/image@sha256:…" onChange={(image) => onChange({ kind: 'custom', image })} /> : null}
    <p className="text-caption text-muted-foreground">Any registry image with compatible GitSpace provider and control interfaces is supported; inheriting our base is optional. Use an immutable @sha256 digest. Image choice does not change your separately selected GitSpace runtime release.</p>
    {value.kind === 'custom' && value.image && !cloudImageSelectionSchema.safeParse(value).success ? <p role="alert" className="text-caption text-destructive">Enter a registry-qualified image with a 64-character lowercase SHA-256 digest, not a tag.</p> : null}
  </div>;
}

export function MachineSettings({ machines, onUpdateMachine, onCreateSandbox, onControlMachine, onDestroyMachine, cloudImages, cloudImageDefault, cloudImageError, onChangeCloudImage, onRecoverCloudImage, onSetCloudImageDefault }: Pick<SettingsPageProps, 'machines' | 'onUpdateMachine' | 'onCreateSandbox' | 'onControlMachine' | 'onDestroyMachine' | 'cloudImages' | 'cloudImageDefault' | 'cloudImageError' | 'onChangeCloudImage' | 'onRecoverCloudImage' | 'onSetCloudImageDefault'>) {
  const shape = useShape();
  const [setup, setSetup] = useState(false);
  const [sandboxSetup, setSandboxSetup] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [imageTarget, setImageTarget] = useState<string | null>(null);
  const [imageRecovery, setImageRecovery] = useState<{ machineId: string; operationId: string } | null>(null);
  const [discardCandidate, setDiscardCandidate] = useState(false);
  const [selection, setSelection] = useState<CloudImageSelection>({ kind: 'platform-default' });
  const [useAccountImage, setUseAccountImage] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [discardRequired, setDiscardRequired] = useState<Pick<MachineDiscardRequired, 'message' | 'confirmation' | 'workspaces'> | null>(null);
  const [discardPhrase, setDiscardPhrase] = useState('');
  const operationPending = useRef(false);
  const discardMachine = discardRequired ? machines.find((machine) => machine.id === discardRequired.confirmation.machineId) : undefined;
  const requiredPhrase = discardMachine?.label || discardRequired?.confirmation.machineId;
  const editingMachine = machines.find((machine) => machine.id === editing) ?? null;
  const run = async (key: string, action: () => Promise<void>) => {
    if (operationPending.current) return;
    operationPending.current = true;
    setPending(key); setActionError(null);
    try { await action(); }
    catch (error) {
      if (rpcErrors.machineDiscardRequired.is(error) && error.data.confirmation.machineId === key) {
        setDiscardRequired(error.data);
        setDiscardPhrase('');
      } else setActionError(rpcErrorMessage(error, 'Machine settings operation'));
    }
    finally { operationPending.current = false; setPending(null); }
  };
  return <>
    {cloudImageError || actionError ? <p role="alert" className="text-caption text-destructive">{actionError ?? cloudImageError}</p> : null}
    <Group title="Cloud image default">
      <p className="text-caption text-muted-foreground">New cloud machines use this account-owned, pinned image. Changing this default never replaces an existing machine or silently follows a platform update.</p>
      <p className="break-all font-mono text-caption">{cloudImageDefault?.image ?? 'Loading pinned account image…'}</p>
      <Button variant="secondary" disabled={pending !== null} onClick={() => { setImageTarget('default'); setSelection({ kind: 'platform-default' }); }}>Choose account image</Button>
    </Group>
    <Group title="Your machines">
      <p className="text-caption text-muted-foreground">Cloud machines are temporary. Stop saves supported workspace state before discarding the machine disk. Start runs a fresh machine environment and restores saved workspaces, not installed packages or machine-local configuration.</p>
      <p className="text-caption text-muted-foreground">GitSpace does not save ignored files or other files outside its workspace checkpoints, including files in the machine&apos;s home directory. After an unexpected interruption, the last completed checkpoint is the recovery limit; uncheckpointed work may be lost. Bake persistent tools into your selected image.</p>
      {machines.length ? <SettingRows>{machines.map((machine) => {
        const image = cloudImages.find((item) => item.machineId === machine.id);
        const active = cloudImageOperationActive(image);
        return <Card key={machine.id} size="compact">
          <CardMedia icon={machine.kind === 'sandbox' ? ICONS.server : ICONS.monitor} />
          <CardHeader>
            <CardTitle>{machine.label}</CardTitle>
            <CardDescription>{machine.kind === 'sandbox' ? 'Temporary cloud machine' : <span className="font-mono">{machine.id}</span>}{machine.notes ? <> · {machine.notes}</> : null}</CardDescription>
            {machine.error ? <p role="alert" className="text-caption text-destructive">{machine.error}</p> : null}
            {machine.kind === 'sandbox' ? <div className="space-y-1 text-caption">
              <p className="break-all">Last confirmed image: <span className="font-mono">{image?.currentImage ?? 'Not yet confirmed'}</span></p>
              {image?.desiredImage && image.desiredImage !== image.currentImage ? <p className="break-all">Desired image: <span className="font-mono">{image.desiredImage}</span></p> : null}
              {image?.operation ? <p role="status">Image operation: {image.operation.phase}{image.operation.barrier ? ' · New work blocked on this machine until recovery completes' : ''}</p> : null}
              {image?.operation?.discardApproval ? <p className="text-caption text-destructive">{image.operation.discardReceipt ? 'Candidate stop was verified after explicit discard approval. Only completed workspace checkpoints are recoverable.' : 'Discard of uncheckpointed candidate work is explicitly authorized if checkpointing fails.'}</p> : null}
              {image?.operation?.error ? <p role="alert" className="text-destructive">{image.operation.error}</p> : null}
              {active && image?.operation ? <div className="flex flex-wrap gap-2">
                <Button variant="secondary" size="compact" disabled={pending !== null} onClick={() => void run(machine.id, () => onRecoverCloudImage(machine.id, image.operation!.id, false))}>Continue / retry recovery</Button>
                {cloudImageOperationCancellable(image) ? <Button variant="ghost" size="compact" disabled={pending !== null} onClick={() => void run(machine.id, () => onRecoverCloudImage(machine.id, image.operation!.id, true))}>Cancel and recover original</Button> : <Button variant="secondary" size="compact" disabled={pending !== null} onClick={() => {
                  setImageTarget(machine.id); setImageRecovery({ machineId: machine.id, operationId: image.operation!.id });
                  setDiscardCandidate(false);
                  setSelection(image.currentImage ? { kind: 'custom', image: image.currentImage } : { kind: 'platform-default' });
                }}>Recover with another image</Button>}
              </div> : null}
            </div> : null}
          </CardHeader>
          <CardFooter>
            <Badge color={machine.state === 'online' ? 'green' : machine.state === 'error' ? 'amber' : 'gray'}>{machine.state === 'sleeping' ? 'stopping' : machine.state === 'resuming' ? 'starting' : machine.provider !== 'physical' && machine.state === 'offline' && machine.desiredState === 'offline' ? 'stopped' : machine.state}</Badge>
            <Button variant="ghost" onClick={() => { setEditing(machine.id); setNotes(machine.notes); }}>Notes</Button>
            {machine.kind === 'sandbox' ? <Button variant="ghost" disabled={active || pending !== null || machine.state !== 'online'} onClick={() => { setImageTarget(machine.id); setImageRecovery(null); setSelection({ kind: 'platform-default' }); }}>Change image</Button> : null}
            {machine.provider !== 'physical' && (machine.state === 'online' || machine.state === 'offline' || machine.state === 'error') ? <Button variant="ghost" disabled={active || pending !== null} onClick={() => {
              if (machine.state === 'online' && !window.confirm(`Stop ${machine.label}?\n\nGitSpace saves supported workspace state before stopping. If saving fails, the machine stays online.\n\nStopping discards installed packages, machine-local configuration, ignored files, and other files GitSpace has not captured, including files in the machine's home directory. Start restores saved workspaces in a fresh machine environment, not the old disk.`)) return;
              void run(machine.id, () => onControlMachine(machine.state === 'online' ? 'sleep' : 'resume', machine.id));
            }}>{machine.state === 'online' ? 'Stop' : 'Start'}</Button> : null}
            {machine.provider !== 'physical' && machine.state !== 'deleting' ? <Button variant="ghost" disabled={active || pending !== null} onClick={() => { if (window.confirm(`Destroy ${machine.label}? This cannot be undone.`)) void run(machine.id, () => onDestroyMachine(machine.id)); }}>Destroy</Button> : null}
          </CardFooter>
        </Card>;
      })}</SettingRows> : <EmptyState icon={icon(Server01, 20)} title="No machines connected" description="Create a cloud machine or connect your own computer. You can also finish account setup and add capacity later." />}
      {editingMachine ? <Panel title={`Machine notes · ${editingMachine.label}`} description="Shared purpose, tools, constraints, and credential boundaries." footer={<><Button variant="secondary" onClick={() => setEditing(null)}>Cancel</Button><Button variant="primary" onClick={() => settle(onUpdateMachine(editingMachine.id, notes).then(() => setEditing(null)))}>Save notes</Button></>}>
        <textarea aria-label="Machine notes" rows={4} value={notes} className={`${shape.input} w-full border border-border bg-surface-2 p-2 text-body text-foreground`} onChange={(event) => setNotes(event.currentTarget.value)} />
      </Panel> : null}
    </Group>
    <Dialog open={discardRequired !== null} onOpenChange={(open) => { if (!open && !operationPending.current) { setDiscardRequired(null); setDiscardPhrase(''); } }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Unsaved work on {requiredPhrase}</DialogTitle>
          <DialogDescription>The machine was not stopped or destroyed. Save or recover this work before trying again, or explicitly discard it below. Discarding cannot be undone.</DialogDescription>
        </DialogHeader>
        {discardRequired ? <>
          <p role="alert" className="text-caption text-destructive">{discardRequired.message}</p>
          <ul className="space-y-1 text-caption">{discardRequired.workspaces.map((scope) => <li key={`${scope.projectId}:${scope.workspaceId}`} className="[overflow-wrap:anywhere]">Project {scope.projectId} · workspace {scope.workspaceId} · generation {scope.generation}: unpublished local work will be lost.</li>)}</ul>
          <p className="text-caption text-muted-foreground">Only completed checkpoints can be restored. Ignored files, installed packages, machine-local configuration, and other uncaptured files on this machine will also be lost.</p>
          <label className="flex flex-col gap-2 text-caption">Type <strong>{requiredPhrase}</strong> to confirm this loss.
            <input aria-label="Confirm machine name" autoComplete="off" value={discardPhrase} disabled={pending !== null} className={`${shape.input} min-h-10 border border-border bg-surface-2 px-3 text-body`} onChange={(event) => setDiscardPhrase(event.currentTarget.value)} />
          </label>
          <DialogFooter>
            <Button variant="secondary" disabled={pending !== null} onClick={() => { setDiscardRequired(null); setDiscardPhrase(''); }}>Cancel discard</Button>
            <Button variant="primary" disabled={pending !== null || discardPhrase !== requiredPhrase} onClick={() => {
              if (operationPending.current || discardPhrase !== requiredPhrase) return;
              const confirmation = discardRequired.confirmation;
              setDiscardRequired(null); setDiscardPhrase('');
              void run(confirmation.machineId, () => confirmation.action === 'sleep'
                ? onControlMachine('sleep', confirmation.machineId, confirmation)
                : onDestroyMachine(confirmation.machineId, confirmation));
            }}>{discardRequired.confirmation.action === 'sleep' ? 'Discard and stop' : 'Discard and destroy'}</Button>
          </DialogFooter>
        </> : null}
      </DialogContent>
    </Dialog>
    {imageTarget ? <Panel title={imageTarget === 'default' ? 'Choose account cloud image' : `Change image · ${machines.find(machine => machine.id === imageTarget)?.label ?? imageTarget}`} description={imageTarget === 'default' ? 'Verify the provider can prepare this image before saving it for future machines.' : 'Only this machine will checkpoint, replace its ephemeral disk, and recover saved workspaces. Ignored files and machine-local changes are not preserved.'} footer={<><Button variant="secondary" disabled={pending !== null} onClick={() => setImageTarget(null)}>Close</Button><Button variant="primary" loading={pending === 'image'} disabled={pending !== null || !cloudImageSelectionSchema.safeParse(selection).success} onClick={() => void run('image', async () => {
      if (imageTarget === 'default') await onSetCloudImageDefault(selection);
      else {
        if (!window.confirm(imageRecovery?.machineId === imageTarget && discardCandidate
          ? 'Allow discarding uncheckpointed work on the currently routed candidate if saving fails?\n\nGitSpace will verify that candidate has stopped, fence its old workspace generations, and restore the last completed checkpoints using the selected image. Uncheckpointed candidate edits and machine-local files will be lost. This cannot be undone.'
          : 'Replace this machine’s ephemeral disk after checkpointing supported workspace state?')) return;
        await onChangeCloudImage(imageTarget, selection, imageRecovery?.machineId === imageTarget ? imageRecovery.operationId : undefined, discardCandidate);
      }
      setImageTarget(null);
      setImageRecovery(null);
    })}>{imageTarget === 'default' ? 'Verify and pin default' : imageRecovery?.machineId === imageTarget ? 'Recover using selected image' : 'Checkpoint and change image'}</Button></>}>
      <CloudImagePicker value={selection} onChange={setSelection} />
      {imageRecovery?.machineId === imageTarget ? <div className="space-y-3">
        <p role="status" className="text-caption">The admission barrier stays in place. GitSpace prepares this image and checkpoints the actual candidate before replacing it. Only a candidate whose container provably never started can reuse its inherited checkpoint without checkpointing candidate work.</p>
        <Switch label="Allow discarding uncheckpointed candidate work if saving fails" checked={discardCandidate} disabled={pending !== null} onToggle={() => setDiscardCandidate(value => !value)} />
        <p className="text-caption text-destructive">Leave this off to preserve candidate work. If the failed image cannot run its checkpoint control interface, explicit discard is the last-resort recovery path: stop the candidate, fence stale writers, and restore only its last completed workspace checkpoints. Uncheckpointed edits, ignored files, installed tools, and other machine-local changes cannot be recovered.</p>
      </div> : null}
    </Panel> : null}
    {setup ? <AddMachinePanel machines={machines} onClose={() => setSetup(false)} />
      : sandboxSetup ? <Panel title="Create temporary cloud machine" description="Create a Cloudflare container using a pinned image. Runtime data not captured by workspace checkpoints is temporary. Cloudflare usage charges may apply." footer={<><Button variant="secondary" disabled={pending !== null} onClick={() => setSandboxSetup(false)}>Cancel</Button><Button variant="primary" loading={pending === 'create'} disabled={pending !== null || (!useAccountImage && !cloudImageSelectionSchema.safeParse(selection).success)} onClick={() => void run('create', async () => { await onCreateSandbox(useAccountImage ? undefined : selection); setSandboxSetup(false); })}>Create cloud machine</Button></>}>
        <Switch label="Use pinned account image" checked={useAccountImage} disabled={pending !== null} onToggle={() => setUseAccountImage((value) => !value)} />
        {useAccountImage ? <p className="break-all font-mono text-caption">{cloudImageDefault?.image ?? 'Resolving account image…'}</p> : <CloudImagePicker value={selection} onChange={setSelection} />}
      </Panel>
      : <div className="flex flex-wrap items-center gap-2"><Button variant="primary" onClick={() => setSetup(true)}>{icon(Terminal)}Add a computer</Button><Button variant="secondary" onClick={() => { setSandboxSetup(true); setUseAccountImage(true); setSelection({ kind: 'platform-default' }); }}>{icon(Server01)}Create cloud machine</Button></div>}
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
  const omp = ompRollup(release);
  return <Card size="compact" index={index}>
    <CardHeader>
      <CardTitle>{release.label}{desired ? <Badge color="blue">Desired</Badge> : null}</CardTitle>
      <CardDescription><span className="font-mono">{shortSha(release.sha)}</span> · built {new Date(release.createdAt).toLocaleString()}{release.workspaceId ? ` · from workspace ${release.workspaceId}` : ''}</CardDescription>
      {release.error ? <p role="alert" className="text-caption text-destructive">{release.error}</p> : null}
    </CardHeader>
    <CardFooter>
      {release.artifacts.worker ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[release.status.worker]}>{RELEASE_TARGET_LABEL.worker} · {release.status.worker}</Badge> : null}
      {release.artifacts.machine ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[machines.status]}>{machines.text}</Badge> : null}
      {release.artifacts.omp ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[omp.status]}>{omp.text} · {release.omp?.upstreamVersion ?? 'unknown'}</Badge> : null}
      {release.artifacts.frontend ? <Badge variant="dot" color={RELEASE_STATUS_COLOR[release.status.frontend]}>{RELEASE_TARGET_LABEL.frontend} · {release.status.frontend}</Badge> : null}
    </CardFooter>
  </Card>;
}
export function SourceSettings({ deployment, onRevertDeployment, saving }: Pick<SettingsPageProps, 'deployment' | 'onRevertDeployment' | 'saving'>) {
  if (!deployment) return <Group title="Running"><EmptyState icon={icon(Rocket02, 20)} title="Loading source status…" description="Asking the home machine what GitSpace runs." /></Group>;
  const others = Object.entries(deployment.current.machines).filter(([machineId]) => machineId !== deployment.thisMachine.machineId);
  const releases = [...deployment.releases].sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const channel = RELEASE_TARGETS.every((target) => deployment.desired[target] === null);
  return <>
    <Group title="Running"><SettingRows>
      <SettingRow title={<>This machine<Badge color="green">Home</Badge></>} description={<span className="font-mono">{deployment.thisMachine.machineId}</span>}><RunningBadge sha={deployment.thisMachine.sha} generation={deployment.thisMachine.generation} /></SettingRow>
      <SettingRow title="Worker" description="The tenant worker answering this account, by its own version stamp."><Badge color={deployment.current.worker.sha === null ? 'gray' : 'blue'}><span className="font-mono">{deployment.current.worker.version ?? 'unknown'}</span></Badge></SettingRow>
      {deployment.current.platformWorker && deployment.current.platformWorker.version !== deployment.current.worker.version ? <SettingRow title="Platform record" description="The platform’s last recorded deployment differs from the Worker answering this request."><Badge color="gray"><span className="font-mono">{deployment.current.platformWorker.version ?? 'Not recorded'}</span></Badge></SettingRow> : null}
      {others.map(([machineId, running]) => <SettingRow key={machineId} title={machineId} description={`Machine ${running.sha ? shortSha(running.sha) : 'stable'}`}><RunningBadge sha={running.sha} generation={running.generation} /></SettingRow>)}
    </SettingRows></Group>
    {Object.entries(deployment.machineExecution ?? {}).filter(([, execution]) => execution.state !== 'ready').map(([machineId, execution]) => <Group key={machineId} title={execution.state === 'blocked' ? 'Machine update blocked' : 'Updating machine'}><SettingRows>
      <SettingRow title={machineId} description={execution.error ?? `Updating to ${execution.releaseSha ? shortSha(execution.releaseSha) : 'the current channel release'} before agent execution. Workspaces, builds, and Launch remain available.`}><Badge color={execution.state === 'blocked' ? 'red' : 'blue'}>{execution.state === 'blocked' ? 'Needs attention' : 'Updating'}</Badge></SettingRow>
    </SettingRows></Group>)}
    <Group title="Desired"><SettingRows>
      {RELEASE_TARGETS.map((target) => <SettingRow key={target} title={RELEASE_TARGET_LABEL[target]} description={desiredLabel(deployment, target)}><Badge color={deployment.desired[target] === null ? 'gray' : 'blue'}>{deployment.desired[target] === null ? 'Channel' : 'Release'}</Badge></SettingRow>)}
      <SettingRow title="All targets" description={`Selections updated ${new Date(deployment.desired.updatedAt).toLocaleString()}`}>
        <Button variant="secondary" size="compact" disabled={channel || saving} onClick={() => { if (window.confirm('Go back to the stable GitSpace build? The worker swaps now; machines and the frontend follow.')) settle(onRevertDeployment()); }}>Back to stable</Button>
      </SettingRow>
    </SettingRows></Group>
    <Group title="Releases">{releases.length
      ? <SettingRows>{releases.map((release) => <ReleaseRow key={release.sha} release={release} desired={RELEASE_TARGETS.some((target) => deployment.desired[target] === release.sha)} />)}</SettingRows>
      : <EmptyState icon={icon(Rocket02, 20)} title="No releases yet" description="Launch GitSpace from a workspace of the GitSpace project to build one." />}</Group>
  </>;
}
function DefaultsSettings({ settings, machines, onChange }: Pick<SettingsPageProps, 'settings' | 'machines' | 'onChange'>) {
  const update = (value: Partial<UserSettings['defaults']>) => onChange(replace(settings, 'defaults', { ...settings.defaults, ...value }));
  return <>
    <Group title="Placement"><SettingRows><SettingRow title="Default machine" description="New spaces open here when available."><Select value={settings.defaults.machineId ?? ''} onValueChange={(value) => update({ machineId: value || null })}><SelectTrigger aria-label="Default machine" />{selectOptions([{ value: '', label: 'Automatic' }, ...machines.map((machine) => ({ value: machine.id, label: machine.label }))])}</Select></SettingRow></SettingRows></Group>
    <Group title="Setup"><SettingRows><SettingRow title="Run setup again" description="Walk through profile, runtime, providers, Git, machine, and defaults from the start."><Button variant="secondary" size="compact" asChild><a href="/settings?mode=onboarding" onClick={(event) => { if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return; event.preventDefault(); const url = new URL(window.location.href); url.searchParams.set('mode', 'onboarding'); navigateProductUrl(url); }}>Open setup</a></Button></SettingRow></SettingRows></Group>
  </>;
}

const sectionInfo: Array<{ id: Section; label: string; icon: (typeof ICONS)[keyof typeof ICONS]; kicker: string; title: string; description: string }> = [
  { id: 'profile', label: 'Profile', icon: ICONS.user, kicker: 'Account', title: 'Your GitSpace profile', description: 'Cloud-owned identity and namespace shared by every machine.' },
  { id: 'runtime', label: 'Runtime', icon: ICONS.bot, kicker: 'Runtime', title: 'Shared Advanced settings', description: 'Shared runtime configuration for every inference profile. Manage Models, Agents, and Providers under Navigate → Inference.' },
  { id: 'runtime-providers', label: 'Inference', icon: ICONS.cpu, kicker: 'Default inference', title: 'Set up Default inference', description: 'Connect providers and configure the Default profile. The same profile is available under Navigate → Inference after setup.' },
  { id: 'git', label: 'Git', icon: ICONS.git, kicker: 'Git', title: 'Shared Git identity', description: 'One GitSpace SSH identity and commit attribution shared by your enrolled machines.' },
  { id: 'machines', label: 'Machines', icon: ICONS.server, kicker: 'Machines', title: 'Machines', description: 'Live fleet state and placement notes from GitSpace Cloud.' },
  { id: 'connections', label: 'Connections', icon: ICONS.key, kicker: 'Connections', title: 'Connections', description: 'Plugin providers, browser control, and enrolled devices for this account and machine.' },
  { id: 'hostnames', label: 'Domains', icon: ICONS.globe, kicker: 'Domains', title: 'Hostname', description: 'Your globally reserved GitSpace namespace.' },
  { id: 'source', label: 'Source', icon: ICONS.rocket, kicker: 'Source', title: 'What GitSpace runs', description: 'The account-owned worker, machine runtime, and frontend. Launch any target independently from the GitSpace project; return to stable here.' },
  { id: 'defaults', label: 'Defaults', icon: ICONS.settings, kicker: 'Defaults', title: 'Workspace defaults', description: 'Cloud-owned defaults for new work.' },
];
// The settings tab strip; the providers step only exists as an onboarding step.
const settingsTabs = sectionInfo.filter((item) => item.id !== 'runtime-providers');
export function requestedSettingsSection(search: string): { section: Section } {
  const requested = new URLSearchParams(search).get('section');
  const section = settingsTabs.find((item) => item.id === requested)?.id ?? 'profile';
  return { section };
}
function SaveState({ saving, error }: Pick<SettingsPageProps, 'saving' | 'error'>) {
  if (error) return <span role="alert" className="text-caption text-destructive">{error}</span>;
  return saving ? <span className="text-caption text-muted-foreground">Saving…</span> : null;
}
function SettingsContent({ section, ...props }: { section: Section } & SettingsPageProps) {
  if (section === 'runtime') return <RuntimeSettingsEditor {...props} sections={['Advanced']} />;
  if (section === 'runtime-providers') return <>{props.inferenceSetup}</>;
  if (section === 'git') return <GitSettings {...props} />;
  if (section === 'machines') return <MachineSettings {...props} />;
  if (section === 'connections') return <ConnectionsSettings {...props} />;
  if (section === 'hostnames') return <HostnameSettings settings={props.settings} />;
  if (section === 'source') return <SourceSettings {...props} />;
  if (section === 'defaults') return <DefaultsSettings {...props} />;
  return <ProfileSettings {...props} />;
}
function SectionHeader({ section, actions, ...props }: { section: Section; actions?: ReactNode } & Pick<SettingsPageProps, 'runtimeSync'>) {
  const info = sectionInfo.find((item) => item.id === section) ?? sectionInfo[0]!;
  return <PageHeader kicker={info.kicker} title={info.title} description={info.description} actions={<>{section === 'runtime' ? <RuntimeSyncBadge runtimeSync={props.runtimeSync} /> : null}{actions}</>} />;
}
function SettingsShell(props: SettingsPageProps) {
  const [requested] = useState(() => requestedSettingsSection(typeof window === 'undefined' ? '' : window.location.search));
  const [section, setSection] = useState<Section>(requested.section);
  const selectedIndex = settingsTabs.findIndex((item) => item.id === section);
  return <PageCanvas>
    <div className="pb-4"><Button variant="ghost" size="compact" aria-label="Back to workspace" onClick={props.onBack} leadingIcon={glyph(ArrowLeft)}>Back to workspace</Button></div>
    <SectionHeader section={section} runtimeSync={props.runtimeSync} actions={<><SaveState {...props} /><Button variant="primary" disabled={props.saving} onClick={() => settle(props.onSave(props.settings))}>{props.saving ? 'Saving' : 'Save changes'}</Button></>} />
    <div className="pb-6"><TabsSubtle selectedIndex={selectedIndex} idPrefix="settings-section" onSelect={(index) => setSection(settingsTabs[index]?.id ?? 'profile')}>{settingsTabs.map(({ id, label, icon: Icon }, index) => <TabsSubtleItem key={id} index={index} label={label} icon={Icon} />)}</TabsSubtle></div>
    <TabsSubtlePanel index={selectedIndex} selectedIndex={selectedIndex} idPrefix="settings-section" className="flex flex-col gap-8"><SettingsContent section={section} {...props} /></TabsSubtlePanel>
  </PageCanvas>;
}
function OnboardingShell(props: SettingsPageProps) {
  const [step, setStep] = useState(0);
  const steps: Array<{ label: string; section: Section }> = [{ label: 'Profile', section: 'profile' }, { label: 'Machine', section: 'machines' }, { label: 'Inference', section: 'runtime-providers' }, { label: 'Advanced', section: 'runtime' }, { label: 'Git', section: 'git' }, { label: 'Defaults', section: 'defaults' }];
  const current = steps[step]!;
  const last = step === steps.length - 1;
  const profileIncomplete = step === 0 && (!props.settings.profile.displayName.trim() || !props.settings.profile.handle);
  const advance = async () => { if (last) await props.onComplete({ ...props.settings, onboardingComplete: true }); else { await props.onSave(props.settings); setStep((value) => value + 1); } };
  return <PageCanvas>
    <div className="flex items-center justify-between gap-4 pb-4">
      <span className="flex items-center gap-2 text-body font-semibold text-foreground">{icon(Zap)}GitSpace</span>
      <span className="flex items-center gap-3"><SaveState {...props} /><Badge color="gray"><span className="tabular-nums">{step + 1} of {steps.length}</span></Badge></span>
    </div>
    <SectionHeader section={current.section} runtimeSync={props.runtimeSync} actions={<span aria-hidden className="flex items-center gap-1.5">{steps.map(({ label }, index) => <i key={label} className={`h-1.5 w-1.5 rounded-full ${index === step ? 'bg-foreground' : 'bg-border'}`} />)}</span>} />
    <div className="flex flex-col gap-8"><SettingsContent section={current.section} {...props} /></div>
    {last ? <Group title="Your GitSpace source"><SettingRows><SettingRow title="GitSpace is included" description="Your account always includes the GitSpace source project. Open it on a machine when you are ready to make changes; setup does not need a running machine or GitHub authorization."><Badge color="green">Included</Badge></SettingRow></SettingRows></Group> : null}
    <footer className="mt-10 flex items-center justify-between gap-4 border-t border-border pt-6">
      <Button variant="secondary" disabled={step === 0 || props.saving} onClick={() => setStep((value) => value - 1)}>Back</Button>
      <Button variant="primary" disabled={profileIncomplete || props.saving} onClick={() => settle(advance())}>{last ? props.saving ? 'Finishing setup…' : 'Open GitSpace' : 'Continue'}</Button>
    </footer>
  </PageCanvas>;
}
// The account frame owns navigation; this column contains the scrolling settings pane.
export function SettingsPage(props: SettingsPageProps) { return <div className="flex min-h-0 flex-1 flex-col bg-background text-foreground">{props.mode === 'onboarding' ? <OnboardingShell {...props} /> : <SettingsShell {...props} />}</div>; }
