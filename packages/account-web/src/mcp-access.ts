import { mcpAccessResultSchema, type McpAccessResult } from '@gitspace/protocol/mcp-access';
import { RPC_DEVICE_HEADER } from '@gitspace/protocol/device-grant';
import { currentDevice } from './device-session.js';
import { accountHandleFromUrl } from './browser-enrollment.js';
import { prepareApiClientInvite, signDeviceRequest, type ApiClientDraft } from './device.js';

export type McpAccessDraft = Pick<ApiClientDraft, 'label' | 'scope' | 'capabilities' | 'ttlMs'>;
export type McpAccessValue = Extract<McpAccessResult, { status: 'ok' }>['value'];
export type McpAccessRequest =
  | { operation: 'status' }
  | { operation: 'create'; expectedRevision: number; draft: McpAccessDraft }
  | { operation: 'rotate' | 'disable'; expectedRevision: number; connectionId: string };
export interface McpAccessActions {
  canManageMcp: boolean;
  canCreateMcp: boolean;
  onMcpStatus: () => Promise<McpAccessValue>;
  onMcpCreate: (expectedRevision: number, draft: McpAccessDraft) => Promise<McpAccessValue>;
  onMcpRotate: (expectedRevision: number, connectionId: string) => Promise<McpAccessValue>;
  onMcpDisable: (expectedRevision: number, connectionId: string) => Promise<McpAccessValue>;
}

export async function requestMcpAccess(request: McpAccessRequest): Promise<McpAccessValue> {
  const device = await currentDevice();
  if (!device) throw new Error('This browser is not enrolled');
  const pageUrl = new URL(window.location.href);
  const url = new URL(`/v1/mcp-access/${request.operation}`, accountHandleFromUrl(pageUrl) ? pageUrl.origin : device.enrollUrl);
  const body = JSON.stringify(request.operation === 'status' ? { userId: device.userId }
    : request.operation === 'create' ? { userId: device.userId, expectedRevision: request.expectedRevision, label: request.draft.label, invite: await prepareApiClientInvite(device, request.draft) }
    : { userId: device.userId, expectedRevision: request.expectedRevision, connectionId: request.connectionId });
  const signature = await signDeviceRequest(device, { method: 'POST', path: url.pathname, body: new TextEncoder().encode(body) });
  const response = await fetch(url, { method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', 'x-gitspace-user': device.userId, [RPC_DEVICE_HEADER]: signature }, body });
  const result = mcpAccessResultSchema.parse(await response.json());
  if (result.status === 'error') throw new Error(result.error.message);
  if (!response.ok) throw new Error('MCP access request failed');
  return result.value;
}
