import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resourceLinkHref } from '@gitspace/protocol/resource-uri';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, pendingProfileChange, workspaceStatusColor, workspaceStatusLabel, type GitSpaceShellProps, type ProjectAgentView, type ProjectLifecycleView, type WorkspaceView } from './GitSpaceShell.js';
import { OverviewView } from './inspector/index.js';


describe('GitSpaceShell', () => {
  it('renders the saved workspace draft instead of an empty composer', () => {
    const draft = { text: 'Saved on the other device', error: null, saving: false, onChange: () => undefined, onBlur: () => undefined, capture: () => ({ generation: 0, draftRevision: 0, text: 'Saved on the other device' }), accepted: () => undefined };
    const props = { ...verticalSliceFixture, draft, onSend: async () => undefined };
    const html = renderToStaticMarkup(<GitSpaceShell {...props} />);
    expect(html).toContain('Saved on the other device');
  });
  it('warns for unavailable status without animating retained work as live', () => {
    const scope = { ...verticalSliceFixture.workspace, status: { ...verticalSliceFixture.workspace.status, primaryColor: 'green' as const } };
    expect(workspaceStatusColor({ ...scope, freshness: 'stale' })).toBe('orange');
    expect(workspaceStatusColor({ ...scope, freshness: 'unknown' })).toBe('orange');
    expect(workspaceStatusColor({ ...scope, holder: { kind: 'released' } })).toBe('dim');
    expect(workspaceStatusColor({ ...scope, freshness: 'fresh' })).toBe('green');
  });

  it('labels a cloud workspace by its runtime status, never as unavailable for lack of a machine', () => {
    const cloud = { ...verticalSliceFixture.workspace, holder: { kind: 'cloud' as const }, freshness: 'fresh' as const };
    const idle = { ...cloud.status, primaryColor: 'dim' as const, agents: { green: 0, blue: 0, orange: 0, red: 0 } };
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'green', agents: { ...idle.agents, green: 1 } } })).toBe('Working');
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'blue', agents: { ...idle.agents, blue: 1 } } })).toBe('Waiting');
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'orange', agents: { ...idle.agents, orange: 1 } } })).toBe('Needs you');
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'orange', agents: { ...idle.agents, blue: 1 }, sync: { conflicts: 1, problems: 0 } } })).toBe('Sync conflict');
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'red', agents: { ...idle.agents, red: 1 } } })).toBe('Failed');
    expect(workspaceStatusLabel({ ...cloud, status: { ...idle, primaryColor: 'blue', agents: { ...idle.agents, blue: 1 }, machines: { attached: 2, online: 1, ready: 1 }, sync: { conflicts: 0, problems: 1 } } })).toBe('Waiting · 1 machine offline · sync problem');
    // A workspace whose runtime never reported shows no activity, not a warning.
    expect(workspaceStatusLabel({ ...cloud, status: idle })).toBe('No activity');
    expect(workspaceStatusColor({ ...cloud, status: idle })).toBe('dim');
    expect(workspaceStatusLabel({ ...cloud, status: undefined, freshness: 'unknown' })).toBe('Cloud workspace');
    expect(workspaceStatusColor({ ...cloud, status: undefined, freshness: 'unknown' })).toBe('dim');
  });

  it('offers Update base on a behind project and only explains a behind workspace', () => {
    const checkedAt = '2026-10-18T12:00:00.000Z';
    const remote = { head: 'a'.repeat(40), checkedAt, behind: true };
    const project: ProjectAgentView = { ...verticalSliceFixture.workspace, kind: 'project', phase: null, id: verticalSliceFixture.workspace.projectId };
    const projects: ProjectLifecycleView[] = [{ id: project.projectId, name: 'Project', lifecycle: 'active', repositoryReference: 'https://github.com/example/project.git', baseBranch: project.branch, role: null, source: null, revision: 1, remote, archivedAt: null, updatedAt: new Date(checkedAt) }];
    const behindProject = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} workspace={project} projects={projects} onUpdateBase={async () => undefined} />);
    expect(behindProject).toContain(`Behind origin/${project.branch} · Update`);
    expect(behindProject).toContain('<button');
    const withoutAction = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} workspace={project} projects={projects} />);
    expect(withoutAction).toContain(`Behind origin/${project.branch}`);
    expect(withoutAction).not.toContain('· Update');
  });

  it('mentions the inference profile only while the next turn would use a different one', () => {
    const admitted = { profileId: 'default', profileRevision: 3 };
    expect(pendingProfileChange(admitted, { id: 'default', name: 'Default', revision: 3 })).toBeNull();
    expect(pendingProfileChange(admitted, { id: 'golconda', name: 'Golconda', revision: 1 })).toBe('Next turn uses Golconda');
    expect(pendingProfileChange(admitted, { id: 'default', name: 'Default', revision: 4 })).toBe('Next turn uses updated Default');
    // No session admission yet, or assignments still loading: nothing to compare.
    expect(pendingProfileChange(undefined, { id: 'default', name: 'Default', revision: 3 })).toBeNull();
    expect(pendingProfileChange(admitted, undefined)).toBeNull();
  });


  it('gates prompt intake while a reopened session is recovering', () => {
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      mainAgent={{ ...verticalSliceFixture.mainAgent!, state: 'waiting', recovering: true }}
      onSend={async () => undefined}
    />);
    expect(html).toContain('Recovering agent…');
    expect(html).toContain('placeholder="Recovering agent…"');
    expect(html).toContain('disabled=""');
  });






  it('renders the base project as its own agent scope', () => {
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      workspace={{
        kind: 'project',
        id: 'project-a',
        projectId: 'project-a',
        projectName: 'GitSpace',
        name: 'GitSpace',
        branch: 'develop',
        phase: null,
        possessedBy: 'Local machine',
        holder: { kind: 'held', machineId: 'local', label: 'Local machine' },
        status: verticalSliceFixture.workspace.status,
        generation: 1,
        closedAt: null,
      }}
      mainAgent={{ ...verticalSliceFixture.mainAgent!, title: 'Project agent' }}
    />);
    expect(html).toContain('Ask the project agent');
    expect(html).toContain('GitSpace');
    expect(html).not.toContain('Open base project');
  });




  it('exposes workspace terminals from the agent header instead of the inspector tabs', () => {
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      terminals={{
        spaceId: 'space',
        machines: [],
        machineId: null,
        onSelectMachine: () => {},
        events: () => { throw new Error('not called during server render'); },
        live: () => { throw new Error('not called during server render'); },
        create: async () => { throw new Error('not called during server render'); },
        send: async () => undefined,
        stop: async () => undefined,
      }}
    />);
    expect(html).toContain('aria-label="Open terminals"');
  });

  it('links disconnected provider setup to Inference instead of account settings', () => {
    const rejects = async (): Promise<never> => { throw new Error('not called during server render'); };
    const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
      value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [{ provider: 'anthropic', id: 'claude', name: 'Claude', contextWindow: null }], model: 'claude', thinking: null, fastMode: false, planMode: false, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null },
      onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onAnswerAsk: rejects, onStop: rejects, onNavigateTree: rejects,
    };
    const disconnected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: false }]} />);
    expect(disconnected).toContain('href="/inference?section=providers"');
    const connected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: true }]} />);
    expect(connected).not.toContain('href="/inference?section=providers"');
  });

  it('shows a question GitSpace asks itself, such as a machine-attach approval, above the composer with only its choices', () => {
    const rejects = async () => { throw new Error('not used'); };
    const pendingAsk: NonNullable<NonNullable<GitSpaceShellProps['sessionControls']>['value']['pendingAsk']> = {
      id: 'machine-attach:m-1:a', source: 'gitspace', links: [{ label: 'Open plan', uri: 'drive://workspace/music-updates-plan.md' }],
      questions: [{ id: 'decision', question: 'Attach Darktop to this workspace? Agents may not attach it on their own.', header: 'Approval required', multi: false, recommended: null, written: false, options: [
        { label: 'Approve', description: null, preview: null },
        { label: 'Reject', description: null, preview: null },
      ] }],
    };
    const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
      value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [], model: null, thinking: null, fastMode: false, planMode: true, context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk, goal: null, history: [], historyAnchorId: null },
      onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onAnswerAsk: rejects, onStop: rejects, onNavigateTree: rejects,
    };
    const html = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} />);
    expect(html).toContain('Attach Darktop to this workspace?');
    expect(html).toContain('Approve');
    expect(html).toContain('Reject');
    expect(html).not.toContain('Describe in your own words');
    expect(html).toContain('Open plan');
    expect(html).toContain(`href="${resourceLinkHref('drive://workspace/music-updates-plan.md')}"`);
    const toolAsk = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={{ ...sessionControls, value: { ...sessionControls.value, pendingAsk: { ...pendingAsk, source: 'ask-tool' } } }} />);
    expect(toolAsk).not.toContain('Attach Darktop to this workspace?');
  });

  it('never offers a dependent as a new dependency on the Overview', () => {
    if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
    const scope = verticalSliceFixture.workspace;
    // relay-hardening depends on agent-blame; a third workspace depends on relay-hardening.
    const dependent: WorkspaceView = { ...verticalSliceFixture.workspaces[1]!, relations: { dependsOn: [scope.id], relatedTo: [], stackedOn: null } };
    const grandDependent: WorkspaceView = { ...dependent, id: 'workspace-d', name: 'follow-up', branch: 'follow-up', relations: { dependsOn: [dependent.id], relatedTo: [], stackedOn: null } };
    const free: WorkspaceView = { ...dependent, id: 'workspace-e', name: 'unrelated-work', branch: 'unrelated', relations: { dependsOn: [], relatedTo: [], stackedOn: null } };
    const html = renderToStaticMarkup(<OverviewView scope={scope} workspaces={[scope, dependent, grandDependent, free]} onSelectWorkspace={() => undefined} onSetRelations={async () => undefined} />);
    expect(html).toContain('aria-label="Pick unrelated-work"');
    expect(html).not.toContain('aria-label="Pick relay-hardening"');
    expect(html).not.toContain('aria-label="Pick follow-up"');
  });
});
