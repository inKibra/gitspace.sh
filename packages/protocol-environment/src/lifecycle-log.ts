import type { LifecycleRun } from './schema.js';
import { isLifecycleRunActive } from './lifecycle.js';

const PREFIX = '__GITSPACE_';
type Step = LifecycleRun['results'][number];

/** Decodes the persisted runner framing across arbitrary transport/page boundaries. */
export class LifecycleLogReader {
  readonly results: Step[] = [];
  private pending = '';
  private active: Step | undefined;
  private readonly known: Set<string> | undefined;

  constructor(private readonly options: { ids?: readonly string[]; outputLimit?: number; selectedId?: string } = {}) {
    this.known = options.ids ? new Set(options.ids) : undefined;
  }

  push(chunk: string, options: { final?: boolean; at?: string } = {}): void {
    this.pending += chunk;
    for (;;) {
      const marker = this.pending.indexOf(PREFIX);
      if (marker < 0) {
        let retained = 0;
        for (let size = 1; size < PREFIX.length; size++) if (this.pending.endsWith(PREFIX.slice(0, size))) retained = size;
        this.append(this.pending.slice(0, this.pending.length - retained));
        this.pending = options.final ? '' : this.pending.slice(this.pending.length - retained);
        return;
      }
      this.append(this.pending.slice(0, marker));
      this.pending = this.pending.slice(marker);
      const end = this.pending.indexOf('\n');
      if (end < 0) {
        // Valid identifiers are bounded by the lifecycle protocol. Never leak a partial control line.
        if (options.final || this.pending.length > 512) this.pending = '';
        return;
      }
      const frame = /^__GITSPACE_(START|END)__([A-Za-z0-9_-]+)(?::(-?\d+))?\r?$/u.exec(this.pending.slice(0, end));
      this.pending = this.pending.slice(end + 1);
      if (!frame) continue;
      let id: string;
      try {
        const encoded = frame[2]!.replaceAll('-', '+').replaceAll('_', '/');
        id = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)));
      } catch { continue; }
      if (!id || id.length > 160 || this.known && !this.known.has(id)) continue;
      if (frame[1] === 'START' && frame[3] === undefined) {
        const previous = this.results.findIndex((step) => step.id === id);
        this.active = { id, exitCode: null, output: '', ...(options.at ? { startedAt: options.at, finishedAt: null } : {}) };
        if (previous < 0) this.results.push(this.active);
        else this.results[previous] = this.active;
      } else if (frame[1] === 'END' && frame[3] !== undefined && this.active?.id === id && Number.isSafeInteger(Number(frame[3]))) {
        this.active.exitCode = Number(frame[3]);
        if (options.at) this.active.finishedAt = options.at;
        this.active = undefined;
      }
    }
  }

  private append(output: string): void {
    if (!this.active || !output || this.options.selectedId !== undefined && this.active.id !== this.options.selectedId) return;
    this.active.output += output;
    if (this.options.outputLimit !== undefined) this.active.output = this.active.output.slice(-this.options.outputLimit);
  }
}

/** A phase failure says nothing about a different script's exit status. */
export function lifecycleExecutionOutcome(run: LifecycleRun, executionId: string): 'succeeded' | 'failed' | 'running' | 'interrupted' | 'not-started' {
  const step = run.results.find((result) => result.id === executionId);
  if (!step) return 'not-started';
  if (step.exitCode !== null) return step.exitCode === 0 ? 'succeeded' : 'failed';
  return isLifecycleRunActive(run) ? 'running' : 'interrupted';
}
