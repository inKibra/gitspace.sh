import type {
  CoordinatorPortableAgentSnapshot,
  CoordinatorPortableArtifactSnapshot,
  MachineSessionCoordinator,
} from './session-coordinator.js';
import type { PortableSpaceRuntime } from './portable-space-lifecycle.js';

export class CoordinatorPortableSpaceRuntime implements PortableSpaceRuntime {
  private snapshot?: Promise<{ agent: CoordinatorPortableAgentSnapshot; artifacts: CoordinatorPortableArtifactSnapshot }>;
  private restoredAgent?: CoordinatorPortableAgentSnapshot;
  private restoredArtifacts?: CoordinatorPortableArtifactSnapshot;

  constructor(
    private readonly coordinator: MachineSessionCoordinator,
    private readonly spaceId: string,
    private readonly beforeCheckpoint?: () => Promise<void>,
  ) {}

  async quiesce(): Promise<void> {
    await this.coordinator.quiesceSpace(this.spaceId);
    await this.beforeCheckpoint?.();
  }

  async resumeAfterFailedClose(): Promise<void> {
    this.coordinator.resumeSpace(this.spaceId);
  }

  async captureAgent(): Promise<CoordinatorPortableAgentSnapshot> {
    return (await this.capture()).agent;
  }

  async captureArtifacts(): Promise<CoordinatorPortableArtifactSnapshot> {
    return (await this.capture()).artifacts;
  }

  async deleteLocalState(): Promise<void> {
    await this.coordinator.deletePortableSpaceLocal(this.spaceId);
  }

  async prepareEmptyRepository(): Promise<void> {
    await this.coordinator.preparePortableSpaceRepository(this.spaceId);
  }

  async restoreAgent(input: CoordinatorPortableAgentSnapshot): Promise<void> {
    this.restoredAgent = input;
  }

  async restoreArtifacts(input: CoordinatorPortableArtifactSnapshot): Promise<void> {
    this.restoredArtifacts = input;
  }

  async activate(): Promise<void> {
    if (!this.restoredAgent || !this.restoredArtifacts) throw new Error('Portable space state is incomplete');
    await this.coordinator.restorePortableSpace({
      spaceId: this.spaceId,
      agent: this.restoredAgent,
      artifacts: this.restoredArtifacts,
    });
  }

  private capture(): Promise<{ agent: CoordinatorPortableAgentSnapshot; artifacts: CoordinatorPortableArtifactSnapshot }> {
    this.snapshot ??= this.coordinator.capturePortableSpace(this.spaceId);
    return this.snapshot;
  }
}
