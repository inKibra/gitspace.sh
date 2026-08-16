import { describe, expect, it } from 'bun:test';
import { BackendManager } from '../backend-manager';
import type {
  AttachSessionParams,
  BackendDescriptor,
  CreateProjectParams,
  CreateWorkspaceParams,
  DeleteProjectParams,
  DeleteWorkspaceParams,
  SessionBackend,
} from '../backend';
import type { BackendEvent } from '../events';
import type { BundleRefreshPlan, BundleRefreshSubmission } from '../../types/bundle-refresh';
import type { BundleConfigState, BundleConfigSubmission } from '../../types/bundle-config';
import type { AgentStateUpdateDelta } from '../../lib/tmux-lite/agent-event-manager.js';

class FakeBackend implements SessionBackend {
  readonly descriptor: BackendDescriptor;
  private readonly listeners = new Set<(event: BackendEvent) => void>();
  disconnectCalls = 0;

  constructor(key: string, label: string) {
    this.descriptor = {
      key,
      kind: key === 'local' ? 'local' : 'remote',
      label,
    };
  }

  emit(event: BackendEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  onEvent(handler: (event: BackendEvent) => void): () => void {
    this.listeners.add(handler);
    return () => this.listeners.delete(handler);
  }

  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.disconnectCalls += 1;
  }
  async listProjects(): Promise<void> {}
  async listGithubRepos(_org?: string): Promise<string[]> {
    return [];
  }
  async listRemoteBranches(_projectName: string): Promise<string[]> {
    return [];
  }
  async listLinearIssues(_projectName: string): Promise<never[]> {
    return [];
  }
  async listWorkspaces(): Promise<void> {}
  async listSessions(_workspaceId?: string): Promise<void> {}
  async createProject(_params: CreateProjectParams): Promise<void> {}
  async createWorkspace(_params: CreateWorkspaceParams): Promise<void> {}
  async deleteProject(_projectName: string, _params?: DeleteProjectParams): Promise<void> {}
  async attachSession(_params: AttachSessionParams): Promise<void> {}
  async detachSession(): Promise<void> {}
  async terminateSession(_sessionId: string): Promise<void> {}
  async deleteWorkspace(
    _projectName: string,
    _workspaceId: string,
    _params?: DeleteWorkspaceParams
  ): Promise<void> {}
  async getBundleRefreshPlan(_projectName: string, _workspaceId: string): Promise<BundleRefreshPlan> {
    throw new Error('not implemented');
  }
  async applyBundleRefresh(
    _projectName: string,
    _workspaceId: string,
    _submission: BundleRefreshSubmission
  ): Promise<void> {}
  async getBundleConfigState(_projectName: string, _workspaceId: string): Promise<BundleConfigState> {
    throw new Error('not implemented');
  }
  async applyBundleConfigUpdate(
    _projectName: string,
    _workspaceId: string,
    _submission: BundleConfigSubmission
  ): Promise<void> {}
  async requestInbox(): Promise<void> {}
  async clearInbox(_id?: string): Promise<void> {}
  async markInboxRead(_id: string): Promise<void> {}
  async getNotificationConfig(): Promise<void> {}
  async updateNotificationConfig(): Promise<void> {}
  async sendReviewRequest(): Promise<never> {
    throw new Error('not implemented');
  }
  subscribeAgentState(_handler: (delta: AgentStateUpdateDelta) => void): () => void { return () => {}; }
  getAgentStateSnapshot(): Record<string, never> { return {}; }
  async respondToAgentPermission(): Promise<boolean> { return false; }
  async getAgentSessionPreference(_workspaceId: string): Promise<null> { return null; }
  async setAgentSessionPreference(_workspaceId: string, _sessionId: string): Promise<void> {}
}

describe('BackendManager', () => {
  it('routes backend events with correct backend key', () => {
    const routed: Array<{ backendKey: string; event: BackendEvent }> = [];
    const manager = new BackendManager((event) => routed.push(event));

    const local = new FakeBackend('local', 'Local');
    const remote = new FakeBackend('remote:r:m', 'Remote');

    manager.register(local);
    manager.register(remote);

    local.emit({ type: 'projects', projects: [] });
    remote.emit({ type: 'status', status: 'connected' });

    expect(routed).toHaveLength(2);
    expect(routed[0]).toEqual({ backendKey: 'local', event: { type: 'projects', projects: [] } });
    expect(routed[1]).toEqual({
      backendKey: 'remote:r:m',
      event: { type: 'status', status: 'connected' },
    });
  });

  it('disconnects backend when unregistering', async () => {
    const manager = new BackendManager(() => {});
    const backend = new FakeBackend('remote:test', 'Remote Test');
    manager.register(backend);

    await manager.unregister('remote:test');

    expect(backend.disconnectCalls).toBe(1);
    expect(manager.get('remote:test')).toBeNull();
  });
});
