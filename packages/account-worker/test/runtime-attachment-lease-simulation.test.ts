import { env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { Result } from 'better-result';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { credentialProtocolBase64, signCredentialAuthorityGrant } from '@gitspace/protocol';
import { RuntimeAttachmentSchema, RuntimeGitCheckpointSchema, type RuntimeAttachment, type RuntimeHeartbeatInputSchema } from '@gitspace/protocol-runtime';
import type { LifecycleRun, LifecycleRunPhase } from '@gitspace/protocol-environment';
import { ArtifactsCodeStore, ArtifactsSnapshotError, ATTACHMENT_LEASE_MS, type AttachmentMachineKind } from '@gitspace/runtime-workspace-do';
import { ProjectAuthorityDO } from '../src/project-authority.js';
import type { SpaceAuthorityDO } from '../src/space-authority.js';
import { releaseMachineAttachments } from '../src/runtime-machine-loss.js';
import type { z } from 'zod';
import { tenantRootPrivateKey } from './setup.js';

/**
 * Deterministic simulation of the cache attachment lifecycle. Every authority is the real Durable Object: attachment
 * admission, leases and the lease sweep run as deployed, the sweep fired by the authority's own alarm on a fake clock.
 * Scripted machines drive the machine-side RPCs (attach, heartbeat with and without progress, ready, final publication,
 * detach, reclaim) while seeded faults kill, revive and destroy machines and make drains fail forever. Invariants:
 * - every attachment is `detached` or `lost` once its lease (`ATTACHMENT_LEASE_MS`) has run out, and never sooner;
 * - a fencing barrier only blocks a new attachment while its holder is still live (so no longer than its lease);
 * - an admitted final publication never lands after its attachment is lost, nor holds the writer past that loss.
 */
const SEEDS = 50;
const STEPS = 60;
const EPOCH = Date.parse('2031-01-01T00:00:00.000Z');
const second = 1000;
const minute = 60 * second;
const hour = 60 * minute;
/** The lease sweep audits fleet membership at least this often (`LEASE_AUDIT_MS` in space-authority.ts). */
const LEASE_AUDIT_MS = hour;
const PROJECT_ID = 'sim-project';
const PREREQUISITES: readonly LifecycleRunPhase[] = ['machine/prepare', 'checks', 'workspace/materialize'];
const repository = { id: 'repo', name: 'repo', description: null, defaultBranch: 'main', createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', lastPushAt: null, source: null, readOnly: false, remote: 'https://artifacts.test/workspace.git' };
const commitId = (index: number) => index.toString(16).padStart(40, '0');

type LeaseClass = 'progress' | 'draining' | 'heartbeat';
type Machine = { id: string; kind: AttachmentMachineKind; alive: boolean; removedAt: number | null; fannedOut: boolean };
type Workspace = { id: string; stub: DurableObjectStub<SpaceAuthorityDO>; checkpointRef: string; canonical: string; writer: string | null; alarm: number | null };
type Held = { attachmentId: string; generation: number; drainFails: boolean; published: boolean; pendingCommit: string | null; failures: number };
type Slot = { key: string; machine: Machine; workspace: Workspace; held: Held | null; requests: number; lostBefore: boolean };
/** The specification's view of one attachment's lease, maintained from observed transitions and renewals. */
type Lease = { slot: Slot; cls: LeaseClass | null; since: number; deadline: number | null; heartbeatAt: number; terminal: boolean; counted: Set<string> };
type Renewal = { attachmentId: string; progressAt?: number };

let completedSeeds = 0;
const coverage = { readied: 0, detached: 0, parked: 0, landed: 0, abandoned: 0, barrierHeld: 0, reattachedAfterLoss: 0, lostDeadlineCloud: 0, lostDeadlineComputer: 0, lostFannedOut: 0, lostByAudit: 0, drainFailureLost: 0, computerSilentSurvived: 0, longSetupSurvived: 0 };

interface Random {
  chance(p: number): boolean;
  between(low: number, high: number): number;
  pick<T>(items: readonly T[]): T;
  weighted<T>(entries: readonly (readonly [number, T])[]): T;
}

function random(seed: number): Random {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    chance: (p: number) => next() < p,
    between: (low: number, high: number) => low + Math.floor(next() * (high - low + 1)),
    pick<T>(items: readonly T[]): T {
      const item = items[Math.floor(next() * items.length)];
      if (item === undefined) throw new Error('Cannot pick from nothing');
      return item;
    },
    weighted<T>(entries: readonly (readonly [number, T])[]): T {
      let roll = next() * entries.reduce((total, [weight]) => total + weight, 0);
      for (const [weight, value] of entries) if ((roll -= weight) < 0) return value;
      const last = entries.at(-1);
      if (!last) throw new Error('Cannot pick from nothing');
      return last[1];
    },
  };
}

/** The lease class of the specification: setup and drain renew on progress only, ready or parked on any heartbeat. */
function leaseClass(attachment: RuntimeAttachment): LeaseClass | null {
  if (attachment.state === 'draining') return 'draining';
  if (attachment.state === 'ready') return 'heartbeat';
  if (attachment.state !== 'attaching') return null;
  const setupPending = attachment.cacheAction?.action === 'setup' && (attachment.cacheAction.status === 'requested' || attachment.cacheAction.status === 'running');
  return !setupPending && (attachment.cache?.state === 'paused' || attachment.cache?.state === 'reclaimed') ? 'heartbeat' : 'progress';
}
const live = (attachment: RuntimeAttachment) => attachment.state !== 'lost' && attachment.state !== 'detached';
const parked = (attachment: RuntimeAttachment) => attachment.state === 'attaching' && leaseClass(attachment) === 'heartbeat';
const clock = (now: number) => `+${Math.floor((now - EPOCH) / hour)}h${String(Math.floor((now - EPOCH) % hour / minute)).padStart(2, '0')}m${String(Math.floor((now - EPOCH) % minute / second)).padStart(2, '0')}s`;

/** Synthetic prerequisite receipts: lifecycle execution is the machine's concern, not the lease protocol's. */
const prerequisites: LifecycleRun[] = [];
let active: Simulation | null = null;

beforeEach(() => {
  vi.spyOn(ArtifactsCodeStore.prototype, 'ensureEmptyProject').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'forkWorkspace').mockResolvedValue(repository);
  vi.spyOn(ArtifactsCodeStore.prototype, 'initialCheckpoint').mockResolvedValue(null);
  vi.spyOn(ArtifactsCodeStore.prototype, 'readCommit').mockImplementation(async (_repository, commit) => ({ hash: commit, treeHash: commit, parents: [], message: 'checkpoint', author: { name: 'Fixture', email: 'fixture@example.invalid' }, committer: { name: 'Fixture', email: 'fixture@example.invalid' }, authoredAt: 1, committedAt: 1 }));
  vi.spyOn(ArtifactsCodeStore.prototype, 'listSnapshotPaths').mockResolvedValue([]);
  // Every merge (first attempt, retry, settlement at loss, recovery at admission) independently lands or is proved
  // unpublished. Outcomes of unknown certainty legitimately keep the writer fenced and are out of scope here.
  vi.spyOn(ArtifactsCodeStore.prototype, 'mergeSnapshot').mockImplementation(async input => {
    if (!active) throw new Error('No simulation is running');
    active.merges++;
    return active.rng.chance(0.55) ? Result.ok(input.machine) : Result.err(new ArtifactsSnapshotError({ operation: 'writeSnapshot', certainty: 'not-published', message: 'Snapshot conflict: checkpoint ref has advanced' }));
  });
  const lifecycle = ProjectAuthorityDO.prototype.getLifecycleState;
  vi.spyOn(ProjectAuthorityDO.prototype, 'getLifecycleState').mockImplementation(function (this: ProjectAuthorityDO, spaceId: string) {
    const state = lifecycle.call(this, spaceId);
    return { ...state, runs: [...state.runs, ...prerequisites.filter(run => run.spaceId === spaceId)] };
  });
});
afterEach(() => {
  active = null;
  prerequisites.length = 0;
  vi.restoreAllMocks();
});

class Violation extends Error {}

class Simulation {
  now = EPOCH;
  step = 0;
  merges = 0;
  readonly rng: Random;
  readonly trace: string[] = [];
  readonly machines: Machine[];
  readonly workspaces: Workspace[];
  readonly slots: Slot[] = [];
  readonly records = new Map<string, RuntimeAttachment>();
  readonly leases = new Map<string, Lease>();
  /** Admitted final publications by commit: their attachment and admission order. */
  readonly publications = new Map<string, { attachmentId: string; index: number }>();
  private nextCommit = 1;

  constructor(readonly seed: number) {
    this.rng = random(seed);
    const kind = (): AttachmentMachineKind => this.rng.chance(0.6) ? 'cloud' : 'computer';
    this.machines = [1, 2].map(index => ({ id: `sim-machine-${index}`, kind: kind(), alive: true, removedAt: null, fannedOut: false }));
    this.workspaces = ['sim-a', 'sim-b'].map(id => ({ id, stub: env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${id}`), checkpointRef: `refs/gitspace/spaces/${id}/checkpoints`, canonical: commitId(0), writer: null, alarm: null }));
    const [first, second] = this.machines;
    const [a, b] = this.workspaces;
    if (!first || !second || !a || !b) throw new Error('Simulation fixture is incomplete');
    // The first machine serves both workspaces; the second shares one or both.
    const pairs: [Machine, Workspace][] = [[first, a], [first, b], [second, a]];
    if (this.rng.chance(0.5)) pairs.push([second, b]);
    for (const [machine, workspace] of pairs) this.slots.push({ key: `${machine.id.slice(-1)}${workspace.id.slice(-1)}`, machine, workspace, held: null, requests: 0, lostBefore: false });
  }

  fail(message: string): never {
    throw new Violation(`Lease simulation invariant violated (seed ${this.seed}, step ${this.step}, ${clock(this.now)}): ${message}\nmachines: ${this.machines.map(machine => `${machine.id}=${machine.kind}`).join(' ')}\n--- trace (last 80) ---\n${this.trace.slice(-80).join('\n')}`);
  }
  log(line: string) { this.trace.push(`${String(this.step).padStart(3)} ${clock(this.now)} ${line}`); }

  async setup() {
    const userId = env.ACCOUNT_ID;
    const vault = env.CREDENTIALS.getByName(userId);
    await vault.bootstrap({ userId, rootPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(tenantRootPrivateKey)), vaultKey: credentialProtocolBase64.encode(new Uint8Array(32).fill(19)) });
    const fleet = env.FLEET_CATALOG.getByName(userId);
    for (const [index, machine] of this.machines.entries()) {
      await vault.registerDevice(signCredentialAuthorityGrant({
        version: 1, userId, machineId: machine.id, generation: 1, capabilities: ['space.control'],
        signingPublicKey: credentialProtocolBase64.encode(ed25519.getPublicKey(new Uint8Array(32).fill(41 + index))),
        exchangePublicKey: credentialProtocolBase64.encode(x25519.getPublicKey(new Uint8Array(32).fill(37 + index))),
      }, tenantRootPrivateKey));
      const sandbox = machine.kind === 'cloud';
      await fleet.putMachine({ id: machine.id, label: machine.id, kind: sandbox ? 'sandbox' : 'physical', provider: sandbox ? 'cloudflare-sandbox' : 'physical', state: 'online', desiredState: 'online', rpcEndpoint: null, notes: '', lifecycleRevision: 1, operationId: null, error: null });
    }
    const project = env.PROJECT_AUTHORITY.getByName(`${userId}:${PROJECT_ID}`);
    const created = await project.bootstrap({ id: PROJECT_ID, name: 'Lease simulation', repositoryReference: null, baseBranch: 'main', createdBy: 'sim-machine-1' });
    await project.setProjectLifecycle(created.revision, 'active');
    for (const workspace of this.workspaces) {
      await project.putWorkspace({ id: workspace.id, projectId: PROJECT_ID, kind: 'worktree', name: workspace.id, branch: 'main', phase: null, sourceKind: 'branch', sourceRef: 'main', sourceCommit: null, lifecycle: 'active', goalId: null, expectedRevision: 0 });
      const base = this.checkpoint(workspace, commitId(0));
      await runInDurableObject(workspace.stub, (_instance, state) => {
        state.storage.sql.exec('CREATE TABLE IF NOT EXISTS runtime_code_snapshot(singleton INTEGER PRIMARY KEY CHECK(singleton=1), checkpoint TEXT NOT NULL)');
        state.storage.sql.exec('INSERT INTO runtime_code_snapshot(singleton,checkpoint) VALUES(1,?)', JSON.stringify(base));
      });
    }
  }

  checkpoint(workspace: Workspace, commit: string) {
    return RuntimeGitCheckpointSchema.parse({ checkpointRef: workspace.checkpointRef, headCommit: commitId(0), branch: 'main', indexCommit: commit, trackedWorktreeCommit: commit, worktreeCommit: commit, indexTree: commit, worktreeTree: commit });
  }
  identity(slot: Slot) { return { projectId: PROJECT_ID, workspaceId: slot.workspace.id, machineId: slot.machine.id }; }
  lease(slot: Slot, held: Held) { return { ...this.identity(slot), attachmentId: held.attachmentId, generation: held.generation }; }
  record(slot: Slot): RuntimeAttachment | undefined { return slot.held ? this.records.get(slot.held.attachmentId) : undefined; }

  /** One machine-side or cloud-side action at the current instant, then every invariant over the resulting state of
   * the workspaces it can touch. */
  async act(label: string, action: () => Promise<unknown>, scope: readonly Workspace[], renewal?: Renewal): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
    let outcome: { ok: true; value: unknown } | { ok: false; error: string };
    try { outcome = { ok: true, value: await action() }; }
    catch (error) { outcome = { ok: false, error: (error instanceof Error ? error.message : String(error)).split('\n')[0]?.slice(0, 120) ?? '' }; }
    this.log(`${label} -> ${outcome.ok ? 'ok' : `error: ${outcome.error}`}`);
    await this.observe(scope, outcome.ok ? renewal : undefined);
    return outcome;
  }

  async observe(scope: readonly Workspace[], renewal?: Renewal) {
    // Releases are judged against the state before this action: a loss settles its admitted publication first.
    const released = new Set([...this.leases].filter(([, lease]) => lease.terminal).map(([attachmentId]) => attachmentId));
    for (const workspace of scope) {
      const seen = await runInDurableObject(workspace.stub, async (_instance, state) => {
        const tables = new Set(state.storage.sql.exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'").toArray().map(row => row.name));
        return {
          attachments: tables.has('runtime_attachments') ? state.storage.sql.exec<{ record: string }>('SELECT record FROM runtime_attachments ORDER BY rowid').toArray().map(row => RuntimeAttachmentSchema.parse(JSON.parse(row.record))) : [],
          canonical: RuntimeGitCheckpointSchema.parse(JSON.parse(state.storage.sql.exec<{ checkpoint: string }>('SELECT checkpoint FROM runtime_code_snapshot WHERE singleton=1').one().checkpoint)).worktreeCommit,
          writer: tables.has('runtime_cloud_writer') ? state.storage.sql.exec<{ attempt: string | null }>('SELECT attempt FROM runtime_cloud_writer WHERE singleton=1').one().attempt : null,
          alarm: await state.storage.getAlarm(),
        };
      });
      workspace.alarm = seen.alarm;
      workspace.writer = seen.writer;
      for (const attachment of seen.attachments) this.track(attachment, renewal?.attachmentId === attachment.attachmentId ? renewal : undefined);
      // An admitted final publication lands before its attachment is released, or never: a newly canonical commit
      // was admitted by an attachment that was still live when this action began, and after the one it replaces.
      if (seen.canonical !== workspace.canonical) {
        const landed = this.publications.get(seen.canonical);
        const replaced = this.publications.get(workspace.canonical)?.index ?? 0;
        if (!landed) this.fail(`${workspace.id} canonical snapshot became ${seen.canonical}, which no attachment published`);
        if (released.has(landed.attachmentId)) this.fail(`${workspace.id} canonical snapshot advanced to publication #${landed.index} of attachment ${landed.attachmentId} after that attachment was released`);
        if (landed.index < replaced) this.fail(`${workspace.id} canonical publication #${replaced} was overwritten by older publication #${landed.index}`);
        this.log(`  ${workspace.id} canonical -> publication #${landed.index}`);
        workspace.canonical = seen.canonical;
        coverage.landed++;
      }
      for (const slot of this.slots) {
        if (slot.workspace === workspace && seen.attachments.filter(attachment => attachment.machineId === slot.machine.id && live(attachment)).length > 1) this.fail(`${slot.key} holds two live caches of one shared checkout`);
      }
      // A released attachment never keeps the canonical writer fenced behind its unsettled publication.
      const fencedBy = seen.writer?.startsWith('machine:') ? this.publications.get(seen.writer.slice(seen.writer.lastIndexOf(':') + 1)) : undefined;
      if (fencedBy && this.leases.get(fencedBy.attachmentId)?.terminal) this.fail(`${workspace.id} writer is still fenced by publication #${fencedBy.index} of released attachment ${fencedBy.attachmentId}`);
    }
    // Another authority's alarm may be due at this same instant: only a strictly expired lease is overdue here.
    this.checkLeases(this.now, true);
  }

  /** Mirror one observed record into the specification's lease and check the store never grants more. */
  track(attachment: RuntimeAttachment, renewal?: Renewal) {
    this.records.set(attachment.attachmentId, attachment);
    const slot = this.slots.find(candidate => candidate.machine.id === attachment.machineId && candidate.workspace.id === attachment.workspaceId);
    if (!slot) this.fail(`unexpected attachment ${attachment.attachmentId} of ${attachment.machineId} in ${attachment.workspaceId}`);
    const cls = live(attachment) ? leaseClass(attachment) : null;
    const window = cls === null ? null : ATTACHMENT_LEASE_MS[slot.machine.kind][cls];
    let lease = this.leases.get(attachment.attachmentId);
    if (!lease) {
      lease = { slot, cls, since: this.now, deadline: window === null ? null : this.now + window, heartbeatAt: this.now, terminal: false, counted: new Set() };
      this.leases.set(attachment.attachmentId, lease);
    } else if (lease.terminal) {
      if (live(attachment)) this.fail(`released attachment ${attachment.attachmentId} became ${attachment.state} again`);
      return;
    }
    if (!live(attachment)) {
      this.release(lease, attachment);
      return;
    }
    if (cls !== lease.cls || lease.deadline === null) {
      lease.cls = cls;
      lease.since = this.now;
      lease.deadline = window === null ? null : this.now + window;
    } else if (renewal && window !== null) {
      if (cls === 'heartbeat') lease.deadline = this.now + window;
      else if (renewal.progressAt !== undefined) lease.deadline = Math.max(lease.deadline, Math.min(renewal.progressAt, this.now) + window);
    }
    if (renewal) lease.heartbeatAt = this.now;
    const recorded = attachment.deadlineAt === null ? null : Date.parse(attachment.deadlineAt);
    if (lease.deadline !== null && (recorded === null || recorded > lease.deadline)) this.fail(`${slot.key} attachment ${attachment.attachmentId} (${attachment.state}, ${slot.machine.kind} ${cls}) holds deadline ${recorded === null ? 'never' : clock(recorded)}; its lease allows ${clock(lease.deadline)}`);
  }

  release(lease: Lease, attachment: RuntimeAttachment) {
    const { slot } = lease;
    lease.terminal = true;
    this.log(`  ${slot.key} ${attachment.attachmentId.slice(0, 8)} -> ${attachment.state}${attachment.lossReason ? ` (${attachment.lossReason})` : ''}${attachment.failure ? ` failure: ${attachment.failure.message.slice(0, 80)}` : ''}`);
    if (attachment.state === 'detached') { coverage.detached++; return; }
    if (attachment.failure?.message.includes('was abandoned')) coverage.abandoned++;
    if (slot.held?.attachmentId === attachment.attachmentId) slot.lostBefore = true;
    if (attachment.lossReason === 'deadline') {
      if (lease.deadline === null || lease.deadline > this.now) this.fail(`${slot.key} attachment ${attachment.attachmentId} (${slot.machine.kind} ${lease.cls}) was lost for its deadline at ${clock(this.now)}, but its lease runs ${lease.deadline === null ? 'forever' : `until ${clock(lease.deadline)}`}`);
      if (slot.machine.kind === 'cloud') coverage.lostDeadlineCloud++; else coverage.lostDeadlineComputer++;
      if (lease.cls === 'draining' && slot.held?.attachmentId === attachment.attachmentId && slot.held.drainFails) coverage.drainFailureLost++;
      return;
    }
    if (attachment.lossReason === 'machine-destroyed' && slot.machine.removedAt !== null) {
      if (slot.machine.fannedOut) coverage.lostFannedOut++; else coverage.lostByAudit++;
      return;
    }
    this.fail(`${slot.key} attachment ${attachment.attachmentId} was lost for an unexpected reason: ${attachment.lossReason}`);
  }

  /** At `now`, after every alarm due by then has run, no live attachment may hold an expired lease. */
  checkLeases(now: number, beforeAlarm: boolean) {
    for (const [attachmentId, lease] of this.leases) {
      if (lease.terminal) continue;
      const { machine } = lease.slot;
      const expired = (limit: number) => beforeAlarm ? limit < now : limit <= now;
      if (lease.deadline !== null && expired(lease.deadline)) this.fail(`${lease.slot.key} attachment ${attachmentId} (${machine.kind} ${lease.cls}) is still live at ${clock(now)}, past its deadline ${clock(lease.deadline)}`);
      if (machine.removedAt !== null && (machine.fannedOut || expired(machine.removedAt + LEASE_AUDIT_MS))) this.fail(`${lease.slot.key} attachment ${attachmentId} is still live at ${clock(now)} though ${machine.id} was destroyed at ${clock(machine.removedAt)}${machine.fannedOut ? ' with fan-out' : ''}`);
      if (machine.kind === 'computer' && lease.cls === 'heartbeat' && now - lease.heartbeatAt > (ATTACHMENT_LEASE_MS.cloud.heartbeat ?? 0) && !lease.counted.has('silent')) { lease.counted.add('silent'); coverage.computerSilentSurvived++; }
      if (machine.kind === 'cloud' && lease.cls === 'progress' && now - lease.since > (ATTACHMENT_LEASE_MS.cloud.progress ?? 0) && !lease.counted.has('setup')) { lease.counted.add('setup'); coverage.longSetupSurvived++; }
    }
  }

  /** Advance the fake clock, running each workspace authority's own alarm exactly when it falls due. */
  async advance(duration: number) {
    const target = this.now + duration;
    this.log(`advance ${Math.round(duration / second)}s`);
    for (let stalled = 0; ;) {
      const due = this.workspaces.filter(workspace => workspace.alarm !== null && workspace.alarm <= target).sort((left, right) => (left.alarm ?? 0) - (right.alarm ?? 0))[0];
      if (!due || due.alarm === null) break;
      const at = Math.max(this.now, due.alarm);
      this.checkLeases(at, true);
      this.now = at;
      await this.act(`alarm ${due.id}`, () => runDurableObjectAlarm(due.stub), [due]);
      // A sweep that cannot settle its leases reschedules itself at once, forever.
      stalled = due.alarm !== null && due.alarm <= at ? stalled + 1 : 0;
      if (stalled > 5) this.fail(`${due.id} alarm keeps firing at ${clock(at)} without settling its leases`);
    }
    this.checkLeases(target, true);
    this.now = target;
    this.checkLeases(target, false);
  }

  heartbeat(slot: Slot, held: Held, label: string, extra: { progressAt?: number; failure?: 'setup' | 'reclaim'; reclaimed?: boolean } = {}) {
    const record = this.record(slot);
    const action = record?.cacheAction && (record.cacheAction.status === 'requested' || record.cacheAction.status === 'running') ? record.cacheAction : undefined;
    const completes = action && ((action.action === 'setup' && record?.state === 'ready') || (action.action === 'reclaim' && extra.reclaimed));
    const at = new Date(this.now).toISOString();
    const input: z.input<typeof RuntimeHeartbeatInputSchema> = { ...this.lease(slot, held), executionObservation: { activeExecutions: 0, observedAt: at } };
    if (extra.progressAt !== undefined) input.progress = { phase: 'machine/prepare', at: new Date(extra.progressAt).toISOString() };
    if (extra.failure) input.failure = { operation: extra.failure, message: extra.failure === 'reclaim' ? 'git lfs push exited 2' : 'apt-get install exited 100', attempts: ++held.failures, nextRetryAt: new Date(this.now + minute).toISOString(), at };
    if (extra.reclaimed) input.cache = { state: 'reclaimed', platform: null, activity: [], lastActivityAt: at, pausedAt: null, reclaimAt: null, lastSyncAt: at, localWorkOptIn: false, reclaimBlocked: null, setup: [] };
    if (completes && action) input.cacheAction = { requestId: action.requestId, status: 'completed', error: null };
    return this.act(`${slot.key} heartbeat ${label}`, () => slot.workspace.stub.runtimeHeartbeat(input), [slot.workspace], { attachmentId: held.attachmentId, ...(extra.progressAt !== undefined ? { progressAt: extra.progressAt } : {}) });
  }

  async attach(slot: Slot) {
    const prior = this.record(slot);
    const wasParked = prior !== undefined && live(prior) && parked(prior);
    // Admission may only refuse while a live holder fences it: this machine's previous cache of the workspace, or
    // an unsettled publication some live attachment admitted. Anything else is a barrier outliving its holder.
    const { writer } = slot.workspace;
    const fencedBy = writer?.startsWith('machine:') ? this.publications.get(writer.slice(writer.lastIndexOf(':') + 1))?.attachmentId : undefined;
    const blockers = [...this.leases.entries()].filter(([attachmentId, lease]) => !lease.terminal && ((lease.slot === slot && !wasParked) || attachmentId === fencedBy)).map(([attachmentId]) => attachmentId);
    const requestId = `${slot.key}-${++slot.requests}`;
    const result = await this.act(`${slot.key} attach ${requestId}${wasParked ? ' (parked: setup)' : ''}`, () => slot.workspace.stub.runtimeCacheAttachmentRequest({ ...this.identity(slot), requestId }), [slot.workspace]);
    if (!result.ok) {
      if (!blockers.length) this.fail(`${slot.key} cache admission was refused with no live holder fencing it: ${result.error}`);
      coverage.barrierHeld++;
      return;
    }
    const attachment = [...this.records.values()].filter(record => record.machineId === slot.machine.id && record.workspaceId === slot.workspace.id && live(record)).at(-1);
    if (!attachment) this.fail(`${slot.key} admission succeeded without a live attachment`);
    if (slot.lostBefore && attachment.attachmentId !== slot.held?.attachmentId) coverage.reattachedAfterLoss++;
    if (wasParked) coverage.parked++;
    slot.lostBefore = false;
    slot.held = { attachmentId: attachment.attachmentId, generation: attachment.generation, drainFails: this.rng.chance(0.3), published: false, pendingCommit: null, failures: 0 };
  }

  async ready(slot: Slot, held: Held, record: RuntimeAttachment) {
    const at = new Date(this.now).toISOString();
    const setup = record.cacheAction?.action === 'setup' ? `${record.cacheAction.requestId}:` : '';
    for (const phase of PREREQUISITES) prerequisites.push({ id: `attachment:${held.attachmentId}:${held.generation}:${setup}${phase}`, projectId: PROJECT_ID, spaceId: slot.workspace.id, phase, status: 'succeeded', profile: 'base', machineId: slot.machine.id, generation: null, attachment: { attachmentId: held.attachmentId, generation: held.generation }, executionHashes: [], terminalName: null, results: [], output: '', exitCode: 0, startedAt: at, finishedAt: at, deadlineAt: new Date(this.now + hour).toISOString(), cancelRequestedAt: null, failure: null, incidents: [] });
    const result = await this.act(`${slot.key} ready`, () => slot.workspace.stub.runtimeAttachmentReady({ ...this.lease(slot, held), commit: slot.workspace.canonical, prerequisitesComplete: true, capabilities: record.capabilities }), [slot.workspace]);
    if (result.ok) coverage.readied++;
  }

  async publish(slot: Slot, held: Held) {
    const commit = held.pendingCommit ?? commitId(this.nextCommit++);
    if (!this.publications.has(commit)) this.publications.set(commit, { attachmentId: held.attachmentId, index: Number.parseInt(commit, 16) });
    held.pendingCommit = commit;
    const result = await this.act(`${slot.key} publish final #${Number.parseInt(commit, 16)}`, () => slot.workspace.stub.runtimeSnapshotCommit({ ...this.lease(slot, held), checkpoint: this.checkpoint(slot.workspace, commit), previousWorktreeCommit: slot.workspace.canonical, final: true }), [slot.workspace]);
    if (result.ok) { held.published = true; held.pendingCommit = null; return; }
    // Admission refused it outright (writer busy or the predecessor moved): the next attempt is a new publication.
    if (!result.error.includes('Snapshot conflict')) { held.pendingCommit = null; return; }
    // Admitted but unsettled: the machine may crash now, leaving only the cloud to settle it.
    if (this.rng.chance(0.4)) { slot.machine.alive = false; this.log(`${slot.machine.id} crashes with publication #${Number.parseInt(commit, 16)} admitted`); }
  }

  /** The scripted machine: it does what its attachment's observed state asks of it. */
  async machineTurn(slot: Slot) {
    const record = this.record(slot);
    const held = slot.held;
    if (!record || !held || !live(record)) return this.attach(slot);
    // A restarted machine that lost its local state requests its cache again; the live one must fence it.
    if (!parked(record) && this.rng.chance(0.08)) return this.attach(slot);
    if (parked(record)) return this.rng.chance(0.5) ? this.heartbeat(slot, held, 'parked') : this.attach(slot);
    if (record.state === 'attaching') {
      return this.rng.weighted<() => Promise<unknown>>([
        [4, () => this.heartbeat(slot, held, 'setup progress', { progressAt: this.now })],
        [1, () => this.heartbeat(slot, held, 'setup stale progress', { progressAt: this.now - 15 * minute })],
        [2, () => this.heartbeat(slot, held, 'setup failing', { failure: 'setup' })],
        [3, () => this.ready(slot, held, record)],
      ])();
    }
    if (record.state === 'ready') return this.heartbeat(slot, held, 'ready');
    // Draining. The LFS bug class: the machine stays alive and heartbeats, but its drain step throws every time.
    if (held.drainFails) return this.rng.chance(0.8) ? this.heartbeat(slot, held, 'drain failing', { failure: 'reclaim' }) : this.heartbeat(slot, held, 'drain idle');
    if (!held.published) return this.rng.chance(0.75) ? this.publish(slot, held) : this.heartbeat(slot, held, 'drain progress', { progressAt: this.now });
    if (record.detachRequest) return this.act(`${slot.key} detach`, () => slot.workspace.stub.runtimeDetach({ ...this.lease(slot, held), state: 'detached' }), [slot.workspace]);
    return this.heartbeat(slot, held, 'reclaimed', { reclaimed: true });
  }

  async destroy(machine: Machine, fanOut: boolean) {
    machine.alive = false;
    await this.act(`destroy ${machine.id}${fanOut ? '' : ' (fan-out failed)'}`, async () => {
      if (fanOut) await releaseMachineAttachments(env, env.ACCOUNT_ID, machine.id, 'machine-destroyed');
      await env.CREDENTIALS.getByName(env.ACCOUNT_ID).removeManagedDevice(machine.id);
      await env.FLEET_CATALOG.getByName(env.ACCOUNT_ID).removeMachine(machine.id, true);
      machine.removedAt = this.now;
      machine.fannedOut = fanOut;
    }, this.workspaces);
    this.checkLeases(this.now, false);
  }

  async run() {
    await this.setup();
    await this.observe(this.workspaces);
    for (this.step = 1; this.step <= STEPS; this.step++) {
      const enrolled = this.machines.filter(machine => machine.removedAt === null);
      const working = this.slots.filter(slot => slot.machine.alive && slot.machine.removedAt === null);
      const held = this.slots.filter(slot => { const record = this.record(slot); return record !== undefined && live(record) && slot.machine.removedAt === null; });
      const move = this.rng.weighted<() => Promise<unknown>>([
        [3, () => this.advance(this.rng.between(5, 45) * second)],
        [4, () => this.advance(this.rng.between(60, 360) * second)],
        [2, () => this.advance(this.rng.between(8, 30) * minute)],
        [0.4, () => this.advance(this.rng.between(2 * 60, 26 * 60) * minute)],
        [working.length ? 9 : 0, () => this.machineTurn(this.rng.pick(working))],
        [held.length ? 1.5 : 0, () => {
          const slot = this.rng.pick(held);
          const holder = slot.held;
          return holder ? this.act(`${slot.key} cloud requests detach`, () => slot.workspace.stub.runtimeAttachmentDetachRequest({ ...this.lease(slot, holder) }), [slot.workspace]) : Promise.resolve();
        }],
        [held.length ? 1.5 : 0, () => {
          const slot = this.rng.pick(held);
          const holder = slot.held;
          return holder ? this.act(`${slot.key} cloud reclaims`, () => slot.workspace.stub.runtimeCacheAction({ ...this.lease(slot, holder), requestId: `reclaim-${this.step}`, action: { kind: 'reclaim' } }), [slot.workspace]) : Promise.resolve();
        }],
        [enrolled.some(machine => machine.alive) ? 0.8 : 0, async () => { const machine = this.rng.pick(enrolled.filter(candidate => candidate.alive)); machine.alive = false; this.log(`${machine.id} dies (stops heartbeating)`); }],
        [enrolled.some(machine => !machine.alive) ? 1 : 0, async () => { const machine = this.rng.pick(enrolled.filter(candidate => !candidate.alive)); machine.alive = true; this.log(`${machine.id} revives`); }],
        [enrolled.length ? 0.15 : 0, () => this.destroy(this.rng.pick(enrolled), true)],
        [enrolled.length ? 0.08 : 0, () => this.destroy(this.rng.pick(enrolled), false)],
      ]);
      await move();
    }
    // Run the clock past every lease the run still holds: the liveness check then requires each to be released.
    const horizon = Math.max(this.now, ...[...this.leases.values()].filter(lease => !lease.terminal).map(lease => Math.max(lease.deadline ?? 0, lease.slot.machine.removedAt === null ? 0 : lease.slot.machine.removedAt + LEASE_AUDIT_MS)));
    await this.advance(horizon - this.now + second);
  }
}

describe('runtime attachment lease simulation', () => {
  afterAll(() => {
    // The seeds must exercise every path the invariants guard, or a green run proves nothing. Only a complete run is
    // judged: a filtered or failing one has already reported what it found.
    if (completedSeeds < SEEDS) return;
    for (const [path, count] of Object.entries(coverage)) expect(count, `simulation never exercised ${path}`).toBeGreaterThan(0);
  });

  it.each(Array.from({ length: SEEDS }, (_, index) => index + 1))('seed %i keeps every lease, barrier and final publication bounded', async seed => {
    const simulation = new Simulation(seed);
    active = simulation;
    vi.spyOn(Date, 'now').mockImplementation(() => simulation.now);
    await simulation.run();
    completedSeeds++;
  });
});
