import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, TabsSubtle, TabsSubtleItem, TabsSubtlePanel, useShape } from '@gitspace/ui';
import { Key01, LayoutRight, ShieldTick, Terminal } from '@untitledui/icons';
import { useState } from 'react';
import { glyph } from '../glyph.js';
import { changedCheckTrust, environmentFixture, secretsPageFixture } from './fixtures.js';
import { EnvironmentView } from './EnvironmentView.js';
import { ApproveCheckDialogMock, SecretsPageMock } from './SecretsPageMock.js';
import type { EnvironmentCheckDefinition, EnvironmentViewModel, SecretsPageViewModel, TrustState } from './types.js';

const EnvironmentIcon = glyph(LayoutRight);
const KeyIcon = glyph(Key01);
const ShieldIcon = glyph(ShieldTick);
const TerminalIcon = glyph(Terminal);
const TAB_LABELS = ['Workspace setup', 'Secrets & values', 'Approve dialog'] as const;

function approvedTrust(commandHash: string): TrustState {
  return { status: 'approved', approvedBy: 'This browser', approvedAt: 'just now', commandHash };
}

export function EnvironmentGallery() {
  const shape = useShape();
  const [tab, setTab] = useState(0);
  const [environment, setEnvironment] = useState<EnvironmentViewModel>(environmentFixture);
  const [secrets, setSecrets] = useState<SecretsPageViewModel>(secretsPageFixture);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [activity, setActivity] = useState('Fixture data · no backend connected');

  const changeTab = (index: number): void => {
    setTab(index);
    setDialogOpen(index === 2);
  };
  const approve = (targetId: string): void => {
    setEnvironment((current) => {
      const check = current.bundle.checks[targetId];
      if (check?.trust) return { ...current, bundle: { ...current.bundle, checks: { ...current.bundle.checks, [targetId]: { ...check, trust: approvedTrust(check.trust.commandHash) } } } };
      return { ...current, lifecycle: current.lifecycle.map((script) => script.id === targetId ? { ...script, trust: approvedTrust(script.trust.commandHash) } : script) };
    });
    setActivity(`Approved ${targetId} for its current command hash`);
  };
  const revoke = (targetId: string): void => {
    setEnvironment((current) => {
      const check = current.bundle.checks[targetId];
      if (check?.trust) return { ...current, bundle: { ...current.bundle, checks: { ...current.bundle.checks, [targetId]: { ...check, trust: { status: 'pending', commandHash: check.trust.commandHash } } } } };
      return { ...current, lifecycle: current.lifecycle.map((script) => script.id === targetId ? { ...script, trust: { status: 'pending', commandHash: script.trust.commandHash } } : script) };
    });
    setActivity(`Revoked approval for ${targetId}`);
  };
  const grantSecret = (name: string): void => {
    setTab(1);
    setActivity(`Choose where to store or grant ${name}`);
  };
  const updateInput = (name: string, value: string): void => {
    setEnvironment((current) => ({ ...current, inputValues: current.inputValues.map((input) => input.name === name ? { ...input, value, source: 'workspace' } : input) }));
  };
  const fixCheck = (checkId: string): void => {
    setEnvironment((current) => ({
      ...current,
      machines: current.machines.map((machine) => machine.id === current.workspace.machineId ? { ...machine, capabilities: { ...machine.capabilities, [checkId]: { status: 'pass', output: checkId === 'wrangler' ? 'wrangler 4.31.0 · bradleat' : 'fixed' } } } : machine),
    }));
    setActivity(`Opened terminal to fix ${checkId}`);
  };
  const runLifecycle = (phase: 'setup' | 'select' | 'remove'): void => {
    setEnvironment((current) => ({ ...current, lifecycle: current.lifecycle.map((script) => script.phase === phase && (!script.profiles || script.profiles.includes(current.workspace.profile)) && script.trust.status === 'approved' ? { ...script, lastRun: { status: 'succeeded', relativeTime: 'just now', duration: script.id.includes('install') ? '41s' : '0.4s', output: `${phase} completed.` } } : script) }));
    setActivity(`Opened terminal · running ${phase} scripts for ${environment.workspace.profile}`);
  };
  const updateCheck = (checkId: string, patch: Partial<Pick<EnvironmentCheckDefinition, 'label' | 'probe' | 'requirement'>>): void => {
    setEnvironment((current) => {
      const check = current.bundle.checks[checkId]!;
      const commandChanged = patch.probe !== undefined && patch.probe !== check.probe && check.trust;
      const trust = !commandChanged ? check.trust
        : check.trust?.status === 'approved' ? { status: 'changed' as const, commandHash: `sha256:edited-${checkId}`, approvedCommand: check.probe ?? '', currentCommand: patch.probe ?? '', approvedBy: check.trust.approvedBy, approvedAt: check.trust.approvedAt }
          : check.trust?.status === 'changed' ? { ...check.trust, commandHash: `sha256:edited-${checkId}`, currentCommand: patch.probe ?? '' }
            : { status: 'pending' as const, commandHash: `sha256:edited-${checkId}` };
      return { ...current, bundle: { ...current.bundle, checks: { ...current.bundle.checks, [checkId]: { ...check, ...patch, trust } } } };
    });
  };
  const deleteCheck = (checkId: string): void => {
    setEnvironment((current) => ({
      ...current,
      bundle: {
        ...current.bundle,
        checks: Object.fromEntries(Object.entries(current.bundle.checks).filter(([id]) => id !== checkId)),
        profiles: Object.fromEntries(Object.entries(current.bundle.profiles).map(([name, profile]) => [name, { ...profile, checks: profile.checks.filter((id) => id !== checkId) }])),
      },
    }));
    setActivity(`Deleted check ${checkId}`);
  };
  const addCheck = (check: EnvironmentCheckDefinition): void => {
    setEnvironment((current) => {
      const profile = current.bundle.profiles[current.workspace.profile]!;
      return { ...current, bundle: { ...current.bundle, checks: { ...current.bundle.checks, [check.id]: check }, profiles: { ...current.bundle.profiles, [current.workspace.profile]: { ...profile, checks: [...profile.checks, check.id] } } } };
    });
    setActivity(`Added check ${check.id} to ${environment.workspace.profile}`);
  };
  const addWorkspaceValue = (name: string, defaultValue: string): void => {
    setEnvironment((current) => {
      const profile = current.bundle.profiles[current.workspace.profile]!;
      return {
        ...current,
        bundle: {
          ...current.bundle,
          inputs: { ...current.bundle.inputs, [name]: { default: defaultValue } },
          profiles: { ...current.bundle.profiles, [current.workspace.profile]: { ...profile, inputs: [...profile.inputs, name] } },
        },
        inputValues: [...current.inputValues, { name, value: defaultValue, source: 'project' }],
      };
    });
    setActivity(`Added value ${name} to ${environment.workspace.profile}`);
  };
  const grantUserSecret = (name: string, project: string): void => {
    setSecrets((current) => ({ ...current, userSecrets: current.userSecrets.map((secret) => secret.name === name && !secret.projects.includes(project) ? { ...secret, projects: [...secret.projects, project] } : secret) }));
    setActivity(`Granted ${name} to ${project}`);
  };
  const revokeUserSecret = (name: string, project: string): void => {
    setSecrets((current) => ({ ...current, userSecrets: current.userSecrets.map((secret) => secret.name === name ? { ...secret, projects: secret.projects.filter((candidate) => candidate !== project) } : secret) }));
    setActivity(`Revoked ${name} from ${project}`);
  };
  const addSecret = (name: string, scope: 'global' | 'project', project?: string): void => {
    setSecrets((current) => ({
      ...current,
      userSecrets: scope === 'global' ? [...current.userSecrets, { name, updated: 'just now', projects: [] }] : current.userSecrets,
      projectSecrets: scope === 'project' ? [...current.projectSecrets, { name, updated: 'just now', project: project ?? current.selectedProject, requiredBy: current.missing.find((secret) => secret.name === name)?.requiredBy ?? [] }] : current.projectSecrets,
      missing: scope === 'project' && (project ?? current.selectedProject) === current.selectedProject ? current.missing.filter((secret) => secret.name !== name) : current.missing,
    }));
    setActivity(`Added ${name} to ${scope === 'global' ? 'global secrets' : project ?? secrets.selectedProject}`);
  };
  const updateValue = (name: string, value: string, project: string): void => {
    setSecrets((current) => ({ ...current, projectValues: current.projectValues.map((entry) => entry.name === name && entry.project === project ? { ...entry, value, updated: 'just now' } : entry) }));
  };
  const addProjectValue = (name: string, value: string, project: string): void => {
    setSecrets((current) => ({ ...current, projectValues: [...current.projectValues, { name, value, project, updated: 'just now', requiredBy: [] }] }));
    setActivity(`Added value ${name} to ${project}`);
  };

  return <main className="flex h-screen min-h-0 flex-col bg-surface-1 text-foreground">
    <header className="flex shrink-0 flex-wrap items-end justify-between gap-4 bg-surface-2 px-6 py-4 shadow-surface-1">
      <div className="flex flex-col gap-1"><span className="text-caption text-muted-foreground">GitSpace 1.x concept</span><h1 className="text-title font-semibold text-foreground">Bundle & lifecycle</h1><p className="text-body text-muted-foreground">Inline workspace setup, profile-aware scripts, secrets, values, and exact-command approval.</p></div>
      <TabsSubtle selectedIndex={tab} onSelect={changeTab} idPrefix="environment-gallery" aria-label="Environment gallery pages">
        <TabsSubtleItem index={0} icon={EnvironmentIcon} label={TAB_LABELS[0]} />
        <TabsSubtleItem index={1} icon={KeyIcon} label={TAB_LABELS[1]} />
        <TabsSubtleItem index={2} icon={ShieldIcon} label={TAB_LABELS[2]} />
      </TabsSubtle>
    </header>
    <div className="min-h-0 flex-1">
      <TabsSubtlePanel index={0} selectedIndex={tab} idPrefix="environment-gallery" className="h-full min-h-0">
        <div className="grid h-full min-h-0 grid-cols-1 lg:grid-cols-[180px_minmax(0,1fr)_420px]">
          <nav className="hidden min-h-0 flex-col gap-1 bg-surface-3 p-3 lg:flex" aria-label="Application sidebar">
            <span className="px-2 pb-2 text-caption font-medium text-muted-foreground">GitSpace</span>
            <Button variant="secondary" className="justify-start">Workspaces</Button>
            <Button variant="ghost" className="justify-start">Machines</Button>
            <Button variant="ghost" className="justify-start" onClick={() => setTab(1)}>Secrets & values</Button>
            <Button variant="ghost" className="justify-start">Skills</Button>
            <Button variant="ghost" className="justify-start">Composio</Button>
          </nav>
          <section className="hidden min-h-0 flex-col gap-4 bg-surface-2 p-6 lg:flex" aria-label="Workspace canvas placeholder">
            <div className="flex items-center justify-between gap-3"><Badge variant="dot" color="green">agent-blame</Badge><span className="text-caption text-muted-foreground">{activity}</span></div>
            <div className={`${shape.container} flex min-h-0 flex-1 items-center justify-center bg-surface-1 p-8 shadow-surface-1`}>
              <div className="flex max-w-md flex-col items-center gap-3 text-center"><TerminalIcon size={24} strokeWidth={1.5} className="text-muted-foreground" /><h2 className="text-subtitle font-semibold text-foreground">{activity.startsWith('Opened file') ? 'File viewer' : activity.includes('terminal') ? 'Lifecycle terminal' : 'Workspace canvas'}</h2><p className="text-body text-muted-foreground">{activity.startsWith('Opened file') ? activity.replace('Opened file · ', '') : activity.includes('terminal') ? activity : 'The transcript stays open while workspace setup remains in the right inspector.'}</p>{activity.includes('terminal') ? <code className={`${shape.container} w-full bg-surface-3 p-3 text-left font-mono text-caption text-foreground`}>$ {activity.replace('Opened terminal · ', '')}<br />running approved scripts…</code> : null}</div>
            </div>
          </section>
          <aside className="flex min-h-0 bg-surface-1 lg:border-l lg:border-border" aria-label="Workspace setup inspector"><EnvironmentView model={environment} onProfileChange={(profile) => setEnvironment((current) => ({ ...current, workspace: { ...current.workspace, profile } }))} onApprove={approve} onRevoke={revoke} onGrantSecret={grantSecret} onInputChange={updateInput} onFixCheck={fixCheck} onUpdateCheck={updateCheck} onDeleteCheck={deleteCheck} onAddCheck={addCheck} onAddValue={addWorkspaceValue} onOpenSecrets={() => setTab(1)} onOpenLifecycleFile={(scriptId) => setActivity(`Opened file · .gitspace/lifecycle/${scriptId}`)} onOpenLifecycleOutput={(scriptId) => setActivity(`Opened terminal · output for ${scriptId}`)} onRunChecks={() => setActivity('Opened terminal · running environment checks')} onRunLifecycle={runLifecycle} /></aside>
        </div>
      </TabsSubtlePanel>
      <TabsSubtlePanel index={1} selectedIndex={tab} idPrefix="environment-gallery" className="h-full min-h-0"><SecretsPageMock model={secrets} onProjectChange={(selectedProject) => setSecrets((current) => ({ ...current, selectedProject }))} onGrant={grantUserSecret} onRevoke={revokeUserSecret} onAddSecret={addSecret} onUpdateValue={updateValue} onAddValue={addProjectValue} /></TabsSubtlePanel>
      <TabsSubtlePanel index={2} selectedIndex={tab} idPrefix="environment-gallery" className="h-full min-h-0">
        <div className="flex h-full items-center justify-center bg-surface-2 p-8"><Card size="compact" className="max-w-md"><CardHeader><CardTitle>Command approval</CardTitle><CardDescription>Approvals bind a project, an exact command hash, and the device that reviewed it.</CardDescription></CardHeader><CardContent><Button variant="primary" leadingIcon={ShieldIcon} onClick={() => setDialogOpen(true)}>Review changed check</Button></CardContent></Card></div>
        <ApproveCheckDialogMock open={dialogOpen} trust={changedCheckTrust} onOpenChange={setDialogOpen} onApprove={() => { approve('db-migrated'); setDialogOpen(false); setActivity('Approved db-migrated on all machines'); }} />
      </TabsSubtlePanel>
    </div>
  </main>;
}
