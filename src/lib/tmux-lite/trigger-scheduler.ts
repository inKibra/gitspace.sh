/**
 * Trigger scheduler (triggers M2) — fires cron triggers unattended.
 *
 * Lives in the machine daemon because ownership resolves by WORKSPACE
 * RESIDENCY: a worktree exists on exactly one machine, so this machine fires
 * triggers for the workspaces it hosts — no cross-machine coordination.
 * Each tick scans hosted workspaces' trigger registries (artifacts branch),
 * fires due cron triggers by spawning an agent session prompted with the
 * trigger's instruction + capability scope, and records the run.
 */

import { completeTriggerRun, listTriggers, mountHead, recordTriggerRun, type TriggerRecord, type TriggerRunEnforcement } from '../../core/triggers.js';
import { parseCronWhen } from '../../core/trigger-grammar.js';
import { getProjectDir } from '../../core/config.js';
import { artifactPaths, artifactsMountDir } from '../../core/artifacts.js';
import { inspectArtifactsMount, describeMountIntegrity } from '../../core/artifacts-mount-integrity.js';

export { parseCronWhen };

export interface SchedulerWorkspace {
  id: string;
  name: string;
  path: string;
  projectName: string;
}

export interface DueTrigger {
  workspace: SchedulerWorkspace;
  trigger: TriggerRecord;
  prompt: string;
}

/** A pending run younger than this blocks re-fire (don't stack runs). */
const PENDING_LOCK_MS = 60 * 60_000;

export function isTriggerDue(trigger: TriggerRecord, now: Date): boolean {
  if (trigger.kind !== 'cron') return false;
  const interval = parseCronWhen(trigger.when);
  if (interval === null) return false;
  const lastEntry = trigger.runLog?.[trigger.runLog.length - 1];
  if (!lastEntry) return true; // never run — baseline fire on first due tick
  const lastAt = Date.parse(lastEntry.at);
  if (Number.isNaN(lastAt)) return true;
  if (lastEntry.status === 'pending' && now.getTime() - lastAt < PENDING_LOCK_MS) return false;
  return now.getTime() - lastAt >= interval;
}

export function buildTriggerPrompt(trigger: TriggerRecord, opts: { capToken?: string } = {}): string | null {
  const instruction = trigger.runs?.prompt ?? trigger.does ?? trigger.note;
  if (!instruction) return null;
  const scope = trigger.writes.filter(Boolean);
  const lines = [
    instruction,
    '',
    scope.length > 0
      ? `Enforced write scope: ${scope.join(', ')} (plus evidence via goal commands). Out-of-scope artifact changes are automatically reverted when the run completes and the run is marked failed.`
      : 'This trigger declared no write scope — write only what the instruction requires.',
    `This is an unattended run of trigger "${trigger.name}" (${trigger.when}). Follow the space-artifacts skill.`,
  ];
  if (opts.capToken) {
    lines.push(`Capability token for sanctioned writes (pass verbatim): gssh space artifacts commit --cap ${opts.capToken} -m "<message>" <files...>`);
  }
  return lines.join('\n');
}

/** Pure scan: which triggers should fire right now across hosted workspaces. */
export function collectDueTriggers(workspaces: SchedulerWorkspace[], now: Date): DueTrigger[] {
  const due: DueTrigger[] = [];
  for (const workspace of workspaces) {
    let triggers: TriggerRecord[] = [];
    try {
      triggers = listTriggers(workspace.path);
    } catch { continue; }
    for (const trigger of triggers) {
      if (!isTriggerDue(trigger, now)) continue;
      const prompt = buildTriggerPrompt(trigger);
      if (!prompt) continue;
      due.push({ workspace, trigger, prompt });
    }
  }
  return due;
}

export interface TriggerFireDeps {
  /** Spawn + kick an agent session; resolves to the session id (or null on failure). */
  runAgent: (workspace: SchedulerWorkspace, title: string, prompt: string) => Promise<string | null>;
  /** Call `onIdle` once when the session finishes its run (busy → idle).
   *  Without it, runs stay `pending` until the lock lapses. */
  watchSessionIdle?: (workspace: SchedulerWorkspace, sessionId: string, onIdle: () => void) => void;
  /** Mint a write capability for a run (server wires the machine cap key). */
  mintCap?: (workspace: SchedulerWorkspace, trigger: TriggerRecord) => string | null;
  /** Surface post-run scope violations (server wires the inbox). */
  notifyViolations?: (workspace: SchedulerWorkspace, trigger: TriggerRecord, enforcement: TriggerRunEnforcement) => void;
  log?: (message: string) => void;
}

/** One scheduler tick: fire everything due, record runs. Returns fired count. */
export async function tickTriggerScheduler(
  workspaces: SchedulerWorkspace[],
  deps: TriggerFireDeps,
  now: Date = new Date(),
): Promise<number> {
  const due = collectDueTriggers(workspaces, now);
  let fired = 0;
  for (const { workspace, trigger, prompt } of due) {
    try {
      const projectDir = getProjectDir(workspace.projectName);
      // A cross-wired mount misdirects the whole run: the pending record's
      // startCommit comes from mountHead(), which reads the stranger's branch,
      // so post-run enforcement would diff against a bogus baseline and could
      // revert the run's legitimate writes as out-of-scope. Skip loudly instead
      // of firing into that.
      const integrity = inspectArtifactsMount(artifactPaths(projectDir).repoDir, artifactsMountDir(workspace.path));
      if (integrity.status === 'cross-wired') {
        deps.log?.(`trigger ${trigger.name} skipped: ${describeMountIntegrity(artifactsMountDir(workspace.path), integrity)}`);
        await recordTriggerRun(projectDir, workspace.path, trigger.id, { status: 'fail', note: 'artifacts mount is cross-wired — run skipped' }, now);
        continue;
      }
      // Record pending FIRST (with the run-window start) so a crash mid-fire
      // can't rapid-fire on restart and the post-run diff has its baseline.
      await recordTriggerRun(projectDir, workspace.path, trigger.id, { status: 'pending', note: 'scheduled fire', startCommit: mountHead(workspace.path) ?? undefined }, now);
      const capToken = deps.mintCap?.(workspace, trigger) ?? undefined;
      const finalPrompt = capToken ? buildTriggerPrompt(trigger, { capToken }) ?? prompt : prompt;
      const sessionId = await deps.runAgent(workspace, `trigger: ${trigger.name}`, finalPrompt);
      deps.log?.(`trigger ${trigger.name} fired in ${workspace.id}${sessionId ? ` (session ${sessionId})` : ' (session failed)'}`);
      if (!sessionId) {
        await recordTriggerRun(projectDir, workspace.path, trigger.id, { status: 'fail', note: 'agent session failed to start' }, now);
      } else {
        // Close the loop: enforce the write scope over the run window, then
        // record ok/fail. (Crash before idle → pending lock recovers.)
        deps.watchSessionIdle?.(workspace, sessionId, () => {
          void completeTriggerRun(projectDir, workspace.path, trigger.id, { sessionId })
            .then((outcome) => {
              if (outcome.enforcement.violations.length > 0) {
                deps.log?.(`trigger ${trigger.name}: reverted out-of-scope writes ${outcome.enforcement.violations.join(', ')}`);
                deps.notifyViolations?.(workspace, trigger, outcome.enforcement);
              }
            })
            .catch((e) => deps.log?.(`trigger ${trigger.name} completion failed: ${e instanceof Error ? e.message : e}`));
        });
      }
      fired += 1;
    } catch (error) {
      deps.log?.(`trigger ${trigger.name} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return fired;
}

const TICK_MS = 60_000;

/** Start the daemon loop. Returns a stop function. */
export function startTriggerScheduler(
  scan: () => Promise<SchedulerWorkspace[]>,
  deps: TriggerFireDeps,
): () => void {
  if (process.env.GITSPACE_DISABLE_TRIGGER_SCHEDULER === '1') {
    deps.log?.('trigger scheduler disabled via env');
    return () => undefined;
  }
  let stopped = false;
  let running = false;
  const timer = setInterval(() => {
    if (stopped || running) return;
    running = true;
    void scan()
      .then((workspaces) => tickTriggerScheduler(workspaces, deps))
      .catch((error) => deps.log?.(`trigger tick failed: ${error instanceof Error ? error.message : String(error)}`))
      .finally(() => { running = false; });
  }, TICK_MS);
  timer.unref?.();
  return () => { stopped = true; clearInterval(timer); };
}
