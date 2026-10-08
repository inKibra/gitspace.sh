// Isolated visual fixture: no enrollment, RPC transport, provider requests, or secret persistence.
import { useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InferenceProfile, InferenceState } from '@gitspace/protocol/inference';
import { Button, IconProvider, ShapeProvider, SidebarInset, SidebarProvider, SizeProvider, TooltipProvider, untitledIcons } from '@gitspace/ui';
import { MotionConfig } from 'framer-motion';
import '@gitspace/ui/fluid-theme.css';
import { InferencePage } from '../src/InferencePage.js';
import { InferenceContext, type InferenceController } from '../src/InferenceContext.js';
import { AppSidebar } from '../src/AppSidebar.js';
import type { RuntimeSettingView } from '../src/SettingsPage.js';
import type { ProviderLoginFlow, ProvidersSectionProps } from '../src/ProvidersSection.js';
import { AccountWorkPages } from '../src/AccountWorkPages.js';
import { Composer } from '../src/Composer.js';
import type { SessionControlsProps } from '../src/GitSpaceShell.js';
import { verticalSliceFixture } from '../src/App.js';
import '../src/styles.css';
import './settings-preview.css';

const now = '2026-09-25T00:00:00.000Z';
const profiles: InferenceProfile[] = [
  { version: 1, id: 'default', name: 'Default', revision: 1, settings: { modelRoles: { default: 'anthropic/claude', task: 'anthropic/claude' }, cycleOrder: ['default'], agents: { enabled: true } }, createdAt: now, updatedAt: now },
  { version: 1, id: 'client-a', name: 'Client A', revision: 2, settings: { modelRoles: { default: 'private/missing-model' }, cycleOrder: ['default'], agents: { enabled: false } }, createdAt: now, updatedAt: now },
];
const projects = [{ id: 'project-a', name: 'GitSpace' }, { id: 'project-b', name: 'Client website' }];
// Enough providers and models that the searchable model pickers have something to narrow.
const previewModels = [
  { provider: 'anthropic', id: 'claude', name: 'Claude', contextWindow: 200000 },
  ...['claude-sonnet-4-5', 'claude-opus-4-1', 'claude-haiku-4-5', 'nova-pro-v1', 'nova-lite-v1', 'llama4-maverick', 'mistral-large-2407', 'deepseek-r1'].map((id) => ({
    provider: 'amazon-bedrock', id: `us.${id}`, name: id.split('-').map((word) => word[0]!.toUpperCase() + word.slice(1)).join(' '), contextWindow: 200000,
  })),
  ...['gpt-6-astra', 'gpt-5.6-luna', 'gpt-5.6-codex'].map((id) => ({ provider: 'openai-codex', id, name: id.toUpperCase(), contextWindow: 400000 })),
];
const initial: InferenceState = { version: 1, revision: 2, profiles, assignments: [{ projectId: 'project-a', profileId: 'default', revision: 0 }, { projectId: 'project-b', profileId: 'client-a', revision: 1 }] };
const schema: RuntimeSettingView[] = [
  { path: 'modelRoles', label: 'Model roles', tab: 'models', description: null, kind: 'record', valueJson: '{}', defaultJson: '{}', options: [], credential: false },
  { path: 'cycleOrder', label: 'Quick cycle', tab: 'models', description: null, kind: 'array', valueJson: '["default"]', defaultJson: '["default"]', options: [], credential: false },
  { path: 'modelTags', label: 'Model tags', tab: 'models', description: null, kind: 'record', valueJson: '{}', defaultJson: '{}', options: [], credential: false },
  { path: 'task.agentModelOverrides', label: 'Agent roles', tab: 'task', description: null, kind: 'record', valueJson: '{}', defaultJson: '{}', options: [], credential: false },
  { path: 'agents.enabled', label: 'Enable agents', tab: 'task', description: 'Allow task agents in this profile.', kind: 'boolean', valueJson: 'true', defaultJson: 'true', options: [], credential: false },
];

function Preview() {
  const [state, setState] = useState(initial);
  const latest = useRef(state);
  latest.current = state;
  const [selected, setSelected] = useState('default');
  const [view, setView] = useState<'agent' | 'inference' | 'projects'>('inference');
  const [projectId, setProjectId] = useState('project-b');
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<ProviderLoginFlow | null>(null);
  const [model, setModel] = useState({ provider: 'openai-codex', id: 'gpt-6-astra' });
  const idle = async (): Promise<void> => {};
  const sessionControls: SessionControlsProps = {
    value: { sessionId: 'preview-session', role: null, roleLabel: null, roles: [], provider: model.provider, models: previewModels, model: model.id, thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null },
    onSetModel: async (provider, id) => { setModel({ provider, id }); },
    onCycleRole: idle, onSetThinking: idle, onSetFast: idle, onSetApproval: idle, onSetGoal: idle, onCompact: idle, onClearQueue: idle, onRemoveQueuedMessage: idle, onPromoteQueuedMessage: idle, onAnswerAsk: idle, onStop: idle, onNavigateTree: idle,
  };
  const save = (next: InferenceState): InferenceState => {
    const committed = { ...next, revision: latest.current.revision + 1 };
    latest.current = committed;
    setState(committed);
    setError(null);
    return committed;
  };
  const conflict = (): never => {
    setError('Settings changed since you loaded them. Refresh before saving again.');
    throw new Error('Settings changed since you loaded them. Refresh before saving again.');
  };
  const controller: InferenceController = {
    state, loading: false, pending: false, activationPending: false, error,
    refresh: async () => { setError(null); },
    create: async (name, sourceProfileId) => {
      const current = latest.current;
      const source = current.profiles.find((item) => item.id === (sourceProfileId ?? 'default'))!;
      return save({ ...current, profiles: [...current.profiles, { ...source, id: `preview-${current.revision}`, name, settings: structuredClone(source.settings), revision: 0 }] });
    },
    update: async (profile, name, settings) => {
      const current = latest.current;
      if (current.profiles.find((item) => item.id === profile.id)?.revision !== profile.revision) return conflict();
      return save({ ...current, profiles: current.profiles.map((item) => item.id === profile.id ? { ...item, name, settings, revision: item.revision + 1 } : item) });
    },
    remove: async (profile) => {
      const current = latest.current;
      if (current.profiles.find((item) => item.id === profile.id)?.revision !== profile.revision) return conflict();
      if (profile.id === 'default' || current.assignments.some((item) => item.profileId === profile.id)) throw new Error('Reassign projects before deleting a non-Default profile.');
      return save({ ...current, profiles: current.profiles.filter((item) => item.id !== profile.id) });
    },
    assign: async (assignment, profileId) => {
      const current = latest.current;
      if (current.assignments.find((item) => item.projectId === assignment.projectId)?.revision !== assignment.revision) return conflict();
      return save({ ...current, assignments: current.assignments.map((item) => item.projectId === assignment.projectId ? { ...item, profileId, revision: item.revision + 1 } : item) });
    },
  };
  const providers: ProvidersSectionProps = {
    providers: [{ id: 'anthropic', name: 'Anthropic', credentialProvider: 'anthropic', authKind: 'oauth', supportsOAuth: true, supportsApiKey: true, loginable: true, available: true, hasAuth: selected === 'default', source: selected === 'default' ? 'oauth' : null, hasUsage: false, accounts: selected === 'default' ? [{ id: 'preview-account', type: 'oauth', label: 'Default fixture account', email: null, disabled: false }] : [] }],
    usage: null, usageStatus: 'idle', onShow() {}, onRefreshUsage: async () => {},
    onSignIn: async (providerId) => { setFlow({ flowId: 'preview-flow', profileId: selected, providerId, events: [{ type: 'auth', url: 'https://example.test/isolated-oauth-preview', launchUrl: null, instructions: 'Isolated fixture only. Do not open the URL or enter real credentials.' }] }); },
    onSignOut: async () => { throw new Error('Fixture account removal is disabled; no live account is connected.'); },
    onSetApiKey: async () => { throw new Error('Do not enter real keys. This isolated fixture does not store credentials.'); },
    login: { flow: flow?.profileId === selected ? flow : null, respond: async () => { throw new Error('This isolated fixture does not submit OAuth callbacks.'); }, cancel: async () => setFlow(null) },
  };
  return <InferenceContext.Provider value={controller}><SidebarProvider className="gitspace-shell" persist={false}>
    <AppSidebar view={view} onView={(next) => { if (next === 'inference' || next === 'projects') setView(next); }} selected={view === 'agent' ? { projectId, workspaceId: null } : null} projects={projects.map((project) => ({ ...project, workspaces: [] }))} machines={[]} onSelectProject={(id) => { setProjectId(id); setView('agent'); }} onSelectWorkspace={() => {}} onOpenSettings={() => { window.location.href = '/test/settings-preview.html?section=omp'; }} />
    <SidebarInset className="min-w-0 overflow-hidden"><div className="flex flex-wrap items-center gap-3 px-8 py-3 text-caption text-muted-foreground"><span>Isolated UI fixture — no live account, provider requests, or secrets.</span><Button variant="ghost" size="compact" onClick={() => { const current = latest.current; save({ ...current, profiles: current.profiles.map((item) => item.id === selected ? { ...item, revision: item.revision + 1 } : item) }); }}>Simulate remote revision</Button></div>
      {view === 'inference' ? <InferencePage inference={controller} selectedProfileId={selected} onSelectProfile={setSelected} projects={projects} schema={schema} schemaLoading={false} schemaError={null} onRefreshSchema={() => {}} models={selected === 'default' ? previewModels : []} modelsReady={true} modelsLoading={false} modelsError={null} providers={providers} />
        : view === 'projects' ? <AccountWorkPages view="projects" projects={projects.map((project) => ({ ...project, lifecycle: 'active', repositoryReference: null, baseBranch: 'main', role: null, source: null, revision: 0, archivedAt: null, updatedAt: new Date(now) }))} directory={Object.fromEntries(projects.map((project) => [project.id, { workspaces: [] }]))} loading={false} onRefresh={() => {}} onOpenWorkspace={() => {}} onOpenProject={(id) => { setProjectId(id); setView('agent'); }} actions={{}} />
        : <div className="flex flex-1 items-end p-8"><Composer workspace={{ ...verticalSliceFixture.workspace, projectId }} controls={sessionControls} running={false} pending={false} /></div>}
    </SidebarInset>
  </SidebarProvider></InferenceContext.Provider>;
}
const root = document.getElementById('root');
if (!root) throw new Error('preview root missing');
createRoot(root).render(<MotionConfig reducedMotion="user"><ShapeProvider defaultShape="rounded"><SizeProvider defaultSize="default"><IconProvider icons={untitledIcons}><TooltipProvider><Preview /></TooltipProvider></IconProvider></SizeProvider></ShapeProvider></MotionConfig>);
