import { z } from 'zod';
import { RuntimeAccountBrowserGrantSchema, RuntimeAccountBrowserGroupRowSchema, canonicalBrowserAuthorization, type RuntimeAccountBrowserAuthorization, type RuntimeAccountBrowserGrant, type RuntimeBrowserArguments, type RuntimeToolResult } from '@gitspace/protocol-runtime';
import { performBrowserAction, type BrowserSemanticTab } from '@gitspace/runtime-machine/browser-semantic';
import { BrowserOutputStore } from '@gitspace/runtime-machine/browser-output';
import { BrowserServicePolicy, BrowserServicePaused, type BrowserWorkspaceServiceHostname } from '@gitspace/runtime-machine/browser-service-policy';
import type { BrowserChannel } from './browser-cdp.js';
import { browserOriginMatches } from '@gitspace/protocol-environment';

type Tab = BrowserSemanticTab & { grant: RuntimeAccountBrowserGrant; channel: BrowserChannel; sessionId: string; stale: boolean; servicePolicy?: BrowserServicePolicy; unsubscribeServices?: () => void; unsubscribe(): void };
export type AccountBrowserTransport = {
  open(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<{ channel: BrowserChannel; targetId: string }>;
  tabs(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<unknown>;
  preview(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<{ image: string | null; reason: string | null }>;
  revoke(groupId: string, pairingId: string): Promise<void>;
};
/** How a cloud tab reaches its workspace's hosted services. `urlPattern` narrows interception to hosted names;
 * `admit` gives the browser its own session for one of the workspace's hostnames, after which the request goes to the
 * network like any page's, so responses stream and WebSockets open. */
export type AccountBrowserServices = { urlPattern: string; hostname(hostname: string): boolean; workspace: BrowserWorkspaceServiceHostname; admit(hostname: string): Promise<void> };
export class AccountBrowserRuntime {
  private tabs = new Map<string, Tab>();
  private groups = new Map<string, RuntimeAccountBrowserGrant>();
  private queues = new Map<string, Promise<void>>();
  private outputs = new BrowserOutputStore();
  private cloud = new Map<string, Promise<BrowserChannel>>();
  /** `cloud` opens this workspace's view of its cloud browser (a client of the browser session object). */
  constructor(private readonly options: { storage: { get(key: string): Promise<unknown>; put(key: string, value: unknown): Promise<void>; delete(key: string): Promise<boolean> }; cloud?: (signal: AbortSignal) => Promise<BrowserChannel>; relay?: AccountBrowserTransport; services?: AccountBrowserServices }) {}
  async execute(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<RuntimeToolResult> {
    const { body } = authorization;
    const scope = JSON.stringify([body.scope.projectId, body.scope.workspaceId]);
    const predecessor = this.queues.get(scope) ?? Promise.resolve();
    const operation = predecessor.catch(() => {}).then(() => this.perform(authorization, signal));
    const settled = operation.then(() => {}, () => {}); this.queues.set(scope, settled);
    try { return await operation; } finally { if (this.queues.get(scope) === settled) this.queues.delete(scope); }
  }
  private async perform(authorization: RuntimeAccountBrowserAuthorization, signal: AbortSignal): Promise<RuntimeToolResult> {
    const { body } = authorization, { command, scope } = body;
    signal.throwIfAborted();
    // Tabs whose group expired go before the next operation; no timer keeps the host object awake for them. A cloud
    // tab closes; a tab in your Chrome stays open in its group and is only let go.
    for (const tab of [...this.tabs.values()]) {
      if (Date.parse(tab.grant.expiresAt) > Date.now()) continue;
      if (tab.grant.source === 'relay') { tab.unsubscribe(); this.tabs.delete(tab.targetId); continue; }
      await this.closeTab(tab).catch(() => { tab.unsubscribe(); this.tabs.delete(tab.targetId); });
    }
    if (Date.parse(body.expiresAt) <= Date.now()) throw new Error('Browser authorization expired');
    if (scope.placement.kind === 'account-relay' && scope.conversationKind !== 'main') throw new Error('Logged-in Chrome relay is main-agent-only');
    const claim = `browser.account.claim:${scope.projectId}:${scope.workspaceId}:${scope.attemptId}`;
    if (await this.options.storage.get(claim)) throw new Error('Browser authorization already consumed');
    await this.options.storage.put(claim, body.expiresAt);
    const result = (content: RuntimeToolResult['content']): RuntimeToolResult => ({ status: 'completed', requestId: scope.requestId, attemptId: scope.attemptId, content });
    const json = (value: unknown) => result([{ type: 'text', text: JSON.stringify(value) }]);
    if (command.type === 'manage') {
      if (command.action === 'artifact') return json(this.outputs.read(JSON.stringify([scope.projectId, scope.workspaceId]), command.artifactId ?? '', command.offset, command.limit));
      if (command.action === 'status') {
        const ids = z.array(z.string().uuid()).parse(await this.options.storage.get(`browser.account.groups:${scope.projectId}:${scope.workspaceId}`) ?? []);
        const groups = [];
        for (const groupId of ids) {
          const stored = await this.options.storage.get(`browser.account.group:${groupId}`);
          if (!stored || await this.options.storage.get(`browser.account.revoked:${groupId}`)) continue;
          const grant = RuntimeAccountBrowserGroupRowSchema.parse(stored);
          if (canonicalBrowserAuthorization(grant.placement) !== canonicalBrowserAuthorization(scope.placement)) continue;
          groups.push({ ...grant, state: Date.parse(grant.expiresAt) <= Date.now() ? 'expired' : [...this.tabs.values()].some(tab => tab.grant.groupId === groupId && tab.stale) ? 'fenced' : 'active' });
        }
        return json({ groups, records: [] });
      }
      if ((command.action !== 'revoke' && command.action !== 'preview') || !command.groupId) throw new Error('Account browser recovery requires revoking the exact group');
      const stored = await this.options.storage.get(`browser.account.group:${command.groupId}`);
      const grant = stored ? RuntimeAccountBrowserGroupRowSchema.parse(stored) : this.groups.get(command.groupId);
      if (!grant || grant.projectId !== scope.projectId || grant.workspaceId !== scope.workspaceId) throw new Error('Browser group outside workspace');
      // Previews on your Chrome come from its extension; the cloud browser's from the workspace's browser session.
      if (command.action === 'preview') {
        if (!this.options.relay || canonicalBrowserAuthorization(grant.placement) !== canonicalBrowserAuthorization(scope.placement)) throw new Error('Browser group outside this Chrome');
        return json(await this.options.relay.preview(authorization, signal));
      }
      await this.options.storage.put(`browser.account.revoked:${grant.groupId}`, true);
      for (const tab of [...this.tabs.values()]) if (tab.grant.groupId === grant.groupId) await this.closeTab(tab);
      if (grant.placement.kind === 'account-relay') await this.options.relay?.revoke(grant.groupId, grant.placement.pairingId);
      this.groups.delete(grant.groupId);
      return json({ groups: [], records: [] });
    }
    if (command.type === 'tabs') {
      if (!this.options.relay) throw new Error('Account browser relay unavailable');
      return json(await this.options.relay.tabs(authorization, signal));
    }
    const grant = RuntimeAccountBrowserGrantSchema.parse(command.grant.body), args = command.args;
    if (await this.options.storage.get(`browser.account.revoked:${grant.groupId}`)) throw new Error('Browser group revoked');
    if (Date.parse(grant.expiresAt) <= Date.now()) throw new Error('Browser group expired');
    const stored = await this.options.storage.get(`browser.account.group:${grant.groupId}`);
    const previous = stored ? RuntimeAccountBrowserGroupRowSchema.parse(stored) : this.groups.get(grant.groupId);
    // A renewal may move the expiry, the approved origins and the group's name; the workspace, browser and source make
    // it the same group, so anything else under the same id is refused.
    const same = (value: RuntimeAccountBrowserGrant) => canonicalBrowserAuthorization({ projectId: value.projectId, workspaceId: value.workspaceId, placement: value.placement, source: value.source });
    if (previous && same(previous) !== same(grant)) throw new Error('Browser group grant changed');
    this.groups.set(grant.groupId, grant);
    await this.options.storage.put(`browser.account.group:${grant.groupId}`, grant);
    const indexKey = `browser.account.groups:${scope.projectId}:${scope.workspaceId}`;
    const ids = z.array(z.string().uuid()).parse(await this.options.storage.get(indexKey) ?? []);
    if (!ids.includes(grant.groupId)) await this.options.storage.put(indexKey, [...ids, grant.groupId]);
    if (args.action === 'tabs') {
      if (grant.source === 'relay') {
        if (!this.options.relay) throw new Error('Account browser relay unavailable');
        return json(await this.options.relay.tabs(authorization, signal));
      }
      return json(await Promise.all([...this.tabs.values()].filter(tab => tab.grant.groupId === grant.groupId && !tab.stale).map(async tab => z.object({ targetInfo: z.unknown() }).parse(await tab.channel.send('Target.getTargetInfo', { targetId: tab.targetId })).targetInfo)));
    }
    // Scripts never reach the tool runtime: the workspace's browser session object runs them, on either browser.
    if (args.action === 'run') throw new Error('Browser scripts run in the workspace’s browser session');
    let tab = args.targetId ? this.tabs.get(args.targetId) : undefined;
    if (tab && (tab.grant.groupId !== grant.groupId || tab.stale)) throw new Error('Browser target stale or outside group');
    if (tab) tab.grant = grant;
    if (args.action === 'open' || !tab && grant.source === 'relay') {
      if (this.tabs.size >= 200) throw new Error('Browser tab capacity reached');
      let channel: BrowserChannel, targetId: string;
      if (grant.source === 'relay') {
        if (!this.options.relay) throw new Error('Account browser relay unavailable');
        ({ channel, targetId } = await this.options.relay.open(authorization, signal));
      } else {
        if (args.action !== 'open') throw new Error('Browser target unavailable');
        channel = await this.cloudChannel(grant, signal);
        targetId = z.object({ targetId: z.string() }).parse(await channel.send('Target.createTarget', { url: 'about:blank', background: true })).targetId;
      }
      const { sessionId } = z.object({ sessionId: z.string() }).parse(await channel.send('Target.attachToTarget', { targetId, flatten: true }));
      const opened: Tab = { grant, channel, targetId, sessionId, refs: new Map(), document: 0, stale: false, unsubscribe: () => {} };
      opened.unsubscribe = channel.subscribe(event => {
        if (event.method === 'disconnected') opened.stale = true;
        if (event.sessionId !== opened.sessionId) return;
        if (event.method === 'DOM.documentUpdated' || event.method === 'Page.frameNavigated') { opened.document++; opened.refs.clear(); }
      });
      this.tabs.set(targetId, opened); tab = opened;
      await channel.send('Page.enable', {}, sessionId); await channel.send('DOM.enable', {}, sessionId);
      if (grant.source === 'headless') await this.interceptServices(opened);
      if (args.action === 'open' && args.url && grant.source === 'headless') { opened.servicePolicy?.beginNavigation(args.url); try { await channel.send('Page.navigate', { url: args.url }, sessionId); } finally { opened.servicePolicy?.endNavigation(); } }
      if (args.action === 'open') return json({ groupId: grant.groupId, targetId, source: grant.source, expiresAt: grant.expiresAt });
    } else if (grant.source === 'relay' && this.options.relay) await this.options.relay.open(authorization, signal);
    if (!tab || tab.stale) throw new Error('Browser target stale or unavailable');
    const active = tab;
    const frame = z.object({ frameTree: z.object({ frame: z.object({ id: z.string(), url: z.string() }) }) }).parse(await active.channel.send('Page.getFrameTree', {}, active.sessionId)).frameTree.frame;
    const effect = ['act', 'evaluate', 'navigate'].includes(args.action);
    try {
      const content = await performBrowserAction({ tab: active, args, frame, signal, send: async (method, params) => {
        signal.throwIfAborted(); if (active.stale || Date.parse(active.grant.expiresAt) <= Date.now()) throw new Error('Browser disconnected or expired');
        if (method === 'Page.navigate' && typeof params?.url === 'string') active.servicePolicy?.beginNavigation(params.url);
        try { return await active.channel.send(method, params, active.sessionId); }
        finally { if (method === 'Page.navigate') active.servicePolicy?.endNavigation(); }
      }, close: () => this.closeTab(active), allows: url => grant.source === 'headless' || url === 'about:blank' || grant.origins.some(origin => browserOriginMatches(origin, new URL(url).hostname)), artifact: text => this.outputs.put(JSON.stringify([scope.projectId, scope.workspaceId]), text, scope.placement.accountId), selectAllModifier: 2 });
      return result(content);
    } catch (error) {
      if (!effect) throw error;
      // The page may or may not have changed; the agent is told so and decides, nothing is locked.
      active.refs.clear();
      throw new Error(`Browser ${args.action} outcome unknown: ${error instanceof Error ? error.message : String(error)}. Observe the page before repeating it.`);
    }
  }
  private async closeTab(tab: Tab) {
    tab.stale = true; tab.refs.clear();
    tab.unsubscribeServices?.();
    await tab.channel.send('Target.closeTarget', { targetId: tab.targetId });
    tab.unsubscribe(); this.tabs.delete(tab.targetId);
    if (tab.grant.source === 'headless' && ![...this.tabs.values()].some(other => other.channel === tab.channel)) {
      await tab.channel.send('Browser.close'); await tab.channel.close();
      this.cloud.delete(JSON.stringify([tab.grant.projectId, tab.grant.workspaceId]));
    }
  }
  private cloudChannel(grant: RuntimeAccountBrowserGrant, signal: AbortSignal) {
    const key = JSON.stringify([grant.projectId, grant.workspaceId]);
    let current = this.cloud.get(key);
    if (!current) {
      if (!this.options.cloud) throw new Error('Cloud browser unavailable');
      current = this.options.cloud(signal); this.cloud.set(key, current);
      void current.catch(() => { if (this.cloud.get(key) === current) this.cloud.delete(key); });
    }
    return current;
  }
  private async interceptServices(tab: Tab) {
    const services = this.options.services;
    if (!services) return;
    const policy = new BrowserServicePolicy(hostname => services.workspace(hostname, tab.grant));
    tab.servicePolicy = policy;
    tab.unsubscribeServices = tab.channel.subscribe(event => {
      policy.observe(event, tab.sessionId);
      if (event.sessionId !== tab.sessionId || event.method !== 'Fetch.requestPaused') return;
      const paused = BrowserServicePaused.safeParse(event.params);
      if (!paused.success) { tab.stale = true; return; }
      const { requestId, request } = paused.data;
      void (async () => {
        const { hostname } = new URL(request.url);
        if (services.hostname(hostname)) {
          if (!await policy.allows(paused.data)) { await tab.channel.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }, tab.sessionId); return; }
          await services.admit(hostname);
        }
        await tab.channel.send('Fetch.continueRequest', { requestId }, tab.sessionId);
      })().catch(async () => { tab.stale = true; try { await tab.channel.send('Fetch.failRequest', { requestId, errorReason: 'AccessDenied' }, tab.sessionId); } catch {} });
    });
    policy.initialize(await tab.channel.send('Page.getFrameTree', {}, tab.sessionId));
    await tab.channel.send('Network.enable', {}, tab.sessionId);
    await tab.channel.send('Fetch.enable', { patterns: [{ urlPattern: services.urlPattern, requestStage: 'Request' }] }, tab.sessionId);
  }
}
