import { z } from 'zod';

const Frame = z.object({ id: z.string(), parentId: z.string().optional(), url: z.string() });
const FrameTree = z.object({ frame: Frame, get childFrames(): z.ZodOptional<z.ZodArray<typeof FrameTree>> { return z.array(FrameTree).optional(); } });
const Event = z.object({ method: z.string(), sessionId: z.string().optional(), params: z.unknown().optional() });
const NetworkRequest = z.object({ requestId: z.string(), frameId: z.string().optional(), type: z.string(), documentURL: z.string(), initiator: z.object({ type: z.string(), url: z.string().optional(), requestId: z.string().optional(), stack: z.object({ callFrames: z.array(z.object({ url: z.string() })) }).optional() }), request: z.object({ url: z.string() }), redirectResponse: z.unknown().optional() });
export const BrowserServicePaused = z.object({ requestId: z.string(), networkId: z.string().optional(), frameId: z.string().optional(), resourceType: z.string().optional(), redirectedRequestId: z.string().optional(), request: z.object({ url: z.string(), method: z.string(), headers: z.record(z.string(), z.string()), postData: z.string().optional() }) });
export type BrowserServiceScope = { projectId: string; workspaceId: string };
export type BrowserWorkspaceServiceHostname = (hostname: string, scope: BrowserServiceScope) => boolean | Promise<boolean>;
type ServiceRequest = { url: string; frameId: string | undefined; sourceFrameId: string | undefined; type: string; document: string | undefined; documentURL: string; explicit: boolean; unattributedNavigation: boolean; redirected: boolean; continued: boolean; allowed: boolean; isPreflight: boolean; preflight: ServiceRequest | undefined };
function networkURL(value: string) {
  const url = URL.parse(value);
  if (!url) return undefined;
  url.hash = '';
  return url.href;
}

/** CDP document evidence owns authority; browser fetch metadata can only deny it. */
export class BrowserServicePolicy {
  private frames = new Map<string, z.infer<typeof Frame>>();
  private requests = new Map<string, ServiceRequest>();
  private navigation: { url: string; frameId: string } | undefined;
  constructor(private readonly workspaceHostname: (hostname: string) => boolean | Promise<boolean>) {}
  initialize(raw: unknown) {
    const tree = z.object({ frameTree: FrameTree }).parse(raw).frameTree;
    const visit = (node: z.infer<typeof FrameTree>): void => { this.frames.set(node.frame.id, node.frame); node.childFrames?.forEach(visit); };
    visit(tree);
  }
  beginNavigation(url: string) {
    const root = [...this.frames.values()].find(frame => !frame.parentId);
    this.navigation = root ? { url: networkURL(url) ?? url, frameId: root.id } : undefined;
  }
  endNavigation() { this.navigation = undefined; }
  observe(raw: unknown, sessionId: string) {
    const event = Event.safeParse(raw);
    if (!event.success || event.data.sessionId !== sessionId) return;
    if (event.data.method === 'Page.frameNavigated') {
      const frame = z.object({ frame: Frame }).safeParse(event.data.params);
      if (frame.success) this.frames.set(frame.data.frame.id, frame.data.frame);
    } else if (event.data.method === 'Page.navigatedWithinDocument') {
      const navigated = z.object({ frameId: z.string(), url: z.string() }).safeParse(event.data.params);
      if (!navigated.success) return;
      const frame = this.frames.get(navigated.data.frameId);
      if (frame) this.frames.set(frame.id, { ...frame, url: navigated.data.url });
    } else if (event.data.method === 'Page.frameAttached') {
      const attached = z.object({ frameId: z.string(), parentFrameId: z.string() }).safeParse(event.data.params);
      if (attached.success) this.frames.set(attached.data.frameId, { id: attached.data.frameId, parentId: attached.data.parentFrameId, url: 'about:blank' });
    } else if (event.data.method === 'Page.frameDetached') {
      const detached = z.object({ frameId: z.string() }).safeParse(event.data.params);
      if (detached.success) this.frames.delete(detached.data.frameId);
    } else if (event.data.method === 'Network.requestWillBeSent') {
      const parsed = NetworkRequest.safeParse(event.data.params);
      if (!parsed.success) return;
      const request = parsed.data, frame = request.frameId ? this.frames.get(request.frameId) : undefined;
      const previous = this.requests.get(request.requestId);
      const redirected = request.redirectResponse !== undefined;
      const explicit = !redirected && request.type === 'Document' && request.initiator.type === 'other' && request.frameId === this.navigation?.frameId && networkURL(request.request.url) === this.navigation?.url;
      if (request.frameId === this.navigation?.frameId && request.type === 'Document') this.navigation = undefined;
      // Root links/forms still require the browser's cross-site veto in allows:
      // the destination root alone cannot identify a child targeting _top.
      // Child navigation needs parser attribution to its parent.
      const parent = frame?.parentId ? this.frames.get(frame.parentId) : undefined;
      const initiatorURL = request.initiator.url ?? request.initiator.stack?.callFrames[0]?.url;
      const rootInitiator = request.initiator.type === 'other' || request.initiator.type === 'script'
        && !!initiatorURL && URL.parse(initiatorURL)?.origin === URL.parse(frame?.url ?? '')?.origin;
      const source = request.type !== 'Document' ? frame
        : frame && !frame.parentId && rootInitiator ? frame
        : request.initiator.type === 'parser' && request.initiator.url === parent?.url ? parent : undefined;
      const preflight = request.initiator.type === 'preflight' && request.initiator.requestId ? this.requests.get(request.initiator.requestId) : undefined;
      this.requests.set(request.requestId, { url: request.request.url, frameId: request.frameId, sourceFrameId: source?.id, type: request.type, document: source?.url, documentURL: request.documentURL, explicit, unattributedNavigation: request.type === 'Document' && request.initiator.type === 'other', redirected, continued: redirected && previous?.allowed === true && previous.frameId === request.frameId && previous.type === request.type, allowed: false, isPreflight: request.initiator.type === 'preflight', preflight });
    } else if (event.data.method === 'Network.loadingFinished' || event.data.method === 'Network.loadingFailed') {
      const ended = z.object({ requestId: z.string() }).safeParse(event.data.params);
      if (ended.success) this.requests.delete(ended.data.requestId);
    }
  }
  private async isWorkspaceURL(value: string | undefined) {
    if (!value) return false;
    const url = URL.parse(value);
    return !!url && (url.protocol === 'https:' || url.protocol === 'http:') && await this.workspaceHostname(url.hostname);
  }
  async allows(paused: z.infer<typeof BrowserServicePaused>) {
    if (!await this.isWorkspaceURL(paused.request.url) || !paused.networkId) return false;
    const request = this.requests.get(paused.networkId);
    if (!request || request.url !== paused.request.url || !paused.resourceType) return false;
    const frameId = request.frameId ?? (request.isPreflight ? request.preflight?.frameId : undefined);
    if (!frameId || frameId !== paused.frameId) return false;
    // CDP may report fetch() as Network.Fetch but Fetch.XHR. Authority depends
    // on document navigation versus subresource, not those domain-specific labels.
    if ((request.type === 'Document') !== (paused.resourceType === 'Document')) return false;
    if (paused.redirectedRequestId && !request.redirected) return false;
    // The target root is not necessarily the source of a link/form: a child
    // can navigate _top. Fetch may omit Sec-Fetch-Site, so browser-owned source
    // headers must corroborate the committed document, never grant authority.
    if (request.type === 'Document' && !request.explicit) {
      const documentOrigin = request.document ? URL.parse(request.document)?.origin : undefined;
      let sourceObserved = false;
      for (const name in paused.request.headers) {
        const value = paused.request.headers[name], header = name.toLowerCase();
        if (header === 'sec-fetch-site' && value?.toLowerCase() === 'cross-site') return false;
        if (request.redirected || (header !== 'origin' && header !== 'referer')) continue;
        if (!documentOrigin || !value || URL.parse(value)?.origin !== documentOrigin) return false;
        sourceObserved = true;
      }
      if (request.unattributedNavigation && !request.redirected && !sourceObserved) return false;
    }
    let allowed: boolean;
    if (request.redirected) allowed = request.continued;
    else if (request.explicit) allowed = true;
    else if (request.isPreflight) {
      const initiator = request.preflight;
      // Chromium omits a frame on preflights; its linked request carries the
      // independent committed-document evidence. Origin/Referer are never proof.
      allowed = !!initiator && paused.request.method === 'OPTIONS' && initiator.type !== 'Document'
        && initiator.url === request.url && !initiator.redirected
        && await this.hasDocumentAuthority(initiator);
    } else allowed = await this.hasDocumentAuthority(request);
    request.allowed = allowed;
    return allowed;
  }
  private async hasDocumentAuthority(request: ServiceRequest) {
    const current = request.sourceFrameId ? this.frames.get(request.sourceFrameId) : undefined;
    if (!current || current.url !== request.document || !await this.isWorkspaceURL(request.document)) return false;
    // For subresources CDP's documentURL must name the committed source, not
    // merely some other workspace service URL supplied by another document.
    return request.type === 'Document' || networkURL(request.documentURL) === networkURL(current.url);
  }
}
