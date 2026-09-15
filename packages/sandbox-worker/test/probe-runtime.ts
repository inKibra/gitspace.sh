import { gitspaceContract } from '@gitspace/protocol';
import { createBrowserClient, fetchTransport } from 'result-rpc/client';
const url = process.argv[2];
const userId = process.argv[3];
const sharedSecret = process.argv[4];
if (!url) throw new Error('RPC URL is required');
const authenticatedFetch: typeof fetch = userId
  ? Object.assign(
      (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const headers = new Headers(init?.headers);
        headers.set('x-gitspace-user-id', userId);
        if (sharedSecret) headers.set('MF-Proxy-Shared-Secret', sharedSecret);
        return fetch(input, { ...init, headers });
      },
      { preconnect: fetch.preconnect },
    )
  : fetch;
const client = createBrowserClient({
  contract: gitspaceContract,
  transport: fetchTransport({ url, fetch: authenticatedFetch }),
});
const result = await client.machines({});
if (result.status === 'error') throw result.error;
console.log(JSON.stringify(result.value));
