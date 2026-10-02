import { mcpAccessResultSchema, type McpAccessView, type McpAccessOperation } from '@gitspace/protocol/mcp-access';
import { RPC_DEVICE_HEADER } from '@gitspace/protocol/device-grant';
import { currentDevice } from './device-session.js';
import { accountHandleFromUrl } from './browser-enrollment.js';
import { prepareApiClientInvite, signDeviceRequest, type ApiClientDraft } from './device.js';

export type McpAccessDraft = Pick<ApiClientDraft, 'scope' | 'capabilities' | 'ttlMs'>;
export type McpAccessValue = McpAccessView & { token?: string };
export interface McpAccessActions {
  canManageMcp: boolean;
  canEnableMcp: boolean;
  onMcpStatus: () => Promise<McpAccessView>;
  onMcpEnable: (expectedRevision: number, draft: McpAccessDraft) => Promise<McpAccessValue>;
  onMcpRotate: (expectedRevision: number) => Promise<McpAccessValue>;
  onMcpDisable: (expectedRevision: number) => Promise<McpAccessValue>;
}

export async function requestMcpAccess(operation: McpAccessOperation, expectedRevision?: number, draft?: McpAccessDraft): Promise<McpAccessValue> {
  const device = await currentDevice();
  if (!device) throw new Error('This browser is not enrolled');
  const pageUrl = new URL(window.location.href);
  const url = new URL(`/v1/mcp-access/${operation}`, accountHandleFromUrl(pageUrl) ? pageUrl.origin : device.enrollUrl);
  const invite = operation === 'enable' && draft ? await prepareApiClientInvite(device, { ...draft, label: 'GitSpace MCP' }) : undefined;
  const body = JSON.stringify({ userId: device.userId, ...(operation === 'status' ? {} : { expectedRevision }), ...(invite ? { invite } : {}) });
  const signature = await signDeviceRequest(device, { method: 'POST', path: url.pathname, body: new TextEncoder().encode(body) });
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-gitspace-user': device.userId, [RPC_DEVICE_HEADER]: signature }, body });
  const result = mcpAccessResultSchema.parse(await response.json());
  if (result.status === 'error') throw new Error(result.error.message);
  if (!response.ok) throw new Error('MCP access request failed');
  return result.value;
}
