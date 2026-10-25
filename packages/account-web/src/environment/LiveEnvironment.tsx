import { useState } from 'react';
import { useResultQuery } from 'result-rpc/react';
import { RuntimeIdentitySchema, RuntimeMachineIdSchema, type RuntimeSyncRequestInput, type RuntimeSyncRequestResult } from '@gitspace/protocol-runtime';
import { BROWSER_SITE_LEVELS, EnvironmentBundleSchema, browserOriginLevel, executionHash, isLifecycleRunActive, latestExecutionRun, lifecycleExecutionOutcome, projectEnvironmentState, type BrowserSiteLevel, type LifecycleRunPhase } from '@gitspace/protocol-environment';
import { Button, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@gitspace/ui';
import { rpcClient } from '../rpc-client.js';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { navigateProductUrl, setProductRoute } from '../routes.js';
import { useAccountMachines, useEnvironmentSynchronization } from '../SynchronizationProvider.js';
import { useRetainedQueryValue, useRetainedRead } from '../useRetainedRead.js';
import { useWorkspaceRunMachine } from '../useWorkspaceRunMachine.js';
import { workspaceMachines, workspaceStatus } from '../workspace-status.js';
import { runtimeLfsHeldBack, useLfsTransition } from '../LfsTransition.js';
import type { RuntimeInspectorContext } from '../RuntimeWorkspace.js';
import { EnvironmentView } from './EnvironmentView.js';
import { LifecycleLogDialog } from './LifecycleLogDialog.js';
import { OPTIONAL_STEPS, SETUP_STEPS, STEP_LABEL } from './lifecycle.js';
import type { EnvironmentMachine, EnvironmentScript, EnvironmentViewModel, EnvironmentViewProps, ScriptRun } from './types.js';

const CONFIGURE_ENVIRONMENT_PROMPT = 'Use the workspace-lifecycle skill to help me configure this repository. Inspect the repository and our shared environment ledger, then discuss the local preparation and cloud resources this project needs. Propose the lifecycle phases and profiles. Do not edit files or run lifecycle scripts until I review the plan; approval to edit is not approval to execute.';
const PLATFORM: Record<string, string> = { linux: 'Linux', darwin: 'macOS', win32: 'Windows' };

/** The live Environment tab: the gitspace.status document for machines and sync, lifecycle run records for setup, and the
 * workspace's secrets and values. */
export function LiveEnvironment({ projectId, projectName, workspaceName, spaceId, workspace, onAskAgent, onOpenAgent, onOpenAgentSetup, browser, onOpenBrowser, runtimeContext }: {
  projectId: string; projectName: string; workspaceName: string; spaceId: string; workspace: boolean;
  onAskAgent?: (text: string) => Promise<void>; onOpenAgent(): void; onOpenAgentSetup?(): void; runtimeContext?: Pick<RuntimeInspectorContext, 'snapshot' | 'onOpenTerminal'>;
} & Pick<EnvironmentViewProps, 'browser' | 'onOpenBrowser'>) {
  const identity = RuntimeIdentitySchema.parse({ projectId, workspaceId: spaceId });
  const query = useResultQuery(rpcClient.environment.get, { spaceId });
  const machinesQuery = useAccountMachines();
  // Keyed by the request: generation or machine changes do not change what environment.get returns.
  const retained = useRetainedRead(query, spaceId);
  const synchronized = useEnvironmentSynchronization(spaceId);
  const read = { ...retained, value: retained.value && synchronized.value ? { ...retained.value, ...projectEnvironmentState(synchronized.value) } : retained.value };
  const directory = useRetainedQueryValue(machinesQuery, 'machines');
  const runtime = useResultQuery(rpcClient.runtime.snapshot, identity, { enabled: !runtimeContext });
  const savedRuntime = useRetainedQueryValue(runtime, spaceId);
  const snapshot = runtimeContext?.snapshot ?? savedRuntime;
  const runMachine = useWorkspaceRunMachine(snapshot);
  const machineId = runMachine.machine?.id;
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [readingEvidence, setReadingEvidence] = useState(false);
  const [evidence, setEvidence] = useState<{ title: string; output: string; approvalHash?: string; site?: boolean } | null>(null);
  const [logSelection, setLogSelection] = useState<{ runId: string; script: { id: string; label: string } } | null>(null);
  const [unsent, setUnsent] = useState<{ machine: string; result: Extract<RuntimeSyncRequestResult, { method: 'diff' }> } | null>(null);
  const lfsTransition = useLfsTransition();
  if (!read.value) return read.error ? <div className="flex flex-col gap-2 p-4"><p role="alert" className="text-caption text-destructive">{rpcErrorMessage(read.error, 'environment.get')}</p><Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></div> : <p className="p-4 text-caption text-muted-foreground" role="status">Loading environment…</p>;
  const remote = read.value;
  const bundle = EnvironmentBundleSchema.parse(JSON.parse(remote.bundleJson));
  const attached = workspaceMachines(snapshot);
  const mutate = (operation: () => Promise<unknown>): void => {
    if (busy) return;
    setActionError(null); setNotice(null); setBusy(true);
    void operation().then(() => query.refetch()).catch((error: unknown) => setActionError(rpcErrorMessage(error, 'Update environment'))).finally(() => setBusy(false));
  };
  const sync = async (args: RuntimeSyncRequestInput['args']): Promise<RuntimeSyncRequestResult> => {
    const result = await rpcClient.runtime.sync({ ...identity, requestId: crypto.randomUUID(), args });
    if (result.status === 'error') throw result.error;
    return result.value;
  };
  const openExecution = (targetId: string, approve: boolean): void => {
    if (readingEvidence) return;
    setReadingEvidence(true); setActionError(null);
    void (async () => {
      const origin = remote.lifecycle.browserOrigins.find(entry => entry.hash === targetId);
      if (origin) {
        setEvidence({ title: `Browser origin: ${origin.pattern}`, output: `Allow logged-in Chrome access to ${origin.pattern}.\nOnly tabs in this workspace's browser group are accessible.\nRead: agents may open, observe and screenshot this site, never click, type or run scripts on it.\nInteract: agents also click and type, one step at a time; scripts are refused (for a bank or a production admin).\nFull: agents may also run Playwright scripts on this site.`, site: true, ...(approve ? { approvalHash: origin.hash } : {}) });
        return;
      }
      const execution = remote.executions.find(item => item.id === targetId);
      if (!execution) throw new Error('This script is no longer present. Refresh the environment.');
      if (await executionHash({ kind: execution.kind, command: execution.content }) !== execution.hash) throw new Error('Script content changed. Refresh and review the new content before approval.');
      setEvidence({ title: execution.label, output: execution.content, ...(approve ? { approvalHash: execution.hash } : {}) });
    })().catch((error: unknown) => setActionError(rpcErrorMessage(error, 'Read environment evidence'))).finally(() => setReadingEvidence(false));
  };
  const approveEvidence = (level?: BrowserSiteLevel): void => {
    const executionHash = evidence?.approvalHash;
    if (!executionHash) return;
    mutate(async () => {
      const result = await rpcClient.environment.approve({ spaceId, scope: workspace ? 'workspace' : 'project', executionHash, ...(level ? { level } : {}) });
      if (result.status === 'error') throw result.error;
      setEvidence(null);
    });
  };
  const lastRun = (hash: string, executionId: string): ScriptRun => {
    const run = latestExecutionRun(remote.lifecycle, hash, { profile: remote.selectedProfile, machineId });
    if (!run) return { status: 'never' };
    const step = run.results.find(result => result.id === executionId);
    const status = lifecycleExecutionOutcome(run, executionId);
    if (status !== 'succeeded' && status !== 'failed') return { status, runId: run.id };
    const exit = step?.exitCode ?? run.exitCode;
    const output = step?.output.trim().split('\n').at(-1);
    return { status, runId: run.id, detail: status === 'succeeded' ? step?.startedAt && step.finishedAt ? `${(Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt)) / 1000).toFixed(1)}s` : 'done' : [exit !== null && exit !== undefined ? `exit ${exit}` : 'failed', output].filter(Boolean).join(' · ') };
  };
  const script = (item: typeof remote.executions[number]): EnvironmentScript => {
    const approval = remote.lifecycle.approvals.find(entry => entry.executionHash === item.hash && entry.scope === item.approval);
    return { id: item.id, label: item.label, interactive: item.interactive ?? false, approval: approval ? { approved: true, by: approval.approvedBy, at: approval.approvedAt } : { approved: false }, lastRun: lastRun(item.hash, item.id) };
  };
  const machines = attached.map((machine): EnvironmentMachine => {
    const fleet = directory?.find(entry => entry.id === machine.id);
    const platform = machine.attachment.cache?.platform;
    const where = platform ? PLATFORM[platform] ?? platform : null;
    return {
      id: machine.id, name: fleet?.label ?? machine.id,
      status: !machine.status.online ? fleet?.state === 'sleeping' ? 'Paused' : 'Offline' : [where, machine.ready ? 'online' : 'starting'].filter(Boolean).join(' · '),
      color: machine.ready ? 'green' : machine.status.online ? 'orange' : 'dim',
      online: machine.status.online, ready: machine.ready, setup: machine.status.setup, sync: machine.status.sync,
      runs: remote.lifecycle.runs.filter(run => run.machineId === machine.id).toSorted((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 5)
        .map(run => ({ id: run.id, phase: run.phase, status: run.status, startedAt: run.startedAt, active: isLifecycleRunActive(run), terminalName: isLifecycleRunActive(run) && run.interactive ? run.terminalName : null })),
    };
  });
  const model: EnvironmentViewModel = {
    project: projectName, workspace: workspaceName,
    profile: { selected: remote.selectedProfile, options: Object.keys(bundle.profiles) },
    configured: remote.lifecycle.bundleJson !== null || remote.executions.length > 0,
    notes: remote.effective.notes.join(' '),
    bindings: remote.lifecycle.bindings,
    machines,
    attachable: snapshot ? (directory ?? []).filter(entry => !snapshot.attachments.some(attachment => attachment.state !== 'detached' && attachment.machineId === entry.id)).map(entry => ({ id: entry.id, label: `${entry.label} · ${entry.state}` })) : [],
    setupMachineId: machineId ?? null,
    steps: [...SETUP_STEPS, ...OPTIONAL_STEPS.filter(phase => remote.executions.some(item => item.phase === phase))].map((phase: LifecycleRunPhase) => ({ phase, label: STEP_LABEL[phase], scripts: remote.executions.filter(item => phase === 'checks' ? item.kind === 'check' : item.kind === 'script' && item.phase === phase).map(script) })),
    browserOrigins: remote.lifecycle.browserOrigins.map(origin => ({ hash: origin.hash, pattern: origin.pattern, level: browserOriginLevel(remote.lifecycle, origin.hash) })),
    signedCallers: remote.executions.filter(item => item.kind === 'ingress').map(item => ({ id: item.id, label: item.label, approved: item.approval !== null })),
    conflicts: workspaceStatus(snapshot).cloud.conflicts,
    secrets: remote.effective.secrets.map(name => ({ name, source: remote.secretMetadata.find(secret => secret.name === name)?.source ?? 'project', granted: remote.configuredSecrets.includes(name) })),
    values: Object.entries(remote.values.effective).map(([name, value]) => ({ name, value, source: name in remote.values.workspace ? 'workspace' : name in remote.values.project ? 'project' : name in remote.values.global ? 'account' : 'default' })),
  };
  const selectedLogRun = logSelection && remote.lifecycle.runs.find(run => run.id === logSelection.runId);
  const heldBack = runtimeLfsHeldBack(snapshot);
  const commitLfs = async () => { if (onAskAgent) await onAskAgent('Help me review and commit the uncommitted Git LFS changes before continuing.'); else onOpenAgent(); };
  return <div className="flex min-h-0 flex-1 flex-col">
    {read.refreshing ? <p role="status" className="sr-only">Refreshing environment…</p> : null}
    {read.error ? <p role="alert" className="px-4 py-2 text-caption text-destructive">Environment refresh failed; showing the last accepted state. {rpcErrorMessage(read.error, 'environment.get')}<Button variant="ghost" size="compact" onClick={() => void query.refetch()}>Retry environment</Button></p> : null}
    {machinesQuery.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{rpcErrorMessage(machinesQuery.error, 'Load machine directory')}</p> : null}
    {!runtimeContext && runtime.state === 'failure' ? <p role="alert" className="px-4 py-2 text-caption text-destructive">{rpcErrorMessage(runtime.error, 'Load workspace machines')}<Button variant="ghost" onClick={() => void runtime.refetch()}>Retry machines</Button></p> : null}
    {actionError ? <p role="alert" tabIndex={0} className="max-h-24 shrink-0 overflow-auto whitespace-pre-wrap break-words px-4 py-2 text-caption text-destructive">{actionError}</p> : null}
    {notice ? <p role="status" className="px-4 py-2 text-caption text-muted-foreground">{notice}</p> : null}
    <EnvironmentView
      model={model}
      busy={busy}
      machinesFooter={heldBack.length ? <p role="alert" className="text-caption text-warning">Uncommitted Git LFS changes are held back on their machine. Commit them before detaching.</p> : null}
      onProfileChange={profile => mutate(async () => { const result = await rpcClient.environment.setProfile({ spaceId, profile }); if (result.status === 'error') throw result.error; })}
      onConfigure={onAskAgent ? () => mutate(() => onAskAgent(CONFIGURE_ENVIRONMENT_PROMPT)) : undefined}
      onAttach={id => mutate(async () => { const result = await rpcClient.runtime.attachment.cache.request({ ...identity, machineId: RuntimeMachineIdSchema.parse(id) }); if (result.status === 'error') throw result.error; })}
      onDetach={id => mutate(async () => {
        const machine = attached.find(item => item.id === id);
        if (!machine || !await lfsTransition.confirm(heldBack, commitLfs)) return;
        const result = await rpcClient.runtime.attachment.detach({ ...identity, machineId: machine.status.machineId, attachmentId: machine.status.attachmentId, generation: machine.status.generation });
        if (result.status === 'error') throw result.error;
      })}
      onOpenTerminal={runtimeContext ? id => mutate(async () => {
        const result = await rpcClient.terminals.create({ spaceId, machineId: id });
        if (result.status === 'error') throw result.error;
        runtimeContext.onOpenTerminal(id, result.value.name);
      }) : undefined}
      onOpenRunTerminal={runtimeContext ? (id, name) => runtimeContext.onOpenTerminal(id, name) : undefined}
      onSelectSetupMachine={runMachine.select}
      onRunPhase={(id, phase, options) => mutate(async () => {
        if (phase === 'checks') {
          const result = await rpcClient.environment.runChecks({ spaceId, machineId: id, runId: crypto.randomUUID() });
          if (result.status === 'error') throw result.error;
          return;
        }
        if (phase === 'workspace/dematerialize' && !await lfsTransition.confirm(heldBack, commitLfs)) return;
        if (phase === 'cloud/destroy' && !options?.retire) throw new Error('Retiring cloud resources needs your explicit confirmation.');
        const result = await rpcClient.environment.runPhase({ spaceId, machineId: id, runId: crypto.randomUUID(), phase, rerun: options?.rerun ?? null, interactive: options?.interactive });
        if (result.status === 'error') throw result.error;
        // The prompts are in the run's terminal on that machine; show it so they can be answered.
        if (options?.interactive && result.value.terminalName) runtimeContext?.onOpenTerminal(result.value.machineId, result.value.terminalName);
      })}
      onApprove={targetId => openExecution(targetId, true)}
      onRevoke={targetId => {
        const hash = remote.lifecycle.browserOrigins.find(entry => entry.hash === targetId)?.hash ?? remote.executions.find(item => item.id === targetId)?.hash;
        const approval = remote.lifecycle.approvals.find(entry => entry.executionHash === hash && entry.scope === 'project')
          ?? remote.lifecycle.approvals.find(entry => entry.executionHash === hash && entry.scope === 'workspace');
        if (approval) mutate(async () => { const result = await rpcClient.environment.revokeApproval({ spaceId, scope: approval.scope, executionHash: approval.executionHash }); if (result.status === 'error') throw result.error; });
      }}
      onBrowserLevel={(hash, level) => mutate(async () => {
        // Every approval of the site takes the level: an origin is at the most restrictive level any approval says.
        for (const approval of remote.lifecycle.approvals.filter(entry => entry.executionHash === hash)) {
          const result = await rpcClient.environment.approve({ spaceId, scope: approval.scope, executionHash: hash, level });
          if (result.status === 'error') throw result.error;
        }
      })}
      onOpenScript={scriptId => openExecution(scriptId, false)}
      onOpenLog={(runId, target) => {
        const run = remote.lifecycle.runs.find(item => item.id === runId);
        if (!run) { setActionError('The machine reported this setup run, but its log has not arrived. Refresh the environment and try again.'); return; }
        const step = run.results.find(result => result.id === target.id) ?? run.results[0];
        setLogSelection({ runId, script: step && step.id !== target.id ? { id: step.id, label: step.id } : target });
      }}
      onCancelRun={runId => mutate(async () => { const result = await rpcClient.environment.cancelRun({ spaceId, runId }); if (result.status === 'error') throw result.error; })}
      onSyncNow={id => mutate(async () => {
        const result = await sync({ method: 'now', on: RuntimeMachineIdSchema.parse(id) });
        if (result.method === 'now') setNotice(`Sent ${directory?.find(entry => entry.id === id)?.label ?? id}'s changes${result.conflicts.length ? `; ${result.conflicts.length} ${result.conflicts.length === 1 ? 'conflict needs' : 'conflicts need'} a choice` : ''}.`);
      })}
      onShowUnsent={id => mutate(async () => {
        const result = await sync({ method: 'diff', on: RuntimeMachineIdSchema.parse(id) });
        if (result.method === 'diff') setUnsent({ machine: directory?.find(entry => entry.id === id)?.label ?? id, result });
      })}
      onResolveConflict={(path, keep) => mutate(async () => {
        const result = await sync({ method: 'resolve', path, keep });
        if (result.method === 'resolve') setNotice(`Kept the ${keep} version of ${path}; the other is backed up at ${result.backup}.`);
      })}
      onOpenSecrets={() => navigateProductUrl(setProductRoute(new URL(window.location.href), 'secrets'))}
      onEditValue={(name, value) => mutate(async () => { const result = await rpcClient.environment.putValue({ spaceId, scope: workspace ? 'workspace' : 'project', name, value }); if (result.status === 'error') throw result.error; })}
      onOpenAgentSetup={onOpenAgentSetup}
      browser={browser}
      onOpenBrowser={onOpenBrowser}
    />
    {lfsTransition.dialog}
    {selectedLogRun && logSelection ? <LifecycleLogDialog key={`${spaceId}:${selectedLogRun.id}:${logSelection.script.id}`} run={selectedLogRun} script={logSelection.script} revision={remote.lifecycle.revision} loadPage={async (runId, offset, signal) => { const result = await rpcClient.environment.runLog({ spaceId, runId, offset }, { signal }); if (result.status === 'error') throw result.error; return result.value; }} onClose={() => setLogSelection(null)} /> : null}
    <Dialog open={unsent !== null} onOpenChange={open => { if (!open) setUnsent(null); }}>
      <DialogContent size="sm">
        <DialogHeader><DialogTitle>Unsent changes on {unsent?.machine}</DialogTitle><DialogDescription>Changes on the machine the cloud does not have yet, and cloud changes the machine has not applied.</DialogDescription></DialogHeader>
        <section aria-label="Unsent changes" className="flex flex-col gap-1 text-caption">
          <h4 className="font-medium">On the machine · {unsent?.result.unsent.length ?? 0}{unsent?.result.unsentTruncated ? '+' : ''}</h4>
          {unsent?.result.unsent.length ? <ul className="max-h-48 overflow-auto font-mono">{unsent.result.unsent.map(change => <li key={change.path} className="break-all">{change.status} {change.path}</li>)}</ul> : <p className="text-muted-foreground">Nothing unsent.</p>}
          <h4 className="font-medium">In the cloud, not on the machine · {unsent?.result.notOnMachine.length ?? 0}{unsent?.result.notOnMachineTruncated ? '+' : ''}</h4>
          {unsent?.result.notOnMachine.length ? <ul className="max-h-48 overflow-auto font-mono">{unsent.result.notOnMachine.map(change => <li key={change.path} className="break-all">{change.status} {change.path}</li>)}</ul> : <p className="text-muted-foreground">Up to date.</p>}
        </section>
        <DialogFooter><Button variant="secondary" onClick={() => setUnsent(null)}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
    <Dialog open={evidence !== null} onOpenChange={open => { if (!open) setEvidence(null); }}>
      <DialogContent size="sm"><DialogHeader><DialogTitle>{evidence?.approvalHash ? `Review ${evidence.title}` : evidence?.title}</DialogTitle><DialogDescription>{evidence?.approvalHash ? 'Approves only this exact content. Changed content needs a new approval. Approving does not run anything.' : 'Script content as the machine runs it.'}</DialogDescription></DialogHeader>
        {evidence?.approvalHash ? <code className="break-all font-mono text-caption text-muted-foreground">{evidence.approvalHash}</code> : null}
        <pre className="max-h-[55vh] overflow-auto whitespace-pre-wrap break-words font-mono text-caption">{evidence?.output || 'No content.'}</pre>
        {actionError ? <p role="alert" className="text-caption text-destructive">{actionError}</p> : null}
        <DialogFooter><Button variant="secondary" onClick={() => setEvidence(null)}>Close</Button>{evidence?.approvalHash ? evidence.site
          ? BROWSER_SITE_LEVELS.map(level => <Button key={level} variant={level === 'full' ? 'primary' : 'secondary'} disabled={busy} onClick={() => approveEvidence(level)}>Approve {level}</Button>)
          : <Button variant="primary" disabled={busy} onClick={() => approveEvidence()}>Approve this content</Button> : null}</DialogFooter>
      </DialogContent>
    </Dialog>
  </div>;
}
