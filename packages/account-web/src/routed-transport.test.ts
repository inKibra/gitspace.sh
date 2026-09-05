import { createRoutedTransport } from '@gitspace/protocol/routed-transport';
import { deserialize } from 'result-rpc';
import { afterEach, expect, it, vi } from 'vitest';

afterEach(() => vi.useRealTimers());

it('lets project creation finish after ordinary machine queries time out', async () => {
  vi.useFakeTimers();
  let finishCreation: ((response: Response) => void) | undefined;
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const decoded = deserialize(await request.text());
    if (!decoded.ok) throw new Error('Invalid request envelope');
    const envelope = decoded.value as { path?: string };
    return new Promise<Response>((resolve, reject) => {
      if (envelope.path === 'project.create') finishCreation = resolve;
      request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true });
    });
  }) as typeof fetch;
  const transport = createRoutedTransport({ homeUrl: 'https://account.test/rpc', fetch: fetcher });
  let creationSettled = false;
  const creation = transport.request({ v: 1, path: 'project.create', input: { name: 'slow-repository', baseBranch: 'main', repositoryUrl: null } })
    .then((outcome) => { creationSettled = true; return outcome; });
  const query = transport.request({ v: 1, path: 'placements', input: {} });

  await vi.advanceTimersByTimeAsync(31_000);
  expect(await query).toMatchObject({ ok: false, reason: 'timeout' });
  expect(creationSettled).toBe(false);
  if (!finishCreation) throw new Error('Project creation did not reach the server');
  finishCreation(new Response('completed'));
  expect((await creation).ok).toBe(true);
});
