import type { AgentDefinitionSetup, AgentSetupView as AgentSetupReport, SaveAgentDefinitionInput } from '@gitspace/protocol';
import { Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, ScrollArea, Select, SelectContent, SelectItem, SelectTrigger, ThinkingIndicator, useShape } from '@gitspace/ui';
import { RefreshCcw01 } from '@untitledui/icons';
import { useEffect, useState } from 'react';
import { EmptyState } from '../GitSpaceShell.js';
import { rpcErrorMessage } from '../rpc-error-message.js';

export interface InspectorAgentSetupState {
  sessionId: string | null;
  report: AgentSetupReport | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  error?: string;
  persistence?: 'cloud' | 'working-tree';
  immutable?: boolean;
  load(): void;
  refresh(): void;
  save(input: SaveAgentDefinitionInput): Promise<AgentSetupReport>;
}
interface Draft {
  definition: AgentDefinitionSetup;
  path: string;
  expectedRevision: string | null;
  content: string;
}

function selectionReason(agent: AgentDefinitionSetup): string {
  if (agent.selection === 'settings') return 'An account per-agent model setting overrides the definition selector.';
  if (agent.selection === 'definition') return 'The definition’s model selector determines the current role and model.';
  return 'No definition or per-agent model selector applies; the active session model is inherited.';
}

export function AgentSetupView({ state, onDirtyChange }: { state: InspectorAgentSetupState; onDirtyChange?(dirty: boolean): void }) {
  const shape = useShape();
  const [selectedName, setSelectedName] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const dirty = Object.keys(drafts).length > 0;
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const preventLoss = (event: BeforeUnloadEvent): void => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [dirty]);

  const agents = state.report?.agents ?? [];
  const listedAgents = [...agents, ...Object.values(drafts).filter((draft) => !agents.some((agent) => agent.name === draft.definition.name)).map((draft) => draft.definition)];
  const selected = listedAgents.find((agent) => agent.name === selectedName) ?? listedAgents[0];
  const cloud = state.persistence === 'cloud' || selected?.source === 'cloud';
  const draft = selected ? drafts[selected.name] : undefined;
  const latest = selected ? agents.find((agent) => agent.name === selected.name) : undefined;
  const changedOnDisk = !!draft && (draft.expectedRevision === null
    ? !!latest?.editable
    : !latest || latest.path !== draft.path || latest.revision !== draft.expectedRevision);
  const canEdit = !state.immutable && !!selected && (selected.editable || !!draft);
  const clearDraft = (name: string): void => {
    setDrafts((current) => { const next = { ...current }; delete next[name]; return next; });
    setSaveErrors((current) => { const next = { ...current }; delete next[name]; return next; });
  };
  const edit = (content: string): void => {
    if (!selected || !canEdit) return;
    setSaved(null);
    const next = draft ?? { definition: selected, path: selected.path, expectedRevision: selected.revision, content: selected.content };
    if (next.expectedRevision !== null && content === next.definition.content) clearDraft(selected.name);
    else setDrafts((current) => ({ ...current, [selected.name]: { ...next, content } }));
  };
  const save = async (): Promise<void> => {
    if (!selected || !draft || saving || changedOnDisk || state.immutable) return;
    const name = selected.name;
    setSaving(name);
    setSaved(null);
    setSaveErrors((current) => { const next = { ...current }; delete next[name]; return next; });
    try {
      await state.save({ path: draft.path, expectedRevision: draft.expectedRevision, content: draft.content });
      clearDraft(name);
      setSaved(`${draft.path} saved ${cloud ? 'to the cloud session' : 'to the working tree'}.`);
    } catch (error) {
      setSaveErrors((current) => ({ ...current, [name]: rpcErrorMessage(error, 'Save agent definition') }));
    } finally { setSaving(null); }
  };

  if (!state.sessionId) return <div className="p-4"><EmptyState title="Agent setup needs a session" description="Open the workspace’s main conversation to inspect its resolved definitions." /></div>;
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><div className="flex flex-col gap-4 p-4">
    <header className="flex items-start justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1"><h2 className="text-title font-semibold text-foreground text-balance">Agent setup</h2><p className="text-caption text-muted-foreground text-pretty">{state.immutable ? 'The exact definition retained when this child started. Its selection is read-only.' : 'Current resolved definitions for this workspace session. This is setup, not run history.'}</p></div>
      <Button variant="ghost" size="icon" type="button" aria-label="Refresh agent setup" disabled={state.status === 'loading' || !!saving} onClick={state.refresh}><RefreshCcw01 width={16} height={16} strokeWidth={1.5} /></Button>
    </header>
    {state.status === 'loading' ? <p role="status" className="flex items-center gap-2 text-caption text-muted-foreground"><ThinkingIndicator />{state.report ? 'Refreshing current resolution; drafts are preserved.' : 'Reading resolved agent definitions…'}</p> : null}
    {state.error ? <div role="alert" className="flex flex-col gap-2 text-caption text-destructive"><span>{state.error}</span>{state.report ? <span>Showing the last loaded definitions. Refresh before saving.</span> : null}<Button variant="secondary" size="compact" type="button" onClick={state.refresh} disabled={state.status === 'loading'}>Retry agent setup</Button></div> : null}
    {state.report?.diagnostics?.map(diagnostic => <p key={`${diagnostic.name}:${diagnostic.ignoredPath}`} role="status" className="text-caption text-muted-foreground text-pretty">Agent <strong>{diagnostic.name}</strong>: using <code>{diagnostic.winnerPath}</code>; ignoring <code>{diagnostic.ignoredPath}</code>. {diagnostic.winnerPath.startsWith('.agents/agents/') && diagnostic.ignoredPath.startsWith('.omp/agents/') ? 'The canonical .agents/agents directory takes precedence over .omp/agents for the same agent name.' : 'Only the highest-precedence definition for this agent name is used.'}</p>)}
    {!state.report && state.status === 'idle' ? <EmptyState title="Agent setup not loaded" description={cloud ? 'Read the main cloud session’s project definitions and resolved model roles. No machine attachment is needed.' : 'Read the definitions discovered by this workspace’s agent.'} action={<Button variant="secondary" type="button" onClick={state.load}>Load agent setup</Button>} /> : null}
    {state.report && !listedAgents.length ? <EmptyState title={state.immutable ? 'No retained definition' : 'No resolved definitions'} description={state.immutable ? 'This child was started by role without an agent definition. Inspect its admitted role and model in Subagents.' : cloud ? 'No cloud agent definitions are saved for this session. Create a definition with runtime.session saveAgentDefinition using a path such as .agents/agents/reviewer.md, then refresh. This does not create a working-tree file.' : 'No agent definitions were discovered for this session. Add a definition in .agents/agents and refresh. Existing .omp/agents definitions are also readable.'} /> : null}
    {selected ? <>
      <Select value={selected.name} onValueChange={(value) => setSelectedName(value)} disabled={state.immutable}><SelectTrigger aria-label="Agent definition" /><SelectContent>{listedAgents.map((agent, index) => <SelectItem key={agent.name} index={index} value={agent.name}>{agent.name}{drafts[agent.name] ? ' · Unsaved' : ''}</SelectItem>)}</SelectContent></Select>
      <Card className="border border-border">
        <CardHeader><CardTitle>{selected.name}</CardTitle><CardDescription>{selected.description}</CardDescription></CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap gap-2"><Badge size="compact" color={canEdit ? 'green' : 'gray'}>{state.immutable ? 'Retained · read-only' : selected.editable ? cloud ? 'Cloud definition' : 'Workspace file' : 'Inherited · read-only'}</Badge><Badge size="compact" color={draft ? 'amber' : 'gray'}>{draft ? 'Unsaved edits' : 'Saved definition'}</Badge></div>
          <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-2 text-caption">
            <dt className="text-muted-foreground">Source</dt><dd className="break-all">{selected.source}</dd>
            <dt className="text-muted-foreground">{cloud ? 'Definition path' : 'File'}</dt><dd className="break-all font-mono">{selected.path}</dd>
            <dt className="text-muted-foreground">Revision</dt><dd className="break-all font-mono" title={selected.revision}>{state.immutable ? selected.revision : selected.revision.slice(0, 12)}</dd>
            <dt className="text-muted-foreground">Selectors</dt><dd className="break-all font-mono">{selected.modelSelectors.join(', ') || 'None'}</dd>
            <dt className="text-muted-foreground">{state.immutable ? 'Selected role' : 'Current role'}</dt><dd>{selected.role ?? 'No role selected'}</dd>
            <dt className="text-muted-foreground">{state.immutable ? 'Admitted model' : 'Current model'}</dt><dd className="break-all font-mono">{selected.model ? `${selected.provider ? `${selected.provider} / ` : ''}${selected.model}` : 'No model resolved'}</dd>
            <dt className="text-muted-foreground">Tools</dt><dd className="break-all font-mono">{selected.tools.join(', ') || 'Not specified'}</dd>
            <dt className="text-muted-foreground">Spawns</dt><dd className="break-all font-mono">{selected.spawns ?? 'Not specified'}</dd>
          </dl>
          <p className="text-caption text-muted-foreground text-pretty">{state.immutable ? 'This definition and selection were retained at admission. Later definition or account setting changes do not change this child.' : `${selectionReason(selected)} This preview uses saved definitions and current settings, not unsaved edits or historical usage.`}</p>
        </CardContent>
      </Card>
      {!state.immutable && !selected.editable && !draft ? <div className="flex flex-col gap-2"><p className="text-caption text-muted-foreground">{cloud ? 'Inspect the inherited definition below, or create a cloud session override. The inherited source and account Settings are unchanged.' : 'Inspect the inherited file below, or copy it into this checkout. A workspace override takes precedence without modifying the inherited source or account Settings.'}</p><Button variant="secondary" type="button" disabled={!!saving || state.status === 'loading' || !!state.error} onClick={() => { setSaved(null); setDrafts((current) => ({ ...current, [selected.name]: { definition: selected, path: `.agents/agents/${selected.name}.md`, expectedRevision: null, content: selected.content } })); }}>{cloud ? 'Create cloud override' : 'Create workspace override'}</Button></div> : null}
      <section className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2"><label htmlFor="agent-definition-source" className="text-caption font-medium">{state.immutable ? 'Retained source' : canEdit ? 'Definition source' : 'Inherited source'}</label><span className="break-all font-mono text-caption text-muted-foreground">{draft?.path ?? selected.path}</span></div>
        {/* FLUID-GAP: multi-line file editor — the registry has no textarea/code editor. */}
        <textarea id="agent-definition-source" aria-label="Agent definition source" aria-describedby="agent-save-semantics" rows={18} spellCheck={false} readOnly={!canEdit} disabled={!!saving} value={draft?.content ?? selected.content} onChange={(event) => edit(event.currentTarget.value)} className={`${shape.input} min-h-72 w-full resize-y border border-border bg-surface-1 p-3 font-mono text-caption leading-relaxed text-foreground outline-none focus-visible:ring-1 focus-visible:ring-[color:var(--focus-ring,#6B97FF)] disabled:opacity-60`} />
        <p id="agent-save-semantics" className="text-caption text-muted-foreground">{state.immutable ? 'Retained source is read-only. Edit the parent’s definitions for future agent starts.' : `${cloud ? 'Save stores this definition in the cloud session; it does not write, stage or commit a working-tree file.' : 'Save writes this file to the working tree; it does not stage or commit.'} The refreshed definition applies to future agent starts, not agents already running.`}</p>
      </section>
      {changedOnDisk ? <section role="alert" className="flex flex-col gap-2 text-caption"><p className="text-destructive">The resolved file changed since editing began. Your draft is preserved; review the latest source before saving.</p>{latest ? <details><summary className="cursor-pointer py-2">Compare latest saved source</summary><pre className={`${shape.input} max-h-80 overflow-auto border border-border bg-surface-1 p-3 font-mono whitespace-pre-wrap`}>{latest.content}</pre></details> : <p>The definition is no longer resolved. Refresh to check its source.</p>}{latest?.editable ? <Button variant="secondary" type="button" disabled={!!saving} onClick={() => { if (!window.confirm('Keep your edited text and use the latest file revision as its base? Review and merge any external changes before saving.')) return; setDrafts((current) => ({ ...current, [selected.name]: { definition: latest, path: latest.path, expectedRevision: latest.revision, content: draft!.content } })); }}>Keep draft against latest revision</Button> : null}</section> : null}
      {saveErrors[selected.name] ? <div role="alert" className="flex flex-col gap-2 text-caption text-destructive"><span>Save failed: {saveErrors[selected.name]}</span><span>Your edits have not been discarded. Refresh to check for external changes, or correct the file and retry.</span><Button variant="secondary" type="button" onClick={state.refresh} disabled={state.status === 'loading' || !!saving}>Refresh saved definition</Button></div> : null}
      {draft ? <footer className="flex flex-wrap justify-end gap-2"><Button variant="ghost" type="button" disabled={!!saving} onClick={() => { if (window.confirm('Discard unsaved edits to this definition?')) clearDraft(selected.name); }}>Discard edits</Button><Button variant="primary" type="button" loading={saving === selected.name} disabled={!!saving || changedOnDisk || state.status === 'loading' || !!state.error} onClick={() => void save()}>{draft.expectedRevision === null ? cloud ? 'Save cloud override' : 'Save workspace override' : 'Save definition'}</Button></footer> : null}
    </> : null}
    {saved ? <p role="status" className="text-caption text-foreground">{saved}</p> : null}
  </div></ScrollArea>;
}
