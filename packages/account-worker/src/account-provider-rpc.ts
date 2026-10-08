import { type GitSpaceRpcContext, type VerifiedDevice } from '@gitspace/protocol';
import {
  listProvidersContract, setProviderApiKeyContract, logoutProviderContract,
  startProviderLoginContract, providerLoginEventsContract, respondProviderLoginContract,
  cancelProviderLoginContract, providerUsageContract, listAvailableModelsContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Provider management never routes through a machine or exports refresh credentials. */
export function providerCloudProcedures(env: Env, userId: string, requireAdministration: () => Promise<VerifiedDevice>) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const vault = env.CREDENTIALS.getByName(userId);
  const list = server.implement(listProvidersContract).handler(async ({ input, errors }) => {
    try { return ok({ providers: await vault.cloudProviders(input.profileId) }); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list providers', message: message(error) })); }
  });
  const set = server.implement(setProviderApiKeyContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      await vault.cloudSetApiKey(input);
      const provider = (await vault.cloudProviders(input.profileId)).find(entry => entry.id === input.providerId);
      if (!provider) throw new Error('Provider is unavailable');
      return ok({ provider });
    } catch (error) { return err(errors.OperationFailed({ operation: 'set provider API key', message: message(error) })); }
  });
  const logout = server.implement(logoutProviderContract).handler(async ({ input, errors }) => {
    try {
      await requireAdministration();
      const selected = (await vault.cloudProviders(input.profileId)).find(entry => entry.id === input.providerId);
      if (!selected) throw new Error('Provider is unavailable');
      await vault.logoutBrowserCredentials(input.profileId, selected.credentialProvider, input.credentialId);
      const provider = (await vault.cloudProviders(input.profileId)).find(entry => entry.id === input.providerId);
      if (!provider) throw new Error('Provider is unavailable');
      return ok({ provider });
    } catch (error) { return err(errors.OperationFailed({ operation: 'sign out provider', message: message(error) })); }
  });
  const start = server.implement(startProviderLoginContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); return ok(await vault.cloudLoginStart(input)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'start provider login', message: message(error) })); }
  });
  const respond = server.implement(respondProviderLoginContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); await vault.cloudLoginRespond(input); return ok({}); }
    catch (error) { return err(errors.OperationFailed({ operation: 'respond to provider login', message: message(error) })); }
  });
  const cancel = server.implement(cancelProviderLoginContract).handler(async ({ input, errors }) => {
    try { await requireAdministration(); await vault.cloudLoginCancel(input); return ok({}); }
    catch (error) { return err(errors.OperationFailed({ operation: 'cancel provider login', message: message(error) })); }
  });
  const events = server.implement(providerLoginEventsContract).stream(async function* ({ input, signal, errors }) {
    let after = 0;
    try {
      while (!signal.aborted) {
        await requireAdministration();
        const page = await vault.cloudLoginEvents({ ...input, after });
        await requireAdministration();
        signal.throwIfAborted();
        for (const event of page.events) {
          yield ok(event);
          after++;
        }
        if (page.done) return;
        await scheduler.wait(1000, { signal });
      }
    } catch (error) {
      if (!signal.aborted) yield err(errors.OperationFailed({ operation: 'watch provider login', message: message(error) }));
    }
  });
  const usage = server.implement(providerUsageContract).handler(async ({ input, errors }) => {
    try { return ok(await vault.cloudUsage(input.profileId, input.providerId, input.refresh)); }
    catch (error) { return err(errors.OperationFailed({ operation: 'read provider usage', message: message(error) })); }
  });
  const models = server.implement(listAvailableModelsContract).handler(async ({ input, errors }) => {
    try { return ok({ models: await vault.cloudModels(input.profileId) }); }
    catch (error) { return err(errors.OperationFailed({ operation: 'list available models', message: message(error) })); }
  });
  return { list, apiKey: { set }, logout, login: { start, events, respond, cancel }, usage, models };
}
