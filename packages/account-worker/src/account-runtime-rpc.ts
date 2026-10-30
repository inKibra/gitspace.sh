import { deviceCanAdminister, type DeviceCapability, type GitSpaceRpcContext } from '@gitspace/protocol';
import {
  runtimeSnapshotContract, runtimeSubmitContract, runtimeCancelContract,
  runtimeAnswerContract, runtimeWatchContract, runtimeSessionContract, runtimeImageUploadContract,
  runtimeQaContract, runtimeCacheAttachmentRequestContract, runtimeAttachmentDetachRequestContract,
  runtimeBrowserTrustContract, runtimeDraftContract,
  runtimeServicesContract, runtimeSyncContract,
} from '@gitspace/protocol/rpc-contract';
import { RuntimeIdentitySchema, RuntimeWatchEventsSchema, RuntimeSnapshotSchema } from '@gitspace/protocol-runtime';
import { RuntimeSessionResultSchema } from '@gitspace/protocol-runtime/session-controls';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { z } from 'zod';
import { requireWorkspaceAccess } from './runtime-access.js';
import { observeRuntimeRequest } from './account-runtime-control.js';
import { DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE, deviceAuthority } from './device-authority.js';
import { mintUploadLink } from './upload-link.js';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Device scope is checked first; the workspace object then authorizes from its own metadata. Possession of a project
 * id is not authority. */
export async function requireRuntimeAccess(
  env: Env, userId: string, deviceId: string,
  input: z.infer<typeof RuntimeIdentitySchema>, capability: DeviceCapability,
) {
  const view = await deviceAuthority(env).current();
  if (!view) throw new Error(DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE);
  const device = view.device(deviceId, Date.now());
  if (!device || !device.capabilities.includes(capability)) throw new Error('Runtime authorization has expired or lacks permission');
  if (device.scope.kind === 'project' && device.scope.projectId !== input.projectId) throw new Error('Workspace is outside the device project scope');
  if (device.scope.kind === 'workspace' && device.scope.workspaceId !== input.workspaceId) throw new Error('Workspace is outside the device workspace scope');
  return { device, ...await requireWorkspaceAccess(env, userId, input, capability !== 'rpc.read') };
}

export function runtimeCloudProcedures(env: Env, userId: string, deviceId: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  // Every procedure answers a result; one holding an error is logged as failed.
  const observed = <A extends { input: object }, R extends { isErr(): boolean }>(operation: string, handler: (args: A) => Promise<R>) => (args: A) => observeRuntimeRequest(
    'browser', operation, 'workspaceId' in args.input && typeof args.input.workspaceId === 'string' ? args.input.workspaceId : null, () => handler(args), result => result.isErr());
  const snapshot = server.implement(runtimeSnapshotContract).handler(observed('runtime.snapshot', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.read');
      return ok(RuntimeSnapshotSchema.parse(await (await authority.runtimeSnapshot(input)).json()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'read cloud runtime', message: message(error) })); }
  }));
  const browserTrust = server.implement(runtimeBrowserTrustContract).handler(observed('runtime.browserTrust', async ({ errors }) => {
    try {
      const view = await deviceAuthority(env).current();
      if (!view) throw new Error(DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE);
      const device = view.device(deviceId, Date.now());
      if (!device || device.kind !== 'browser' || !deviceCanAdminister(device, 'account.admin')) throw new Error('Browser pairing requires a browser administrator');
      return ok(await env.ACCOUNT_STATE.getByName(userId).browserTrust());
    } catch (error) { return err(errors.OperationFailed({ operation: 'read browser trust root', message: message(error) })); }
  }));
  const draft = server.implement(runtimeDraftContract).handler(observed('runtime.draft', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeDraft(input, { deviceId }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'save workspace draft', message: message(error) })); }
  }));
  const submit = server.implement(runtimeSubmitContract).handler(observed('runtime.submit', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeSubmit(input, { deviceId }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'submit cloud conversation', message: message(error) })); }
  }));
  const cancel = server.implement(runtimeCancelContract).handler(observed('runtime.cancel', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeCancel(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'cancel cloud conversation', message: message(error) })); }
  }));
  const answer = server.implement(runtimeAnswerContract).handler(observed('runtime.answer', async ({ input, errors }) => {
    try {
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok(await authority.runtimeAnswer(input, { deviceId, canApprove: device.kind === 'browser' && deviceCanAdminister(device, 'account.admin') }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'answer cloud conversation', message: message(error) })); }
  }));
  const session = server.implement(runtimeSessionContract).handler(observed('runtime.session', async ({ input, errors }) => {
    try {
      const read = ['control', 'agentSetup', 'historyAnchorId', 'historyPage', 'transcriptPage', 'transcriptContent', 'usage'].includes(input.command.type);
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, read ? 'rpc.read' : 'session.prompt');
      if (['setWorkspacePhase', 'saveAgentDefinition', 'reloadSettings', 'instructionsChanged', 'inferenceChanged'].includes(input.command.type)
        && !deviceCanAdminister(device, 'account.admin')) throw new Error('This session command requires account administration');
      if (input.command.type === 'answerAsk' && device.kind !== 'browser') throw new Error('Human session decisions require the browser');
      return ok(RuntimeSessionResultSchema.parse(await (await authority.runtimeSession(input, { deviceId, canApprove: device.kind === 'browser' && deviceCanAdminister(device, 'account.admin') })).json()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'control cloud session', message: message(error) })); }
  }));
  const imageUpload = server.implement(runtimeImageUploadContract).handler(observed('runtime.imageUpload', async ({ input, errors }) => {
    try {
      await requireRuntimeAccess(env, userId, deviceId, input, 'session.prompt');
      return ok({ link: await mintUploadLink(env, { kind: 'image', workspaceId: input.workspaceId, sha256: input.sha256, size: input.size, mimeType: input.mimeType }) });
    } catch (error) { return err(errors.OperationFailed({ operation: 'begin an image upload', message: message(error) })); }
  }));
  const services = server.implement(runtimeServicesContract).handler(observed('runtime.services', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, input.command.op === 'list' || input.command.op === 'logs' ? 'rpc.read' : 'rpc.write');
      return ok(await authority.runtimeServices(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'control workspace services', message: message(error) })); }
  }));
  const sync = server.implement(runtimeSyncContract).handler(observed('runtime.sync', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeSync(input));
    } catch (error) { return err(errors.OperationFailed({ operation: `sync ${input.args.method}`, message: message(error) })); }
  }));
  const qa = server.implement(runtimeQaContract).handler(observed('runtime.qa', async ({ input, errors }) => {
    try {
      const { authority, device } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      if (input.action.kind === 'share' && (device.kind !== 'browser' || !deviceCanAdminister(device, 'account.admin'))) throw new Error('Sharing a QA report requires a browser administrator');
      return ok(await authority.runtimeQa(input, { deviceId, canApprove: input.action.kind !== 'share' || (device.kind === 'browser' && deviceCanAdminister(device, 'account.admin')) }));
    } catch (error) { return err(errors.OperationFailed({ operation: 'review runtime QA report', message: message(error) })); }
  }));
  const requestCacheAttachment = server.implement(runtimeCacheAttachmentRequestContract).handler(observed('runtime.attachment.cache.request', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeCacheAttachmentRequest(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'request cache attachment', message: message(error) })); }
  }));
  const detachAttachment = server.implement(runtimeAttachmentDetachRequestContract).handler(observed('runtime.attachment.detach', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.write');
      return ok(await authority.runtimeAttachmentDetachRequest(input));
    } catch (error) { return err(errors.OperationFailed({ operation: 'drain executor attachment', message: message(error) })); }
  }));
  const watch = server.implement(runtimeWatchContract).handler(observed('runtime.watch', async ({ input, errors }) => {
    try {
      const { authority } = await requireRuntimeAccess(env, userId, deviceId, input, 'rpc.read');
      return ok(RuntimeWatchEventsSchema.parse(await (await authority.runtimeEvents(input)).json()));
    } catch (error) { return err(errors.OperationFailed({ operation: 'read cloud runtime events', message: message(error) })); }
  }));
  return { snapshot, draft, submit, cancel, answer, browserTrust, session, imageUpload, services, sync, qa, attachment: { cache: { request: requestCacheAttachment }, detach: detachAttachment }, watch };
}
