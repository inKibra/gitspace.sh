import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { resourceLinkHref } from '@gitspace/protocol/resource-uri';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, pendingProfileChange, workspaceStatusColor, workspaceStatusLabel, type GitSpaceShellProps, type WorkspaceView } from './GitSpaceShell.js';
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
    expect(workspaceStatusLabel({ ...cloud, status: { ...cloud.status, primaryColor: 'green' } })).toBe('Working');
    expect(workspaceStatusLabel({ ...cloud, status: { ...cloud.status, primaryColor: 'blue' } })).toBe('Waiting');
    expect(workspaceStatusLabel({ ...cloud, status: { ...cloud.status, agents: { ...cloud.status.agents, red: 1 } } })).toBe('Failed');
    expect(workspaceStatusLabel({ ...cloud, status: undefined, freshness: 'unknown' })).toBe('Cloud workspace');
    expect(workspaceStatusColor({ ...cloud, status: undefined, freshness: 'unknown' })).toBe('dim');
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
      value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [{ provider: 'anthropic', id: 'claude', name: 'Claude', contextWindow: null }], model: 'claude', thinking: null, fastMode: false, planMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], historyAnchorId: null },
      onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetApproval: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onAnswerAsk: rejects, onStop: rejects, onNavigateTree: rejects,
    };
    const disconnected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: false }]} />);
    expect(disconnected).toContain('href="/inference?section=providers"');
    const connected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: true }]} />);
    expect(connected).not.toContain('href="/inference?section=providers"');
  });

  it('shows a question GitSpace asks itself, such as plan approval, with a link to the plan, even without an ask call in the transcript', () => {
    const rejects = async (): Promise<never> => { throw new Error('not called during server render'); };
    const pendingAsk = {
      id: 'ask-plan', source: 'gitspace' as const, links: [{ label: 'Open plan', uri: 'local://workspace/music-updates-plan.md' }],
      questions: [{ id: 'plan-approval', question: 'Approve “music-updates” and move this workspace to Code?', header: 'Plan', multi: false, recommended: 0, options: [
        { label: 'Approve and move to Code', description: 'The agent implements the plan with full tools.', preview: null },
        { label: 'Keep planning', description: null, preview: null },
      ] }],
    };
    const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
      value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [], model: null, thinking: null, fastMode: false, planMode: true, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk, goal: null, history: [], historyAnchorId: null },
      onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetApproval: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onAnswerAsk: rejects, onStop: rejects, onNavigateTree: rejects,
    };
    const html = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} />);
    expect(html).toContain('Approve “music-updates” and move this workspace to Code?');
    expect(html).toContain('Approve and move to Code');
    expect(html).toContain('Keep planning');
    expect(html).toContain('Open plan');
    expect(html).toContain(`href="${resourceLinkHref('local://workspace/music-updates-plan.md')}"`);
    const toolAsk = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={{ ...sessionControls, value: { ...sessionControls.value, pendingAsk: { ...pendingAsk, source: 'ask-tool' } } }} />);
    expect(toolAsk).not.toContain('Approve and move to Code');
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
