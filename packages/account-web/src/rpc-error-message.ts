import { rpcErrors } from '@gitspace/protocol/rpc-contract';
import { isTaggedError } from 'result-rpc';

const frameworkMessages: Readonly<Record<string, string>> = {
  'server/internal': 'The server could not complete this request.',
  'server/bad-request': 'The server rejected this request. Refresh and try again.',
  'client/offline': 'You appear to be offline. Check your connection and try again.',
  'client/network-failure': 'The server could not be reached. Check your connection and try again.',
  'client/timeout': 'The request timed out. Its outcome may be unknown; refresh before trying again.',
  'client/http-failure': 'The server returned an unsuccessful HTTP response.',
  'client/protocol-violation': 'The server returned an incompatible response. Refresh and try again.',
  'client/decode-failure': 'The server response could not be read. Refresh and try again.',
  'client/stale': 'This app is out of date. Refresh to load the current version.',
};

const domainMessages: Readonly<Record<string, string>> = {
  [rpcErrors.projectNotFound.tag]: 'This project is no longer available. Refresh the project directory.',
  [rpcErrors.workspaceNotFound.tag]: 'This workspace is no longer available. Refresh the workspace directory.',
  [rpcErrors.sessionNotFound.tag]: 'This session is no longer available. Refresh the workspace.',
  [rpcErrors.terminalNotFound.tag]: 'This terminal is no longer available. Refresh the terminal list.',
  [rpcErrors.workspacePossessed.tag]: 'Another machine holds this workspace. Refresh its placement before continuing.',
  [rpcErrors.workspaceUnpossessed.tag]: 'This workspace is not open on a machine. Open it before continuing.',
  [rpcErrors.sessionBusy.tag]: 'This session is busy. Wait for its current operation to finish.',
  [rpcErrors.settingsConflict.tag]: 'Settings changed since you loaded them. Refresh before saving again.',
  [rpcErrors.spaceGenerationConflict.tag]: 'Workspace placement changed. Refresh before continuing.',
  [rpcErrors.inspectorConflict.tag]: 'This Inspector record changed since you loaded it. Refresh before saving again.',
  [rpcErrors.skillConflict.tag]: 'This skill changed since you loaded it. Refresh before saving again.',
  [rpcErrors.mcpRevisionConflict.tag]: 'This integration changed since you loaded it. Refresh before saving again.',
  [rpcErrors.mcpNotFound.tag]: 'This integration connection or grant is no longer available. Refresh integrations.',
};

/** Presentation only: keep the original tagged error for policy, identity, and diagnostics. */
export function rpcErrorMessage(error: unknown, operation: string): string {
  if (!isTaggedError(error)) return error instanceof Error ? error.message : `${operation}: The request failed.`;
  const data = error.data;
  const fields = data !== null && typeof data === 'object' ? data : undefined;
  const domainMessage = fields && 'message' in fields && typeof fields.message === 'string' && fields.message.trim()
    ? fields.message : undefined;
  const incidentId = fields && 'incidentId' in fields && typeof fields.incidentId === 'string' && fields.incidentId.trim()
    ? fields.incidentId : undefined;
  // Framework errors deliberately expose only an allowlisted explanation, never causes or response bodies.
  const message = frameworkMessages[error._tag] ?? domainMessage ?? domainMessages[error._tag] ?? `The request failed (${error._tag}).`;
  return `${operation}: ${message}${incidentId ? ` Incident ID: ${incidentId}.` : ''}`;
}
