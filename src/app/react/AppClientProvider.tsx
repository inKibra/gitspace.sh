import { createContext, useMemo, type ReactNode } from 'react';
import { createAppClient, type AppClient, type AppClientContext } from '../client/index.js';

export const AppClientReactContext = createContext<AppClient | null>(null);

export interface AppClientProviderProps {
  client?: AppClient;
  context?: AppClientContext;
  children: ReactNode;
}

export function AppClientProvider({ client, context, children }: AppClientProviderProps) {
  const providedClient = useMemo(() => {
    if (client) {
      return client;
    }

    if (context) {
      return createAppClient(context);
    }

    throw new Error('AppClientProvider requires either a client or context');
  }, [client, context]);

  return (
    <AppClientReactContext.Provider value={providedClient}>
      {children}
    </AppClientReactContext.Provider>
  );
}
