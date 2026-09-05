import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { GitSpaceShell, ProjectsView, type GitSpaceShellProps, type WorkspaceView } from './GitSpaceShell.js';
import { OverviewView } from './inspector/index.js';
import { WorkspaceTerminals } from './WorkspaceTerminals.js';


describe('GitSpaceShell', () => {
  it('gates prompt intake while a reopened session is recovering', () => {
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      mainAgent={{ ...verticalSliceFixture.mainAgent!, state: 'waiting', recovering: true }}
      onSend={async () => undefined}
      onCloseSpace={async () => undefined}
    />);
    expect(html).toContain('Recovering agent…');
    expect(html).toContain('placeholder="Recovering agent…"');
    expect(html).toContain('disabled=""');
  });





  it('renders a released workspace read-only with a machine picker defaulting to the preferred machine', () => {
    if (verticalSliceFixture.workspace.kind !== 'workspace') throw new Error('Expected workspace fixture');
    const released: WorkspaceView = {
      ...verticalSliceFixture.workspace,
      holder: { kind: 'released' },
      status: { primaryColor: 'dim' as const, agents: { green: 0, blue: 0, orange: 0, red: 0 }, services: { green: 0, red: 0 }, terminals: { green: 0, red: 0 } },
    };
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      workspace={released}
      workspaces={verticalSliceFixture.workspaces.map((workspace) => workspace.id === released.id ? released : workspace)}
      mainAgent={null}
      checkpoint={{ sessionId: 'session-a', generation: 4, lastMachineId: 'studio' }}
      claimMachines={[{ id: 'darktop', label: 'Darktop' }, { id: 'studio', label: 'Studio' }]}
      homeMachineId="darktop"
      defaultMachineId="studio"
      onClaimWorkspace={async () => undefined}
    />);
    expect(html).toContain('Closed · last on Studio');
    expect(html).toContain('Build the GitSpace 1.0 working loop.');
    expect(html).not.toContain('Ask the workspace agent');
    expect(html).toContain('aria-label="Open on machine"');
    expect(html).toContain('Reopen');
    expect(html).toContain('· released');
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

  it('renders explicit open controls without starting an absent base agent', () => {
    const stopped = {
      ...verticalSliceFixture.baseSpace,
      status: {
        primaryColor: 'dim' as const,
        agents: { green: 0, blue: 0, orange: 0, red: 0 },
        services: { green: 0, red: 0 },
        terminals: { green: 0, red: 0 },
      },
    };
    const html = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} workspace={stopped} baseSpace={stopped} mainAgent={null} />);
    expect(html).toContain('Base · Not started');
    expect(html).toContain('Base agent not started');
    expect(html).toContain('Start');
    expect(html).not.toContain('Ask the project agent');
  });

  it('renders the workspace Hub terminal empty state and create action', () => {
    const html = renderToStaticMarkup(<WorkspaceTerminals
      list={async () => []}
      create={async () => { throw new Error('not called during server render'); }}
      read={async () => { throw new Error('not called during server render'); }}
      send={async () => undefined}
      stop={async () => undefined}
    />);
    expect(html).toContain('Hub terminals');
    expect(html).toContain('No terminals');
    expect(html).toContain('New terminal');
  });

  it('renders cloud project creation controls and active archived filters', () => {
    const html = renderToStaticMarkup(<ProjectsView
      projects={[
        { id: 'project-a', name: 'Active Project', lifecycle: 'active', repositoryReference: null, baseBranch: 'main', revision: 2, archivedAt: null, updatedAt: new Date() },
        { id: 'project-b', name: 'Archived Project', lifecycle: 'archived', repositoryReference: null, baseBranch: 'main', revision: 4, archivedAt: new Date(), updatedAt: new Date() },
      ]}
      workspaces={[]}
      onOpen={() => undefined}
      onCreateProject={async () => undefined}
      onCreateWorkspace={async () => undefined}
      onArchiveProject={async () => undefined}
      onRestoreProject={async () => undefined}
      onDeleteProject={async () => undefined}
      onDeleteWorkspace={async () => undefined}
    />);
    expect(html).toContain('New project');
    expect(html).toContain('Active Project');
    expect(html).not.toContain('Archived Project');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Project filter"');
  });

  it('exposes workspace terminals from the agent header instead of the inspector tabs', () => {
    const html = renderToStaticMarkup(<GitSpaceShell
      {...verticalSliceFixture}
      terminals={{
        list: async () => [],
        create: async () => { throw new Error('not called during server render'); },
        read: async () => { throw new Error('not called during server render'); },
        send: async () => undefined,
        stop: async () => undefined,
      }}
    />);
    expect(html).toContain('aria-label="Open terminals"');
  });

  it('warns in the composer when the selected model provider is not connected on this machine', () => {
    const rejects = async (): Promise<never> => { throw new Error('not called during server render'); };
    const sessionControls: NonNullable<GitSpaceShellProps['sessionControls']> = {
      value: { sessionId: 'session-a', role: null, roleLabel: null, roles: [], provider: 'anthropic', models: [{ provider: 'anthropic', id: 'claude', name: 'Claude', contextWindow: null }], model: 'claude', thinking: null, fastMode: false, approvalMode: 'write', context: null, cost: 0, todos: [], queue: { steering: [], followUp: [] }, pendingAsk: null, goal: null, history: [], tree: [] },
      onCycleRole: rejects, onSetModel: rejects, onSetThinking: rejects, onSetFast: rejects, onSetApproval: rejects, onSetGoal: rejects, onCompact: rejects, onClearQueue: rejects, onRemoveQueuedMessage: rejects, onPromoteQueuedMessage: rejects, onAnswerAsk: rejects, onStop: rejects, onNavigateTree: rejects,
    };
    const disconnected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: false }]} />);
    expect(disconnected).toContain('Anthropic isn’t connected on this machine');
    expect(disconnected).toContain('href="/settings?section=omp-providers"');
    const connected = renderToStaticMarkup(<GitSpaceShell {...verticalSliceFixture} sessionControls={sessionControls} providers={[{ id: 'anthropic', name: 'Anthropic', hasAuth: true }]} />);
    expect(connected).not.toContain('isn’t connected on this machine');
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
