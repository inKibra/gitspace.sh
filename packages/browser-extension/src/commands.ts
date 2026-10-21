import { browserOriginMatches } from '@gitspace/protocol-environment/browser-origin';

/** The DevTools commands a grant allows on its tab; enforced inside the installed extension. */
export function relayCommandAllowed(grant: { origins: string[] }, targetId: string, session: string, method: string, params: Record<string, unknown>, sessionId?: string): boolean {
  if (sessionId && sessionId !== session) return false;
  if (['Target.attachToTarget', 'Target.getTargetInfo', 'Target.closeTarget'].includes(method)) return params.targetId === targetId;
  if (method === 'Page.navigate') { try { const url = new URL(String(params.url)); return typeof params.url === 'string' && ['http:', 'https:'].includes(url.protocol) && grant.origins.some(pattern => browserOriginMatches(pattern, url.hostname)) && !params.frameId; } catch { return false; } }
  if (method === 'Runtime.evaluate') return typeof params.expression === 'string' && !params.contextId && !params.uniqueContextId;
  return ['Page.enable', 'Page.getFrameTree', 'Page.getLayoutMetrics', 'Page.captureScreenshot', 'DOM.enable', 'DOM.describeNode', 'DOM.getBoxModel', 'DOM.focus', 'DOM.scrollIntoViewIfNeeded', 'Accessibility.enable', 'Accessibility.getFullAXTree', 'Input.dispatchMouseEvent', 'Input.dispatchKeyEvent', 'Input.insertText', 'GitSpace.screenshotPrepare', 'GitSpace.screenshotRestore', 'GitSpace.validateRef'].includes(method);
}
