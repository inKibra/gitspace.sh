import { useState } from 'react';
import { DEFAULT_INFERENCE_PROFILE_ID, type InferenceProfile } from '@gitspace/protocol/inference';
import type { AvailableModel } from '@gitspace/protocol';
import { Badge, Button, Card, CardDescription, CardGroup, CardHeader, CardTitle, Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, InputField, InputGroup, Select, SelectContent, SelectItem, SelectTrigger, ThinkingIndicator } from '@gitspace/ui';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { OmpSettingsEditor, type OmpSettingView } from './SettingsPage.js';
import type { ProvidersSectionProps } from './ProvidersSection.js';
import { useInference, type InferenceController } from './InferenceContext.js';
import { rpcErrorMessage } from './rpc-error-message.js';
import { profileSettingViews, updatedProfileSettings } from './inference-settings.js';

/** Used on both the profile detail and project settings; no second assignment store. */
export function ProjectInferenceSelector({ projectId, projectName }: { projectId: string; projectName: string }) {
  const inference = useInference();
  const [error, setError] = useState<string | null>(null);
  const assignment = inference?.state?.assignments.find((entry) => entry.projectId === projectId);
  const profile = inference?.state?.profiles.find((entry) => entry.id === assignment?.profileId);
  if (!inference) return null;
  return <div className="flex min-w-0 flex-col gap-2">
    <Select value={assignment?.profileId ?? ''} disabled={!inference.state || !assignment || inference.pending} onValueChange={(profileId) => {
      if (!assignment || profileId === assignment.profileId) return;
      setError(null);
      void inference.assign(assignment, profileId).catch((cause) => setError(rpcErrorMessage(cause, 'Assign inference profile')));
    }}>
      <SelectTrigger aria-label={`Inference profile for ${projectName}`} placeholder={inference.loading ? 'Loading inference profiles…' : 'Assignment unavailable'} />
      <SelectContent>
        {assignment && !profile ? <SelectItem value={assignment.profileId} index={0} disabled>Missing profile · {assignment.profileId}</SelectItem> : null}
        {(inference.state?.profiles ?? []).map((entry, index) => <SelectItem key={entry.id} value={entry.id} index={index + (assignment && !profile ? 1 : 0)}>{entry.name}</SelectItem>)}
      </SelectContent>
    </Select>
    {!inference.loading && (!assignment || !profile) ? <p role="alert" className="text-caption text-destructive">The canonical inference assignment is unavailable. Refresh profiles; no Default fallback will be used.</p> : null}
    {error || inference.error ? <p role="alert" className="text-caption text-destructive">{error ?? inference.error}</p> : null}
    {error || inference.error || !assignment ? <Button variant="ghost" size="compact" disabled={inference.loading} onClick={() => { setError(null); void inference.refresh(); }}>Refresh profiles</Button> : null}
  </div>;
}

export interface InferencePageProps {
  inference: InferenceController;
  selectedProfileId: string;
  onSelectProfile(profileId: string): void;
  projects: ReadonlyArray<{ id: string; name: string }>;
  schema: readonly OmpSettingView[];
  schemaLoading: boolean;
  schemaError: string | null;
  onRefreshSchema(): void;
  models: readonly AvailableModel[];
  modelsReady: boolean;
  modelsLoading: boolean;
  modelsError: string | null;
  providers: ProvidersSectionProps;
  onboarding?: boolean;
  initialTab?: 'Models' | 'Agents' | 'Providers';
}

export function InferencePage({ inference, selectedProfileId, onSelectProfile, projects, schema, schemaLoading, schemaError, onRefreshSchema, models, modelsReady, modelsLoading, modelsError, providers, onboarding = false, initialTab }: InferencePageProps) {
  const [dialog, setDialog] = useState<{ action: 'create' | 'rename' | 'duplicate' | 'delete'; profile: InferenceProfile | null } | null>(null);
  const [name, setName] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const state = inference.state;
  const profile = state?.profiles.find((entry) => entry.id === selectedProfileId);
  const editor = profile ? profileSettingViews(schema, profile) : null;
  const assignments = state?.assignments.filter((entry) => entry.profileId === selectedProfileId) ?? [];
  const assignedIds = new Set(assignments.map((entry) => entry.projectId));
  const affected = assignments.map((entry) => ({ id: entry.projectId, name: projects.find((project) => project.id === entry.projectId)?.name ?? entry.projectId }));
  const others = projects.filter((project) => !assignedIds.has(project.id));
  const open = (action: NonNullable<typeof dialog>['action']) => {
    setActionError(null);
    setName(action === 'rename' ? profile?.name ?? '' : action === 'duplicate' ? `${profile?.name ?? ''} copy` : '');
    setDialog({ action, profile: profile ?? null });
  };
  const submit = async (): Promise<void> => {
    if (!dialog || inference.pending) return;
    setActionError(null);
    try {
      if (dialog.action === 'delete' && dialog.profile) {
        await inference.remove(dialog.profile);
        onSelectProfile(DEFAULT_INFERENCE_PROFILE_ID);
      } else if (dialog.action === 'rename' && dialog.profile) {
        await inference.update(dialog.profile, name.trim(), dialog.profile.settings);
      } else if (dialog.action === 'create' || dialog.action === 'duplicate') {
        const previousIds = new Set(state?.profiles.map((entry) => entry.id));
        const result = await inference.create(name.trim(), dialog.action === 'duplicate' ? dialog.profile?.id ?? null : null);
        const created = result.profiles.filter((entry) => !previousIds.has(entry.id));
        if (created.length === 1) onSelectProfile(created[0]!.id);
      }
      setDialog(null);
    } catch (cause) { setActionError(rpcErrorMessage(cause, 'Manage inference profile')); }
  };
  const content = <>
    {inference.error ? <div role="alert" className="flex flex-wrap items-center gap-2 text-caption text-destructive"><span>{inference.error}</span><Button variant="ghost" disabled={inference.loading} onClick={() => void inference.refresh()}>Refresh profiles</Button></div> : null}
    {!state ? <EmptyState icon={inference.loading ? <ThinkingIndicator /> : undefined} title={inference.loading ? 'Loading inference profiles…' : 'Inference profiles are unavailable'} description="Canonical configuration must be ready before profiles can be edited or used." /> : <>
      {!onboarding ? <section aria-label="Inference profiles" className="flex flex-col gap-3">
        <CardGroup orientation="inline" border="outlined" separated>{state.profiles.map((entry, index) => {
          const assigned = state.assignments.filter((item) => item.profileId === entry.id);
          return <Card key={entry.id} index={index} size="compact" onClick={() => onSelectProfile(entry.id)} label={`Open inference profile ${entry.name}`}>
            <CardHeader><CardTitle>{entry.name}{entry.id === selectedProfileId ? <Badge size="compact" color="blue">Selected</Badge> : null}{entry.id === DEFAULT_INFERENCE_PROFILE_ID ? <Badge size="compact" color="gray">Default profile</Badge> : null}</CardTitle><CardDescription><span className="tabular-nums">{assigned.length} {assigned.length === 1 ? 'project' : 'projects'} · revision {entry.revision}</span>{assigned.length ? ` · ${assigned.map((item) => projects.find((project) => project.id === item.projectId)?.name ?? item.projectId).join(', ')}` : ' · No projects assigned'}</CardDescription></CardHeader>
          </Card>;
        })}</CardGroup>
        {!state.profiles.length ? <p role="alert" className="text-caption text-destructive">No active profiles are available. Refresh to check migration readiness.</p> : null}
      </section> : null}
      {!profile ? <EmptyState title="Profile is unavailable" description="It may have been deleted. Choose an active profile; this view does not fall back to Default." /> : <section aria-label={`Inference profile ${profile.name}`} className="flex flex-col gap-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex flex-col gap-1"><h2 className="text-title font-semibold text-foreground">{profile.name}</h2><p className="text-caption text-muted-foreground">Independent configuration and credentials · <span className="tabular-nums">revision {profile.revision}</span></p></div>
          {!onboarding ? <div className="flex flex-wrap gap-2"><Button variant="secondary" disabled={inference.pending} onClick={() => open('rename')}>Rename</Button><Button variant="secondary" disabled={inference.pending} onClick={() => open('duplicate')}>Duplicate</Button><Button variant="ghost" disabled={inference.pending || profile.id === DEFAULT_INFERENCE_PROFILE_ID || assignments.length > 0} onClick={() => open('delete')}>Delete profile</Button></div> : null}
        </div>
        <div className="flex flex-col gap-2 text-caption text-muted-foreground">
          <p>Changes apply to the next admitted execution. Already running work keeps its original profile until it settles.</p>
          <p>{profile.id === DEFAULT_INFERENCE_PROFILE_ID ? 'Default is reserved and cannot be deleted.' : assignments.length ? 'Reassign every project below before deleting this profile.' : 'Deleting this profile revokes its broker access. Active work may fail; requests already sent cannot be recalled.'}</p>
          <p>Credentials stay in this profile’s encrypted vault. Creating or duplicating a profile never copies credentials or project assignments.</p>
        </div>
        {schemaError ? <div role="alert" className="text-caption text-destructive">{schemaError}<Button variant="ghost" onClick={onRefreshSchema}>Retry editor metadata</Button></div> : null}
        {modelsError ? <p role="alert" className="text-caption text-destructive">Models: {modelsError}. Connect this profile’s providers or refresh. Existing selections are preserved.</p> : !modelsReady ? <p role="status" className="text-caption text-muted-foreground">{modelsLoading ? 'Loading this profile’s models…' : 'This profile’s model catalog is not ready yet.'}</p> : !models.length ? <p className="text-caption text-muted-foreground">No runnable models in this profile. Connect a provider on the Providers tab.</p> : null}
        {editor?.missingDefaults.length ? <p role="alert" className="text-caption text-destructive">Editor defaults are unavailable for {editor.missingDefaults.join(', ')}. Upgrade the machine and refresh metadata. Account values are not substituted.</p> : null}
        {schemaLoading && !schema.length ? <p role="status" className="text-caption text-muted-foreground">Loading editor metadata…</p> : <OmpSettingsEditor key={profile.id} sections={['Models', 'Agents', 'Providers']} initialTab={initialTab} ompSettings={editor?.items ?? []} ompGeneration={profile.revision} models={models} modelsReady={modelsReady} providers={providers} saving={inference.pending || !!schemaError} onSetOmpSetting={async (path, value) => { await inference.update(profile, profile.name, updatedProfileSettings(profile, path, value)); }} />}
        <section aria-label="Project assignments" className="flex flex-col gap-3">
          <h3 className="text-subtitle font-semibold">Affected projects <span className="tabular-nums">({affected.length})</span></h3>
          {affected.length ? affected.map((project) => <div key={project.id} className="flex flex-wrap items-center justify-between gap-3"><span className="text-body">{project.name}</span><ProjectInferenceSelector projectId={project.id} projectName={project.name} /></div>) : <p className="text-caption text-muted-foreground">No projects use this profile yet.</p>}
          {others.length ? <><h3 className="pt-3 text-subtitle font-semibold">Assign other projects</h3>{others.map((project) => <div key={project.id} className="flex flex-wrap items-center justify-between gap-3"><span className="text-body">{project.name}</span><ProjectInferenceSelector projectId={project.id} projectName={project.name} /></div>)}</> : null}
        </section>
      </section>}
    </>}
    <Dialog open={dialog !== null} onOpenChange={(next) => { if (!next && !inference.pending) setDialog(null); }}><DialogContent>
      <DialogHeader><DialogTitle>{dialog?.action === 'delete' ? `Delete ${dialog.profile?.name}?` : dialog?.action === 'rename' ? 'Rename inference profile' : dialog?.action === 'duplicate' ? 'Duplicate inference profile' : 'Create inference profile'}</DialogTitle><DialogDescription>{dialog?.action === 'delete' ? 'Credentials will no longer be available through this profile. Active work may fail, but provider requests already sent cannot be recalled.' : dialog?.action === 'rename' ? 'The stable profile identity and its project assignments stay unchanged.' : 'Copies non-secret inference configuration only. Credentials, OAuth accounts, and project assignments are never copied. Connect providers separately before use.'}</DialogDescription></DialogHeader>
      {dialog?.action !== 'delete' ? <InputGroup><InputField index={0} label="Profile name" placeholder="Profile name" value={name} maxLength={160} disabled={inference.pending} onChange={setName} /></InputGroup> : null}
      {actionError ? <p role="alert" className="text-caption text-destructive">{actionError} Close this dialog and refresh profiles before retrying a conflicted change.</p> : null}
      <DialogFooter><Button variant="secondary" disabled={inference.pending} onClick={() => setDialog(null)}>Cancel</Button><Button variant="primary" loading={inference.pending} disabled={inference.pending || (dialog?.action !== 'delete' && !name.trim())} onClick={() => void submit()}>{dialog?.action === 'delete' ? 'Delete profile' : dialog?.action === 'rename' ? 'Save name' : dialog?.action === 'duplicate' ? 'Duplicate without credentials' : 'Create profile'}</Button></DialogFooter>
    </DialogContent></Dialog>
  </>;
  if (onboarding) return <div className="flex flex-col gap-6">{content}</div>;
  return <PageCanvas><PageHeader kicker="Configuration" title="Inference" description="Choose a complete inference configuration and credential scope for each project." actions={<><Button variant="ghost" disabled={inference.loading} onClick={() => void inference.refresh()}>Refresh</Button><Button variant="primary" disabled={!state || inference.pending} onClick={() => open('create')}>New profile</Button></>} /><div className="flex flex-col gap-8">{content}</div></PageCanvas>;
}
