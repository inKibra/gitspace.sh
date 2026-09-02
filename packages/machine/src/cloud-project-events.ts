import type { AppendFactEvent } from '@gitspace/core';
import type { ProjectEvent } from '@gitspace/protocol';

export interface ProjectEventAuthority {
  appendProjectEvent(input: Omit<ProjectEvent, 'offset' | 'createdAt'> & { projectId: string }): Promise<ProjectEvent>;
}

export class CloudProjectEventWriter {
  private pending = Promise.resolve();

  constructor(
    private readonly authority: ProjectEventAuthority,
    private readonly onError: (error: unknown) => void,
  ) {}

  append(input: AppendFactEvent): void {
    this.pending = this.pending
      .then(async () => {
        await this.authority.appendProjectEvent({ ...input, payload: input.payload ?? {} });
      })
      .catch(this.onError);
  }

  async flush(): Promise<void> {
    await this.pending;
  }
}
