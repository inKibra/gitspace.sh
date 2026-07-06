/**
 * Trigger registry (docs/VISUAL-PARITY-ISSUES.md item 25, M1).
 *
 * Triggers are ARTIFACTS: `triggers/<slug>.trigger.json` on the workspace's
 * artifacts branch — versioned, roll up with the branch, agent-authorable
 * per the space-artifacts conventions. M1 = registry + manual runs (run-now
 * prompts an agent session and records history); the cron scheduler that
 * fires them unattended is M2.
 */

import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { captureArtifacts } from './artifacts.js';
import { SpacesError } from '../types/errors.js';

export interface TriggerRecord {
  id: string;
  name: string;
  kind: 'cron' | 'event' | 'manual';
  when: string;
  status: 'ok' | 'pending' | 'failed' | 'idle';
  last: string;
  next?: string;
  cost?: string;
  writes: string[];
  history: Array<'ok' | 'fail' | 'pending'>;
  note?: string;
  scope?: 'workspace' | 'project';
  does?: string;
  runs?: { type: 'command' | 'skill' | 'workflow'; ref?: string; prompt?: string };
  reads?: string[];
  feeds?: string[];
  /** ISO timestamps of recent runs, newest last (source for `last`). */
  runLog?: Array<{ at: string; status: 'ok' | 'fail' | 'pending'; note?: string; sessionId?: string }>;
}

const TRIGGER_DIR = 'triggers';

function mountDirFor(workspaceDir: string): string {
  return join(workspaceDir, '.gitspace', 'artifacts');
}

export function triggerSlug(name: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  if (!slug) throw new SpacesError('Trigger name must contain letters or digits.', 'USER_ERROR', 1);
  return slug;
}

export function listTriggers(workspaceDir: string): TriggerRecord[] {
  const dir = join(mountDirFor(workspaceDir), TRIGGER_DIR);
  if (!existsSync(dir)) return [];
  const out: TriggerRecord[] = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.trigger.json')).sort()) {
    try {
      out.push(JSON.parse(readFileSync(join(dir, f), 'utf8')) as TriggerRecord);
    } catch { /* skip unreadable */ }
  }
  return out;
}

export async function saveTrigger(
  projectDir: string,
  workspaceDir: string,
  trigger: Omit<TriggerRecord, 'id' | 'status' | 'last' | 'history'> & Partial<Pick<TriggerRecord, 'id' | 'status' | 'last' | 'history'>>,
): Promise<TriggerRecord> {
  const mount = mountDirFor(workspaceDir);
  if (!existsSync(join(mount, '.git'))) {
    throw new SpacesError('Triggers require the artifacts mount (.gitspace/artifacts).', 'USER_ERROR', 1);
  }
  const id = trigger.id ?? triggerSlug(trigger.name);
  const record: TriggerRecord = {
    status: 'idle',
    last: 'never',
    history: [],
    ...trigger,
    id,
  };
  await captureArtifacts(projectDir, mount, [
    { path: `${TRIGGER_DIR}/${id}.trigger.json`, content: JSON.stringify(record, null, 2) + '\n' },
  ], { message: `trigger: save ${record.name}`, provenance: { tool: 'triggers' } });
  return record;
}

export async function recordTriggerRun(
  projectDir: string,
  workspaceDir: string,
  triggerId: string,
  run: { status: 'ok' | 'fail' | 'pending'; note?: string; sessionId?: string },
  now: Date = new Date(),
): Promise<TriggerRecord> {
  const mount = mountDirFor(workspaceDir);
  const path = join(mount, TRIGGER_DIR, `${triggerId}.trigger.json`);
  if (!existsSync(path)) throw new SpacesError(`Unknown trigger: ${triggerId}`, 'USER_ERROR', 1);
  const record = JSON.parse(readFileSync(path, 'utf8')) as TriggerRecord;
  const entry = { at: now.toISOString(), ...run };
  const next: TriggerRecord = {
    ...record,
    status: run.status === 'ok' ? 'ok' : run.status === 'fail' ? 'failed' : 'pending',
    last: 'just now',
    history: [...record.history, run.status].slice(-5),
    runLog: [...(record.runLog ?? []), entry].slice(-20),
  };
  await captureArtifacts(projectDir, mount, [
    { path: `${TRIGGER_DIR}/${triggerId}.trigger.json`, content: JSON.stringify(next, null, 2) + '\n' },
  ], { message: `trigger: run ${record.name} (${run.status})`, provenance: { tool: 'triggers' } });
  return next;
}
