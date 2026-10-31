import type { GitSpaceRpcContext, VerifiedDevice } from '@gitspace/protocol';
import {
  githubAppRotateKeyContract, githubAppStartContract, githubInstallationConfirmContract, githubInstallationUninstallContract, githubInstallStartContract,
  githubProjectAccessContract, githubRemovedClearContract, githubRequestCancelContract, githubRequestRecordContract, githubStateContract, githubUninstalledDismissContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The tenant's GitHub App; creating, installing, keeping, uninstalling and rotating its key change what GitHub lets
 * GitSpace do, so they require account administration. */
export function githubCloudProcedures(env: Env, requireAdministration: () => Promise<VerifiedDevice>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const github = env.GITHUB_APP.getByName(env.ACCOUNT_ID);
  const state = server.implement(githubStateContract).handler(async ({ errors }) => {
    try { return ok(await github.state()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'read GitHub App', message: message(error) })); }
  });
  const startApp = server.implement(githubAppStartContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.startApp(input.owner)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'create GitHub App', message: message(error) })); }
  });
  const rotateKey = server.implement(githubAppRotateKeyContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.rotateKey(input.privateKey)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'replace GitHub App key', message: message(error) })); }
  });
  const startInstall = server.implement(githubInstallStartContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.startInstall(input.projectId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'install GitHub App', message: message(error) })); }
  });
  const cancelRequest = server.implement(githubRequestCancelContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.cancelRequest(input.requestId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'cancel GitHub install request', message: message(error) })); }
  });
  const recordRequest = server.implement(githubRequestRecordContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.recordStartedRequest(input.projectId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'record GitHub install request', message: message(error) })); }
  });
  const confirm = server.implement(githubInstallationConfirmContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.confirmInstallation(input.installationId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'keep GitHub installation', message: message(error) })); }
  });
  const uninstall = server.implement(githubInstallationUninstallContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.uninstall(input.installationId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'uninstall GitHub App', message: message(error) })); }
  });
  const dismissUninstalled = server.implement(githubUninstalledDismissContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await github.dismissUninstalled(input.installationId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'dismiss uninstalled GitHub installation', message: message(error) })); }
  });
  const clearRemoved = server.implement(githubRemovedClearContract).handler(async ({ errors }) => {
    try { await requireAdministration(); return ok(await github.clearRemoved()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'clear removed GitHub installations', message: message(error) })); }
  });
  const projectAccess = server.implement(githubProjectAccessContract).handler(async ({ input, errors }) => {
    try { return ok(await github.projectAccess(input.projectId)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'read project repository access', message: message(error) })); }
  });
  return {
    state, app: { start: startApp, rotateKey }, install: { start: startInstall }, request: { cancel: cancelRequest, record: recordRequest },
    installation: { confirm, uninstall }, uninstalled: { dismiss: dismissUninstalled }, removed: { clear: clearRemoved }, projectAccess,
  };
}
