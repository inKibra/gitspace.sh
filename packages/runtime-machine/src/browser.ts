import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, readdir, rm, open, stat } from 'node:fs/promises';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { Browser, detectBrowserPlatform, getInstalledBrowsers, install, resolveBuildId } from '@puppeteer/browsers';
import { ProcessSupervisor, DaemonStartSpecSchema, DaemonSpecSchema, ProcessIdentitySchema, processIdentity, sameProcess } from '@gitspace/supervisor';
import { RuntimeBrowserArgumentsSchema, RuntimeBrowserGrantSchema, browserNeedsExplicitApproval, canonicalJson, type RuntimeBrowserAuthorization, type RuntimeBrowserAuthorizationBody, type RuntimeBrowserGrant, type RuntimeBrowserSignedGrant, type RuntimeBrowserPreparation, type RuntimeToolDispatch } from '@gitspace/protocol-runtime';
import { z } from 'zod';
import { browserOriginMatches } from '@gitspace/protocol-environment';
import type { ExecutorContent } from './tools.js';
import type { LocalAttachment } from './journal.js';
import { ExecutorEffectUncertain } from './commands.js';
import { BrowserConnection, CdpEvent } from './browser-cdp.js';
import type { RuntimeBrowserRelay, RuntimeBrowserRelayChannel } from './browser-relay-transport.js';
import { BrowserOutputStore, BROWSER_TEXT_BYTES, BROWSER_IMAGE_BYTES, boundedText } from './browser-output.js';
import { browserScreenshotPrepareFunction, browserScreenshotRestoreFunction } from './browser-screenshot.js';

const ManagedRecord = z.object({ owner: z.string(), projectId: z.string(), workspaceId: z.string(), profile: z.string(), spec: DaemonStartSpecSchema, identity: ProcessIdentitySchema.optional() });
const supervisors = new Map<string, Promise<ProcessSupervisor>>();
type ManagedRecord = z.infer<typeof ManagedRecord>;
const TargetInfo = z.object({ targetInfo: z.object({ targetId: z.string(), type: z.literal('page'), title: z.string(), url: z.string() }) });
const Evaluation = z.object({ result: z.object({ value: z.unknown().optional(), objectId: z.string().optional() }), exceptionDetails: z.unknown().optional() });
const AxTree = z.object({ gitspaceDocument: z.number().int().nonnegative().optional(), nodes: z.array(z.object({ nodeId: z.string().max(256), parentId: z.string().max(256).optional(), ignored: z.boolean().optional(), backendDOMNodeId: z.number().optional(), role: z.object({ value: z.unknown() }).optional(), name: z.object({ value: z.unknown(), sources: z.array(z.object({ type: z.string(), attribute: z.string().optional(), nativeSource: z.string().optional(), superseded: z.boolean().optional(), invalid: z.boolean().optional(), value: z.object({ value: z.unknown().optional() }).optional() })).max(256).optional() }).optional(), properties: z.array(z.object({ name: z.string(), value: z.object({ value: z.unknown().optional() }) })).max(256).optional(), childIds: z.array(z.string()).max(20000).optional() })).max(20000) });
const Box = z.object({ model: z.object({ content: z.array(z.number()).length(8) }) });
const FrameTree = z.object({ frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string() }) }) });
type Tab = { grant: RuntimeBrowserGrant; scope: string; channel: RuntimeBrowserRelayChannel; targetId: string; sessionId: string; refs: Map<string, number>; document: number; stale: boolean; reason?: string; timer: NodeJS.Timeout; unsubscribe: () => void; profileKey?: string };
type Profile = { connection: BrowserConnection; record: ManagedRecord; path: string; tabs: number };
type Recovery = { id: string; projectId: string; workspaceId: string; state: 'uncertain' | 'fenced' | 'stopped'; reason: string; path: string; record?: ManagedRecord; expiresAt?: string; targetId?: string; groupId?: string };
export type MachineBrowserOptions = { directory: string; executablePath?: string; relay?: RuntimeBrowserRelay; enabled: boolean; grantMilliseconds?: number; verifyAuthorization?: (authorization: RuntimeBrowserAuthorization, dispatch: RuntimeToolDispatch) => Promise<RuntimeBrowserAuthorizationBody> };
async function durableWrite(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const file = await open(path, 'w', 0o600);
  try { await file.writeFile(JSON.stringify(value)); await file.sync(); } finally { await file.close(); }
}
function navigation(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) && value !== 'about:blank') throw new Error('Browser navigation supports only HTTP, HTTPS or about:blank');
  return { url: value, origin: url.origin };
}
export class MachineBrowser {
  private tabs = new Map<string, Tab>();
  private groups = new Map<string, { grant: RuntimeBrowserGrant; signature: string; scope: string }>();
  private profiles = new Map<string, Profile>();
  private queues = new Map<string, Promise<void>>();
  private records = new Map<string, Recovery>();
  private outputs = new BrowserOutputStore();
  private used = new Map<string, number>();
  private closed = false;
  private recovery?: Promise<void>;
  constructor(private readonly options: MachineBrowserOptions) {}
  private supervisor(): Promise<ProcessSupervisor> {
    const directory = resolve(this.options.directory, 'supervisor');
    let supervisor = supervisors.get(directory);
    if (!supervisor) {
      supervisor = (async () => { const instance = new ProcessSupervisor(directory); await instance.recover(); return instance; })();
      supervisors.set(directory, supervisor);
    }
    return supervisor;
  }
  private scope(dispatch: RuntimeToolDispatch) { return JSON.stringify([dispatch.projectId, dispatch.workspaceId, dispatch.machineId, dispatch.attachmentId, dispatch.generation]); }
  private profileKey(dispatch: RuntimeToolDispatch) { return createHash('sha256').update(JSON.stringify([dispatch.projectId, dispatch.workspaceId])).digest('hex'); }
  private async serial<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key), gate = Promise.withResolvers<void>();
    this.queues.set(key, gate.promise);
    await previous;
    try { return await work(); } finally { gate.resolve(); if (this.queues.get(key) === gate.promise) this.queues.delete(key); }
  }
  private async stopManaged(record: ManagedRecord, path: string) {
    const rel = relative(resolve(this.options.directory, 'profiles'), resolve(record.profile));
    if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ExecutorEffectUncertain('Managed profile identity invalid');
    const client = await this.supervisor();
    const listed = await client.request({ op: 'list' });
    if (listed.op !== 'list') throw new ExecutorEffectUncertain('Supervisor inventory unavailable');
    if (!listed.daemons.some(daemon => daemon.name === record.spec.name)) {
      if (record.identity && await sameProcess(record.identity)) throw new ExecutorEffectUncertain('Unknown supervisor launch still has a live process');
      await rm(path, { force: true });
      return;
    }
    const described = await client.request({ op: 'describe', name: record.spec.name });
    if (described.op !== 'describe' || described.daemon.owner !== record.owner || canonicalJson(described.spec) !== canonicalJson(DaemonSpecSchema.parse({ ...record.spec, envNames: Object.keys(record.spec.env) }))) throw new ExecutorEffectUncertain('Managed browser supervisor identity differs from launch record');
    if (!['exited', 'failed'].includes(described.daemon.state) && record.identity && await sameProcess(record.identity)) {
      // Chrome flushes its profile on Browser.close. Terminating the process
      // directly can lose recently written persistent cookies and preferences.
      let connection: BrowserConnection | undefined;
      try {
        connection = [...this.profiles.values()].find(profile => profile.record.spec.name === record.spec.name)?.connection ?? new BrowserConnection(client.privatePipe(record.spec.name));
        try { await connection.send('Browser.close'); } catch { /* EOF can precede the close response; still allow the profile flush to finish. */ }
        await client.request({ op: 'wait', name: record.spec.name, for: 'exit', timeoutMs: 5000 });
      } catch {
        // The verified supervisor remains the termination authority when Chrome
        // is unreachable; it must still prove process exit below.
      } finally { await connection?.close(); }
    }
    const stopped = await client.request({ op: 'stop', name: record.spec.name, timeoutMs: 5000 });
    const confirmed = await client.request({ op: 'describe', name: record.spec.name });
    if (stopped.op !== 'stop' || confirmed.op !== 'describe' || stopped.daemon.id !== described.daemon.id || confirmed.daemon.id !== described.daemon.id || !['exited', 'failed'].includes(confirmed.daemon.state) || confirmed.daemon.pid !== null) throw new ExecutorEffectUncertain('Managed browser cleanup unconfirmed');
    await rm(path, { force: true });
  }
  /** Individual uncertain records remain visible; one broken record never blocks startup. */
  recover(): Promise<void> {
    this.recovery ??= (async () => {
      await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
      await chmod(this.options.directory, 0o700);
      await this.supervisor();
      const claims = join(this.options.directory, 'authorizations');
      await mkdir(claims, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(claims)).slice(0, 10000)) {
        const path = join(claims, name);
        if (!/^[0-9a-f]{64}$/.test(name) || (await stat(path)).size > 32) continue;
        const expires = Number(await readFile(path, 'utf8'));
        if (Number.isFinite(expires) && expires <= Date.now()) await rm(path, { force: true });
        else this.used.set(name, Number.isFinite(expires) ? expires : Number.POSITIVE_INFINITY);
      }
      const directory = join(this.options.directory, 'launches');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await Promise.all((await readdir(directory)).slice(0, 200).map(async name => {
        const entry: Recovery = { id: name, projectId: 'unknown', workspaceId: 'unknown', state: 'uncertain', reason: 'Unrecognized launch record', path: join(directory, name) };
        this.records.set(name, entry);
        try {
          if (!/^browser-[0-9a-f-]+\.json$/.test(name) || (await stat(entry.path)).size > 65_536) throw new Error('Invalid launch record');
          const raw: unknown = JSON.parse(await readFile(entry.path, 'utf8'));
          const placement = z.object({ projectId: z.string().min(1).max(256), workspaceId: z.string().min(1).max(256) }).safeParse(raw);
          if (placement.success) { entry.projectId = placement.data.projectId; entry.workspaceId = placement.data.workspaceId; }
          entry.record = ManagedRecord.parse(raw);
          if (`${entry.record.spec.name}.json` !== name) throw new Error('Launch record identity changed');
          void this.stopManaged(entry.record, entry.path).then(() => { this.records.delete(name); }, error => { entry.reason = boundedText(error instanceof Error ? error.message : 'Recovery failed', 1024); });
        } catch (error) {
          entry.record = undefined;
          entry.reason = boundedText(error instanceof Error ? error.message : 'Recovery failed', 1024);
          try {
            if (await (await this.supervisor()).privateScopeAbsent(entry.projectId === 'unknown' || entry.workspaceId === 'unknown' ? undefined : `runtime:${entry.projectId}:${entry.workspaceId}`)) { entry.state = 'stopped'; entry.reason = 'Private supervisor proves no live managed browser for this scope'; }
          } catch { /* Unavailable or corrupt registry is not proof of absence. */ }
        }
      }));
      const fences = join(this.options.directory, 'fences');
      await mkdir(fences, { recursive: true, mode: 0o700 });
      for (const name of (await readdir(fences)).slice(0, 200)) {
        const path = join(fences, name);
        try {
          if ((await stat(path)).size > 16_384) continue;
          const value = z.object({ id: z.string(), projectId: z.string(), workspaceId: z.string(), targetId: z.string(), groupId: z.string(), expiresAt: z.string() }).parse(JSON.parse(await readFile(path, 'utf8')));
          if (Date.parse(value.expiresAt) <= Date.now()) { await rm(path, { force: true }); continue; }
          this.records.set(value.id, { ...value, path, state: 'fenced', reason: 'Browser effect outcome requires human reconciliation' });
        } catch { this.records.set(name, { id: name, path, projectId: 'unknown', workspaceId: 'unknown', state: 'uncertain', reason: 'Invalid browser fence record' }); }
      }
    })().catch(error => { this.records.set('recovery', { id: 'recovery', projectId: 'unknown', workspaceId: 'unknown', state: 'uncertain', reason: boundedText(String(error), 1024), path: '' }); });
    return this.recovery;
  }
  private async executable() {
    if (this.options.executablePath) return this.options.executablePath;
    const cacheDir = join(this.options.directory, 'chromium'), platform = detectBrowserPlatform();
    if (!platform) throw new Error('Managed Chromium unsupported');
    const installed = (await getInstalledBrowsers({ cacheDir })).find(item => item.browser === Browser.CHROME && item.platform === platform);
    return installed?.executablePath ?? (await install({ browser: Browser.CHROME, platform, buildId: await resolveBuildId(Browser.CHROME, platform, 'stable'), cacheDir })).executablePath;
  }
  private async profile(dispatch: RuntimeToolDispatch, signal: AbortSignal) {
    const key = this.profileKey(dispatch), existing = this.profiles.get(key);
    if (existing) return existing;
    if ([...this.records.values()].some(item => (item.projectId === 'unknown' || item.projectId === dispatch.projectId) && (item.workspaceId === 'unknown' || item.workspaceId === dispatch.workspaceId) && item.state === 'uncertain')) throw new Error('Workspace browser profile requires recovery');
    const profile = join(this.options.directory, 'profiles', key), name = `browser-${randomUUID()}`;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await chmod(profile, 0o700);
    const record = ManagedRecord.parse({ owner: `runtime:${dispatch.projectId}:${dispatch.workspaceId}`, projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, profile, spec: { name, application: await this.executable(), args: ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], cwd: this.options.directory, env: {}, pty: false, persist: true, detached: false, restart: 'no' } });
    const path = join(this.options.directory, 'launches', `${name}.json`);
    await durableWrite(path, record);
    try {
      const supervisor = await this.supervisor();
      const started = await supervisor.startPrivatePipe({ op: 'start', owner: record.owner, spec: record.spec });
      if (started.op !== 'start' || !started.daemon.pid) throw new ExecutorEffectUncertain('Browser launch identity unavailable');
      const identity = await processIdentity(started.daemon.pid);
      if (!identity) throw new ExecutorEffectUncertain('Browser launch process identity unavailable');
      record.identity = identity;
      await durableWrite(path, record);
      signal.throwIfAborted();
      const connection = new BrowserConnection(supervisor.privatePipe(name));
      await connection.send('Browser.getVersion');
      const result = { connection, record, path, tabs: 0 };
      this.profiles.set(key, result); return result;
    } catch (error) {
      try { await this.stopManaged(record, path); } catch (cleanup) { this.records.set(name, { id: name, projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, state: 'uncertain', reason: boundedText(String(cleanup), 1024), record, path }); }
      throw error;
    }
  }
  private async closeTab(tab: Tab, explicit = false) {
    tab.stale = true; tab.refs.clear(); clearTimeout(tab.timer); tab.unsubscribe();
    this.tabs.delete(tab.targetId);
    if (tab.grant.source === 'relay') {
      try { if (explicit) await tab.channel.send('Target.closeTarget', { targetId: tab.targetId }); }
      finally { await tab.channel.close(); }
    } else {
      await tab.channel.send('Target.closeTarget', { targetId: tab.targetId });
      const profile = tab.profileKey && this.profiles.get(tab.profileKey);
      if (profile) profile.tabs--;
    }
  }
  private async revokeGroup(groupId: string) {
    const group = this.groups.get(groupId);
    if (group) await durableWrite(join(this.options.directory, 'revoked', createHash('sha256').update(group.signature).digest('hex')), { expiresAt: group.grant.expiresAt });
    await Promise.all([...this.tabs.values()].filter(tab => tab.grant.groupId === groupId).map(tab => this.closeTab(tab)));
    if (group?.grant.source === 'relay') await this.options.relay?.revoke(groupId);
    this.groups.delete(groupId);
  }
  private async expireGroup(groupId: string, signature: string) {
    if (this.groups.get(groupId)?.signature === signature) await this.revokeGroup(groupId);
  }
  private allows(grant: RuntimeBrowserGrant, url: string) {
    if (grant.source === 'headless') return true;
    return url === 'about:blank' || grant.origins.some(pattern => browserOriginMatches(pattern, new URL(url).hostname));
  }
  async closeAttachment(local: LocalAttachment) {
    const tabs = [...this.tabs.values()].filter(tab => tab.grant.attachmentId === local.attachment.attachmentId && tab.grant.generation === local.attachment.generation);
    for (const tab of tabs) { tab.stale = true; tab.refs.clear(); }
    const keys = new Set(tabs.map(tab => createHash('sha256').update(JSON.stringify([tab.grant.projectId, tab.grant.workspaceId])).digest('hex')));
    await Promise.all([...keys].map(key => this.queues.get(key)));
    const groups = [...this.groups.values()].filter(group => group.grant.attachmentId === local.attachment.attachmentId && group.grant.generation === local.attachment.generation);
    await Promise.all(groups.map(group => this.revokeGroup(group.grant.groupId)));
  }
  async close() {
    this.closed = true; await Promise.all([...this.queues.values()]); await this.recover();
    await Promise.allSettled([...this.groups.keys()].map(groupId => this.revokeGroup(groupId)));
    const outcomes = await Promise.allSettled([...this.profiles.values()].map(async profile => { await this.stopManaged(profile.record, profile.path); await profile.connection.close(); }));
    this.profiles.clear(); this.outputs.clear();
    const failed = outcomes.find(item => item.status === 'rejected'); if (failed?.status === 'rejected') throw failed.reason;
  }
  async execute(dispatch: RuntimeToolDispatch, local: LocalAttachment, signal: AbortSignal): Promise<ExecutorContent> {
    if (!this.options.enabled) throw new Error('Browser execution unavailable on this machine');
    if (!this.options.verifyAuthorization || !dispatch.browserAuthorization) throw new Error('Signed browser authorization required');
    const body = await this.options.verifyAuthorization(dispatch.browserAuthorization, dispatch);
    signal.throwIfAborted(); if (this.closed) throw new Error('Browser manager closed');
    for (const [id, expires] of this.used) if (expires <= Date.now()) this.used.delete(id);
    if (this.used.has(dispatch.attemptId)) throw new Error('Browser authorization already consumed');
    if (this.used.size >= 10_000) throw new Error('Browser authorization capacity reached');
    this.used.set(dispatch.attemptId, Date.parse(body.expiresAt));
    await this.recover();
    const claims = join(this.options.directory, 'authorizations');
    await mkdir(claims, { recursive: true, mode: 0o700 });
    const claimPath = join(claims, createHash('sha256').update(dispatch.attemptId).digest('hex'));
    let claim;
    try { claim = await open(claimPath, 'wx', 0o600); }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('Browser authorization already consumed');
      throw error;
    }
    try { await claim.writeFile(String(Date.parse(body.expiresAt))); await claim.sync(); } finally { await claim.close(); }
    setTimeout(() => { void rm(claimPath, { force: true }).catch(() => {}); }, Math.max(1, Date.parse(body.expiresAt) - Date.now())).unref();
    for (const [id, record] of this.records) if (record.expiresAt && Date.parse(record.expiresAt) <= Date.now()) {
      if (record.path) await rm(record.path, { force: true });
      this.records.delete(id);
    }
    return this.serial(this.profileKey(dispatch), async () => {
      if (Date.parse(body.expiresAt) <= Date.now()) throw new Error('Browser authorization expired while queued');
      signal.throwIfAborted();
      const command = body.command;
      if (command.type === 'tabs') {
        if (!this.options.relay) throw new Error('User browser relay unavailable');
        await this.options.relay.authorize(dispatch.browserAuthorization!, signal);
        return [{ type: 'text', text: JSON.stringify(await this.options.relay.tabs(command.groupId, signal)) }];
      }
      const relayCommand = command.type === 'execute' ? command.grant.body.source === 'relay' : command.type === 'prepare' ? command.args.source === 'relay' : command.action === 'revoke' ? this.groups.get(command.groupId ?? '')?.grant.source === 'relay' : command.action === 'reconcile' && this.records.get(command.recordId ?? '')?.state === 'fenced';
      if (relayCommand) {
        if (!this.options.relay) throw new Error('User browser relay unavailable');
        await this.options.relay.authorize(dispatch.browserAuthorization!, signal);
      }
      if (command.type === 'manage') return this.manage(dispatch, command);
      if (command.type === 'prepare') return this.prepare(dispatch, command.args, command.groupId, signal);
      return this.perform(dispatch, local, command.args, command.grant, signal);
    });
  }
  private async prepare(dispatch: RuntimeToolDispatch, args: z.infer<typeof RuntimeBrowserArgumentsSchema>, groupId: string, signal: AbortSignal): Promise<ExecutorContent> {
    if (args.source === 'relay') {
      if (!this.options.relay) throw new Error('User browser relay unavailable');
      await this.options.relay.prepare(args, groupId, signal);
    }
    const grant = RuntimeBrowserGrantSchema.parse({ projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, machineId: dispatch.machineId, attachmentId: dispatch.attachmentId, generation: dispatch.generation, groupId, groupName: dispatch.workspaceId, source: args.source, origins: [], expiresAt: new Date(Date.now() + (this.options.grantMilliseconds ?? 30 * 60_000)).toISOString() });
    const result: RuntimeBrowserPreparation = { ...grant, id: randomUUID(), action: args.action, requiresApproval: browserNeedsExplicitApproval(args) };
    return [{ type: 'text', text: JSON.stringify(result) }];
  }
  private async manage(dispatch: RuntimeToolDispatch, command: Extract<RuntimeBrowserAuthorizationBody['command'], {type:'manage'}>): Promise<ExecutorContent> {
    let result: unknown = { ok: true };
    if (command.action === 'status') {
      result = { groups: [...this.groups.values()].filter(item => item.grant.projectId === dispatch.projectId && item.grant.workspaceId === dispatch.workspaceId).slice(0, 200).map(item => ({ ...item.grant, state: [...this.tabs.values()].some(tab => tab.grant.groupId === item.grant.groupId && tab.stale) ? 'fenced' : 'active' })), records: [...this.records.values()].filter(item => (item.projectId === 'unknown' || item.projectId === dispatch.projectId) && (item.workspaceId === 'unknown' || item.workspaceId === dispatch.workspaceId)).slice(0, 200).map(({ id, projectId, workspaceId, state, reason, expiresAt, groupId }) => ({ id, projectId, workspaceId, state, reason, expiresAt, groupId, actions: state === 'stopped' ? ['discard'] : ['reconcile'] })) };
    } else if (command.action === 'artifact') result = this.outputs.read(JSON.stringify([dispatch.projectId, dispatch.workspaceId]), command.artifactId ?? '', command.offset, command.limit);
    else if (command.action === 'revoke') {
      const tab = this.groups.get(command.groupId ?? '');
      if (!tab || tab.grant.projectId !== dispatch.projectId || tab.grant.workspaceId !== dispatch.workspaceId) throw new Error('Browser tab outside workspace');
      await this.revokeGroup(tab.grant.groupId);
    } else {
      const record = this.records.get(command.recordId ?? '');
      if (!record || (record.projectId !== 'unknown' && record.projectId !== dispatch.projectId) || (record.workspaceId !== 'unknown' && record.workspaceId !== dispatch.workspaceId)) throw new Error('Browser recovery record outside workspace');
      if (command.action === 'discard') {
        if (!await (await this.supervisor()).privateScopeAbsent(record.projectId === 'unknown' || record.workspaceId === 'unknown' ? undefined : `runtime:${record.projectId}:${record.workspaceId}`)) throw new Error('Managed browser absence is not proven');
        if (record.state !== 'stopped') throw new Error('Reconcile browser process before discarding its recovery record');
        if (record.path) await rm(record.path, { force: true });
        this.records.delete(record.id);
      } else {
        if (record.record) await this.stopManaged(record.record, record.path);
        else if (record.state === 'fenced' && record.groupId) {
          const tab = this.groups.get(record.groupId);
          if (tab) await this.revokeGroup(record.groupId);
          else await this.options.relay?.revoke(record.groupId);
        } else {
          if (!await (await this.supervisor()).privateScopeAbsent(record.projectId === 'unknown' || record.workspaceId === 'unknown' ? undefined : `runtime:${record.projectId}:${record.workspaceId}`)) throw new Error('Managed browser absence is not proven');
        }
        record.state = 'stopped'; record.reason = 'Browser access stopped; original effect was not replayed';
      }
    }
    return [{ type: 'text', text: JSON.stringify(result) }];
  }
  private async perform(dispatch: RuntimeToolDispatch, local: LocalAttachment, args: z.infer<typeof RuntimeBrowserArgumentsSchema>, signed: RuntimeBrowserSignedGrant, signal: AbortSignal): Promise<ExecutorContent> {
    const grant = signed.body;
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Browser grant expired');
    try { await stat(join(this.options.directory, 'revoked', createHash('sha256').update(signed.signature).digest('hex'))); throw new Error('Browser group stale: revoked'); }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
    if (args.source !== grant.source) throw new Error('Browser source differs from grant');
    const existing = this.groups.get(grant.groupId);
    if (existing && (existing.grant.projectId !== grant.projectId || existing.grant.workspaceId !== grant.workspaceId || existing.grant.source !== grant.source)) throw new Error('Browser group owner changed');
    if (existing && existing.signature !== signed.signature) {
      await durableWrite(join(this.options.directory, 'revoked', createHash('sha256').update(existing.signature).digest('hex')), { expiresAt: existing.grant.expiresAt });
      for (const target of [...this.tabs.values()].filter(target => target.grant.groupId === grant.groupId)) {
        if (existing.scope !== this.scope(dispatch)) { await this.closeTab(target); continue; }
        target.grant = grant;
        target.refs.clear();
        clearTimeout(target.timer);
        target.timer = setTimeout(() => { void this.serial(this.profileKey(dispatch), () => this.expireGroup(grant.groupId, signed.signature)).catch(() => {}); }, Math.max(1, Date.parse(grant.expiresAt) - Date.now()));
        target.timer.unref();
        try {
          const frame = FrameTree.parse(await target.channel.send('Page.getFrameTree', {}, target.sessionId)).frameTree.frame;
          if (!this.allows(grant, frame.url)) { target.stale = true; target.reason = 'Origin excluded by renewed group grant'; }
        } catch {
          target.stale = true; target.reason = 'Renewed group cannot authorize existing target';
        }
      }
    }
    this.groups.set(grant.groupId, { grant, signature: signed.signature, scope: this.scope(dispatch) });
    if (args.action === 'tabs') {
      const tabs = grant.source === 'relay' ? await this.options.relay!.tabs(grant.groupId, signal) : await Promise.all([...this.tabs.values()].filter(tab => tab.grant.groupId === grant.groupId && !tab.stale).map(async tab => TargetInfo.parse(await tab.channel.send('Target.getTargetInfo', { targetId: tab.targetId })).targetInfo));
      return [{ type: 'text', text: JSON.stringify(tabs) }];
    }
    if ([...this.records.values()].some(record => record.groupId === grant.groupId && record.state === 'fenced')) throw new Error('Browser group has unresolved effect');
    let tab = args.targetId ? this.tabs.get(args.targetId) : undefined;
    if (tab && (tab.grant.groupId !== grant.groupId || tab.scope !== this.scope(dispatch))) throw new Error('Browser target outside group');
    if (tab?.stale) throw new Error('Browser target stale');
    if (args.action === 'open' && tab && grant.source === 'relay') {
      await this.options.relay!.open(signed, args, signal);
      return [{ type: 'text', text: JSON.stringify({ groupId: grant.groupId, targetId: tab.targetId, source: grant.source, expiresAt: grant.expiresAt }) }];
    }
    if (args.action === 'open' || (!tab && grant.source === 'relay')) {
      if (this.tabs.size >= 200) throw new Error('Browser tab capacity reached');
      if (args.action === 'open' && args.url) { navigation(args.url); if (!this.allows(grant, args.url)) throw new Error('Browser origin not authorized'); }
      let channel: RuntimeBrowserRelayChannel, targetId: string, profileKey: string | undefined;
      if (grant.source === 'relay') {
        if (!this.options.relay) throw new Error('User browser relay unavailable');
        const opened = await this.options.relay.open(signed, args, signal); channel = opened; targetId = opened.targetId;
      } else {
        if (args.action !== 'open') throw new Error('Browser target unavailable');
        const profile = await this.profile(dispatch, signal); channel = profile.connection; profileKey = this.profileKey(dispatch);
        if (args.targetId) {
          if (!tab) throw new Error('Headless target outside group');
          targetId = tab.targetId;
          await channel.send('Target.activateTarget', { targetId });
          if (args.url) await channel.send('Page.navigate', { url: args.url }, tab.sessionId);
          return [{ type: 'text', text: JSON.stringify({ groupId: grant.groupId, targetId, source: grant.source }) }];
        }
        targetId = z.object({ targetId: z.string() }).parse(await channel.send('Target.createTarget', { url: args.url ?? 'about:blank', background: true })).targetId;
        profile.tabs++;
      }
      let attached: { sessionId: string };
      try { attached = z.object({ sessionId: z.string() }).parse(await channel.send('Target.attachToTarget', { targetId, flatten: true })); }
      catch (error) {
        try {
          if (grant.source === 'relay') await channel.close();
          else { await channel.send('Target.closeTarget', { targetId }); const profile = profileKey && this.profiles.get(profileKey); if (profile) profile.tabs--; }
        } catch (cleanup) { throw new ExecutorEffectUncertain('Browser attach cleanup unconfirmed', { cause: cleanup }); }
        throw error;
      }
      const opened: Tab = { grant, scope: this.scope(dispatch), channel, targetId, sessionId: attached.sessionId, refs: new Map(), document: 0, stale: false, profileKey, unsubscribe: () => {}, timer: setTimeout(() => { void this.serial(this.profileKey(dispatch), () => this.expireGroup(grant.groupId, signed.signature)).catch(() => {}); }, Math.max(1, Date.parse(grant.expiresAt) - Date.now())) };
      opened.timer.unref();
      opened.unsubscribe = channel.subscribe(raw => {
        const parsed = CdpEvent.safeParse(raw); if (!parsed.success) return;
        const event = parsed.data;
        if (event.method === 'disconnected' || (event.method === 'Target.detachedFromTarget' && event.params?.sessionId === opened.sessionId) || (event.method === 'Target.targetDestroyed' && event.params?.targetId === opened.targetId)) { opened.stale = true; opened.reason = 'Browser target disconnected'; }
        if (event.sessionId !== opened.sessionId) return;
        if (event.method === 'DOM.documentUpdated' || (event.method === 'Page.frameNavigated' && !event.params?.frame?.parentId)) { opened.document++; opened.refs.clear(); }
        if (event.method === 'Page.frameNavigated' && event.params?.frame && !event.params.frame.parentId && !this.allows(opened.grant, event.params.frame.url)) { opened.stale = true; opened.reason = 'Navigation outside group origins'; }
      });
      this.tabs.set(targetId, opened); tab = opened;
      try { await channel.send('Page.enable', {}, opened.sessionId); await channel.send('DOM.enable', {}, opened.sessionId); }
      catch (error) { try { await this.closeTab(opened, true); } catch (cleanup) { throw new ExecutorEffectUncertain('Browser open cleanup unconfirmed', { cause: cleanup }); } throw error; }
      if (args.action === 'open') return [{ type: 'text', text: JSON.stringify({ groupId: grant.groupId, targetId, source: grant.source, expiresAt: grant.expiresAt }) }];
    } else if (grant.source === 'relay' && tab) {
      await this.options.relay!.open(signed, args, signal);
    }
    if (!tab || tab.stale || Date.parse(tab.grant.expiresAt) <= Date.now()) throw new Error('Browser target stale or outside scope');
    const frame = FrameTree.parse(await tab.channel.send('Page.getFrameTree', {}, tab.sessionId)).frameTree.frame;
    if (!this.allows(grant, frame.url)) { tab.stale = true; throw new Error('Browser origin outside group'); }
    const active = tab;
    const send = async (method: string, params: Record<string, unknown> = {}) => { signal.throwIfAborted(); if (active.stale) throw new Error('Browser tab stale'); return active.channel.send(method, params, active.sessionId); };
    const effect = ['act', 'navigate', 'evaluate'].includes(args.action);
    const fenceId = `fence-${grant.groupId}`, fencePath = join(this.options.directory, 'fences', fenceId);
    if (effect) {
      const entry: Recovery = { id: fenceId, groupId: grant.groupId, projectId: dispatch.projectId, workspaceId: dispatch.workspaceId, state: 'fenced', reason: 'Browser operation outcome uncertain', path: fencePath, targetId: tab.targetId, expiresAt: grant.expiresAt };
      await durableWrite(fencePath, entry); this.records.set(fenceId, entry);
    }
    let uncertain = false;
    try {
      let result: unknown = { ok: true };
      const content: ExecutorContent = [];
      if (args.action === 'close') await this.closeTab(tab, true);
      else if (args.action === 'navigate') {
        navigation(args.url);
        if (!this.allows(grant, args.url)) throw new Error('Navigation origin not authorized');
        const navigationResult = await send('Page.navigate', { url: args.url });
        result = grant.source === 'relay'
          ? z.object({ loaded: z.boolean(), frameId: z.string() }).parse(navigationResult)
          : z.object({ frameId: z.string().optional(), errorText: z.string().optional() }).parse(navigationResult);
        tab.refs.clear(); tab.document++;
      } else if (args.action === 'evaluate') {
        const evaluated = Evaluation.parse(await send('Runtime.evaluate', { expression: args.expression, returnByValue: true, awaitPromise: true }));
        if (evaluated.exceptionDetails) throw new Error('Browser expression failed'); result = evaluated.result.value ?? null;
      } else if (args.action === 'observe') {
        const document = tab.document;
        const tree = AxTree.parse(await send('Accessibility.getFullAXTree', { depth: 32 }));
        if (document !== tab.document) throw new Error('Browser document changed during observation');
        if (grant.source === 'relay') {
          if (tree.gitspaceDocument === undefined) throw new Error('Relay observation lacks document identity');
          tab.document = tree.gitspaceDocument;
        }
        // Chromium exposes editable values again as descendant StaticText/InlineTextBox
        // names. Redact the complete AX subtree before pagination, including ignored
        // ancestors and generic rich-text/contenteditable roots.
        const children = new Map<string, string[]>();
        const sensitiveIds = new Set<string>();
        const sensitiveRoots = new Set<string>();
        const pending: string[] = [];
        for (const node of tree.nodes) {
          if (node.childIds) children.set(node.nodeId, [...node.childIds]);
          const role = typeof node.role?.value === 'string' ? node.role.value : '';
          if (['textbox', 'searchbox', 'combobox', 'spinbutton', 'slider', 'listbox'].includes(role)
            || node.properties?.some(property => (property.name === 'editable' && property.value.value !== false && property.value.value !== undefined)
              || (property.name === 'protected' && property.value.value === true))) { pending.push(node.nodeId); sensitiveRoots.add(node.nodeId); }
        }
        for (const node of tree.nodes) if (node.parentId) {
          const siblings = children.get(node.parentId);
          if (siblings) siblings.push(node.nodeId); else children.set(node.parentId, [node.nodeId]);
        }
        while (pending.length) {
          const id = pending.pop()!;
          if (sensitiveIds.has(id)) continue;
          sensitiveIds.add(id);
          for (const child of children.get(id) ?? []) pending.push(child);
        }
        const visible = tree.nodes.filter(node => !node.ignored);
        const nodes: { ref?: string; role: string; name: string }[] = [];
        let bytes = 0, next = args.offset;
        for (const node of visible.slice(args.offset, args.offset + args.limit)) {
          const role = typeof node.role?.value === 'string' ? boundedText(node.role.value, 128) : '';
          const sensitive = sensitiveIds.has(node.nodeId);
          const ref = node.backendDOMNodeId ? `${tab.document}:${node.backendDOMNodeId}` : undefined;
          const labelSource = sensitiveRoots.has(node.nodeId) ? node.name?.sources?.find(source =>
            !source.superseded && !source.invalid && typeof source.value?.value === 'string'
            && ((source.type === 'attribute' && source.attribute === 'aria-label')
              || (source.type === 'relatedElement' && (source.attribute === 'aria-labelledby'
                || ['label', 'labelfor', 'labelwrapped'].includes(source.nativeSource ?? ''))))) : undefined;
          const safeLabel = typeof labelSource?.value?.value === 'string' ? boundedText(labelSource.value.value, 512) : undefined;
          const item = { ref, role, name: sensitive ? safeLabel ?? '[form field]' : boundedText(typeof node.name?.value === 'string' ? node.name.value : '', 512) };
          const size = Buffer.byteLength(JSON.stringify(item)); if (bytes + size > 24_000) break;
          bytes += size; next++; nodes.push(item); if (ref && node.backendDOMNodeId) tab.refs.set(ref, node.backendDOMNodeId);
        }
        while (tab.refs.size > 1000) tab.refs.delete(tab.refs.keys().next().value!);
        result = { groupId: grant.groupId, targetId: tab.targetId, nodes, nextOffset: next < visible.length ? next : null, total: visible.length };
      } else if (args.action === 'act') {
        const backendNodeId = tab.refs.get(args.ref);
        if (!backendNodeId) throw new Error('Element reference stale; observe again');
        const node = z.object({ node: z.object({ backendNodeId: z.number(), nodeName: z.string() }) }).parse(await send('DOM.describeNode', { backendNodeId }));
        if (node.node.backendNodeId !== backendNodeId) throw new Error('Element reference target changed');
        let connected: boolean;
        if (tab.grant.source === 'relay') connected = z.object({ connected: z.boolean() }).parse(await send('GitSpace.validateRef', { backendNodeId })).connected;
        else {
          const object = z.object({ object: z.object({ objectId: z.string() }) }).parse(await send('DOM.resolveNode', { backendNodeId }));
          try { connected = Evaluation.parse(await send('Runtime.callFunctionOn', { objectId: object.object.objectId, functionDeclaration: 'function(){return this.isConnected && this.ownerDocument === document}', returnByValue: true })).result.value === true; }
          finally { await send('Runtime.releaseObject', { objectId: object.object.objectId }); }
        }
        if (!connected || tab.refs.get(args.ref) !== backendNodeId) throw new Error('Element reference detached or document changed');
        if (args.operation === 'click') {
          await send('DOM.scrollIntoViewIfNeeded', { backendNodeId });
          const quad = Box.parse(await send('DOM.getBoxModel', { backendNodeId })).model.content;
          const x = (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4, y = (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4;
          if (tab.refs.get(args.ref) !== backendNodeId) throw new Error('Element document changed');
          await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }); await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
        } else {
          await send('DOM.focus', { backendNodeId });
          if (args.operation === 'fill') {
            if (args.value === undefined) throw new Error('Fill requires value');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: process.platform === 'darwin' ? 4 : 2, commands: ['selectAll'] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA' }); await send('Input.insertText', { text: args.value });
          } else {
            const keys: Record<string, number> = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Space: 32 };
            if (!args.value || !keys[args.value]) throw new Error('Unsupported key');
            await send('Input.dispatchKeyEvent', { type: 'keyDown', key: args.value, windowsVirtualKeyCode: keys[args.value] }); await send('Input.dispatchKeyEvent', { type: 'keyUp', key: args.value, windowsVirtualKeyCode: keys[args.value] });
          }
        }
      }
      if (args.action === 'screenshot' || (args.action === 'observe' && args.screenshot)) {
        const refs = [...tab.refs].slice(0, 100).map(([ref, backendNodeId]) => ({ ref, backendNodeId }));
        let viewport: { width: number; height: number }, contextId: number | undefined;
        if (tab.grant.source === 'relay') viewport = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(await send('GitSpace.screenshotPrepare', { refs }));
        else {
          contextId = z.object({ executionContextId: z.number() }).parse(await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'gitspace-browser-mask' })).executionContextId;
          const boxes: { ref: string; x: number; y: number }[] = [];
          for (const ref of refs) { try { const quad = Box.parse(await send('DOM.getBoxModel', { backendNodeId: ref.backendNodeId })).model.content; boxes.push({ ref: ref.ref, x: quad[0]!, y: quad[1]! }); } catch {} }
          viewport = z.object({ width: z.number().positive(), height: z.number().positive() }).parse(Evaluation.parse(await send('Runtime.callFunctionOn', { executionContextId: contextId, functionDeclaration: browserScreenshotPrepareFunction, arguments: [{ value: boxes }], returnByValue: true })).result.value);
        }
        try {
          let data = '';
          const initialScale = Math.min(1, 1280 / viewport.width, 1280 / viewport.height);
          for (const scale of [initialScale, initialScale / 2, initialScale / 4]) {
            data = z.object({ data: z.string().max(8_000_000) }).parse(await send('Page.captureScreenshot', { format: 'jpeg', quality: 60, captureBeyondViewport: false, clip: { x: 0, y: 0, width: viewport.width, height: viewport.height, scale } })).data;
            if (Buffer.byteLength(data, 'base64') <= BROWSER_IMAGE_BYTES) break;
          }
          if (Buffer.byteLength(data, 'base64') > BROWSER_IMAGE_BYTES) throw new Error('Browser screenshot exceeds image limit');
          content.push({ type: 'image', data, mimeType: 'image/jpeg' });
        } finally {
          if (tab.grant.source === 'relay') await send('GitSpace.screenshotRestore');
          else await send('Runtime.callFunctionOn', { executionContextId: contextId, functionDeclaration: browserScreenshotRestoreFunction, returnByValue: true });
        }
      }
      signal.throwIfAborted();
      const text = JSON.stringify(result);
      return [{ type: 'text', text: Buffer.byteLength(text) <= BROWSER_TEXT_BYTES ? text : JSON.stringify({ artifact: this.outputs.put(JSON.stringify([dispatch.projectId, dispatch.workspaceId]), text, dispatch.machineId) }) }, ...content];
    } catch (error) {
      uncertain = effect && (error instanceof ExecutorEffectUncertain || signal.aborted);
      if (uncertain) { tab.stale = true; tab.reason = 'Browser effect uncertain'; tab.refs.clear(); }
      throw error;
    } finally { if (effect && !uncertain) { await rm(fencePath, { force: true }); this.records.delete(fenceId); } }
  }
}
