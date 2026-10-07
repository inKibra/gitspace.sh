import { z } from 'zod';
import { RuntimeAccountBrowserPairingSchema, RuntimeAccountBrowserRelayStatusSchema, RuntimeProjectBrowserSettingsSchema, type RuntimeProjectBrowserPreferences } from '@gitspace/protocol-runtime';
import { createDeviceSignedFetch } from './device.js';
import { currentDevice, deviceRejected } from './device-session.js';

const signedFetch = createDeviceSignedFetch(currentDevice, deviceRejected);
async function request(...[action, body]:
  | [action: 'pair' | 'status' | 'extension.zip']
  | [action: 'unpair', body: { pairingId: string }]
  | [action: 'confirm', body: { pairingId: string; fingerprint: string }]
  | [action: 'project-status', body: { projectId: string }]
  | [action: 'project-update', body: { projectId: string; expectedRevision: number; preferences: RuntimeProjectBrowserPreferences }]
) {
  const device = await currentDevice();
  if (!device) throw new Error('Reconnect your account browser first');
  const response = await signedFetch(new URL(`/api/browser-relay/${action}`, device.enrollUrl), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ userId: device.userId, ...body }) });
  if (!response.ok) throw new Error(`Account browser ${action} failed (${response.status})`);
  return response;
}
export async function accountBrowserStatus() {
  const result = z.object({ status: z.literal('ok'), value: RuntimeAccountBrowserRelayStatusSchema }).parse(await (await request('status')).json());
  return result.value;
}
export async function pairAccountBrowser() {
  const result = z.object({ status: z.literal('ok'), value: RuntimeAccountBrowserPairingSchema }).parse(await (await request('pair')).json());
  return result.value;
}
export async function unpairAccountBrowser(pairingId: string) {
  const result = z.object({ status: z.literal('ok'), value: RuntimeAccountBrowserRelayStatusSchema }).parse(await (await request('unpair', { pairingId })).json());
  return result.value;
}
export async function confirmAccountBrowser(pairingId: string, fingerprint: string) {
  const result = z.object({ status: z.literal('ok'), value: RuntimeAccountBrowserRelayStatusSchema }).parse(await (await request('confirm', { pairingId, fingerprint })).json());
  return result.value;
}
export async function projectBrowserSettings(projectId: string) {
  const result = z.object({ status: z.literal('ok'), value: RuntimeProjectBrowserSettingsSchema }).parse(await (await request('project-status', { projectId })).json());
  return result.value;
}
export async function updateProjectBrowserSettings(projectId: string, expectedRevision: number, preferences: RuntimeProjectBrowserPreferences) {
  const result = z.object({ status: z.literal('ok'), value: RuntimeProjectBrowserSettingsSchema }).parse(await (await request('project-update', { projectId, expectedRevision, preferences })).json());
  return result.value;
}
export async function downloadAccountBrowserExtension() {
  const response = await request('extension.zip');
  const url = URL.createObjectURL(await response.blob());
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'gitspace-browser-extension.zip';
  try { document.body.append(anchor); anchor.click(); } finally { anchor.remove(); URL.revokeObjectURL(url); }
}
