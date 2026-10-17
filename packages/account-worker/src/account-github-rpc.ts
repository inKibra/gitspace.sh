import type { GitSpaceRpcContext, VerifiedDevice } from '@gitspace/protocol';
import { githubAppRotateKeyContract, githubAppStartContract, githubInstallStartContract, githubStateContract } from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** The tenant's GitHub App; creating, installing and rotating its key change what GitHub lets GitSpace do, so they
 * require account administration. */
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
  const startInstall = server.implement(githubInstallStartContract).handler(async ({ errors }) => {
    try { await requireAdministration(); return ok(await github.startInstall()); }
    catch (error) { return err(errors.OperationFailed({ operation: 'install GitHub App', message: message(error) })); }
  });
  return { state, app: { start: startApp, rotateKey }, install: { start: startInstall } };
}
