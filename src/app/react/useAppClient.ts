import { useContext, useMemo } from 'react';
import { createAppClient, type AppClient, type AppClientContext } from '../client/index.js';
import { AppClientReactContext } from './AppClientProvider.js';

function isAppClient(value: AppClient | AppClientContext | null | undefined): value is AppClient {
  return typeof value === 'object' && value !== null && 'agentSessions' in value;
}

export function useAppClient(clientOrContext?: AppClient | AppClientContext | null): AppClient {
  const providedClient = useContext(AppClientReactContext);

  return useMemo(() => {
    if (isAppClient(clientOrContext)) {
      return clientOrContext;
    }

    if (clientOrContext) {
      return createAppClient(clientOrContext);
    }

    if (providedClient) {
      return providedClient;
    }

    throw new Error('useAppClient requires an AppClientProvider or explicit client/context');
  }, [clientOrContext, providedClient]);
}
