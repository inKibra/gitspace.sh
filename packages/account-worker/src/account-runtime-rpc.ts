import { deviceCanAdminister, type DeviceCapability, type GitSpaceRpcContext } from '@gitspace/protocol';
import {
  runtimeSnapshotContract, runtimeSubmitContract, runtimeCancelContract,
  runtimeAnswerContract, runtimeWatchContract, runtimeSessionContract,
  runtimeExecutionMachineContract, runtimeQaContract, runtimeAttachmentRequestContract, runtimeCacheAttachmentRequestContract, runtimeAttachmentDetachRequestContract,
  runtimeBrowserTrustContract, runtimeCacheActionContract, runtimeCachePolicyContract, runtimeDraftContract,
  runtimeServicesContract,
} from '@gitspace/protocol/rpc-contract';
import { RuntimeIdentitySchema, RuntimeWatchEventSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeSessionResultSchema } from '@gitspace/protocol-runtime/session-controls';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { z } from 'zod';
import { requireRuntimeIdentity } from './runtime-access.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const MAX_EVENT_CHARACTERS = 8 * 1024 * 1024;

/** The workspace id is resolved canonically; possession of a project id is not authority. */
export async function requireRuntimeAccess(
  env: Env, userId: string, deviceId: string,
  input: z.infer<typeof RuntimeIdentitySchema>, capability: DeviceCapability,
) {
  const vault = env.CREDENTIALS.getByName(userId);
  const device = await vault.currentDeviceGrant(deviceId);
  if (!device || !device.capabilities.includes(capability)) throw new Error('Runtime authorization has expired or lacks permission');
  const access = await requireRuntimeIdentity(env, userId, input, capability !== 'rpc.read');
  if (device.scope.kind === 'project' && device.scope.projectId !== input.projectId) throw new Error('Workspace is outside the device project scope');
  if (device.scope.kind === 'workspace' && device.scope.workspaceId !== input.workspaceId) throw new Error('Workspace is outside the device workspace scope');
  return { device, ...access };
}

async function* watchEvents(response: Response, signal: AbortSignal) {
  if (!response.ok || !response.body) throw new Error(`Runtime subscription failed (${response.status})`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '';
  const cancel = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true });
      let newline: number;
      while ((newline = pending.indexOf('\n')) !== -1) {
        if (newline > MAX_EVENT_CHARACTERS) throw new Error('Runtime event exceeds the delivery limit');
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (line.trim()) yield RuntimeWatchEventSchema.parse(JSON.parse(line));
      }
      if (pending.length > MAX_EVENT_CHARACTERS) throw new Error('Runtime event exceeds the delivery limit');
      if (chunk.done) {
        if (pending.trim()) throw new Error('Runtime subscription ended inside an event');
        return;
      }
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function runtimeCloudProcedures(env: Env, userId: string, deviceId: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const snapshot = server.implement(runtimeSnapshotContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.read');
      return ok(RuntimeSnapshotSchema.parse(await (await authority.runtimeSnapshot(input)).json()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'read cloud runtime', message: message(error) })); }
  });
  const browserTrust = server.implement(runtimeBrowserTrustContract).handler(async ({ errors }) => {
    try {
      const device = await env.CREDENTIALS.getByName(userId).currentDeviceGrant(deviceId);
      if (!device || device.kind !== 'browser' || !deviceCanAdminister(device, 'account.admin')) throw new Error('Browser pairing requires a browser administrator');
      return ok(await env.ACCOUNT_STATE.getByName(userId).browserTrust());
    } catch (error) { return err(errors.OperationFailed({ operation: 'read browser trust root', message: message(error) })); }
  });
  const draft = server.implement(runtimeDraftContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeDraft(input, { deviceId }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'save workspace draft', message: message(error) })); }
  });
  const submit = server.implement(runtimeSubmitContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeSubmit(input, { deviceId }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'submit cloud conversation', message: message(error) })); }
  });
  const cancel = server.implement(runtimeCancelContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeCancel(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'cancel cloud conversation', message: message(error) })); }
  });
  const answer = server.implement(runtimeAnswerContract).handler(async ({ input, errors }) => {
    try {
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeAnswer(input, { deviceId, canApprove: device.kind === 'browser' && deviceCanAdminister(device, 'account.admin') }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'answer cloud conversation', message: message(error) })); }
  });
  const session = server.implement(runtimeSessionContract).handler(async ({ input, errors }) => {
    try {
      const read = ['control', 'agentSetup', 'historyAnchorId', 'historyPage', 'messages', 'transcriptPage', 'transcriptContent', 'usage'].includes(input.command.type);
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, read ? 'rpc.read' : 'session.prompt');
      if (['setApproval', 'setWorkspacePhase', 'saveAgentDefinition', 'reloadSettings', 'instructionsChanged', 'inferenceChanged'].includes(input.command.type)
        && !deviceCanAdminister(device, 'account.admin')) throw new Error('This session command requires account administration');
      if (['setApproval', 'answerAsk'].includes(input.command.type) && device.kind !== 'browser') throw new Error('Human session decisions require the browser');
      return ok(RuntimeSessionResultSchema.parse(await (await authority.runtimeSession(input, { deviceId, canApprove: device.kind === 'browser' && deviceCanAdminister(device, 'account.admin') })).json()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'control cloud session', message: message(error) })); }
  });
  const services = server.implement(runtimeServicesContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, input.command.op === 'list' || input.command.op === 'logs' ? 'rpc.read' : 'rpc.write');
      return ok(await authority.runtimeServices(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'control workspace services', message: message(error) })); }
  });
  const executionMachine = server.implement(runtimeExecutionMachineContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeExecutionMachine(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'set workspace execution machine', message: message(error) })); }
  });
  const qa = server.implement(runtimeQaContract).handler(async ({ input, errors }) => {
    try {
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      if (input.action.kind === 'share' && (device.kind !== 'browser' || !deviceCanAdminister(device, 'account.admin'))) throw new Error('Sharing a QA report requires a browser administrator');
      return ok(await authority.runtimeQa(input, { deviceId, canApprove: input.action.kind !== 'share' || (device.kind === 'browser' && deviceCanAdminister(device, 'account.admin')) }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'review runtime QA report', message: message(error) })); }
  });
  const requestAttachment = server.implement(runtimeAttachmentRequestContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeAttachmentRequest(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'request executor attachment', message: message(error) })); }
  });
  const requestCacheAttachment = server.implement(runtimeCacheAttachmentRequestContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeCacheAttachmentRequest(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'request cache attachment', message: message(error) })); }
  });
  const detachAttachment = server.implement(runtimeAttachmentDetachRequestContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeAttachmentDetachRequest(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'drain executor attachment', message: message(error) })); }
  });
  const cacheAction = server.implement(runtimeCacheActionContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeCacheAction(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'request cache action', message: message(error) })); }
  });
  const cachePolicy = server.implement(runtimeCachePolicyContract).handler(async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeCachePolicy(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'configure cache policy', message: message(error) })); }
  });
  const watch = server.implement(runtimeWatchContract).stream(async function* ({ input, signal, errors }) {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.read');
      for await (const event of watchEvents(await authority.runtimeWatch(input), signal)) {
        await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.read');
        yield ok(event);
      }
    } catch (error) {
      if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'watch cloud runtime', message: message(error) }));
    }
  });
  return { snapshot, draft, submit, cancel, answer, browserTrust, session, services, executionMachine, qa, cachePolicy, attachment: { request: requestAttachment, cache: { request: requestCacheAttachment }, action: cacheAction, detach: detachAttachment }, watch };
}
