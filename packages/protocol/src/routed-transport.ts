import { deserialize } from 'result-rpc';
import { batchFetchTransport, fetchTransport, type ClientTransport } from 'result-rpc/client';
import { ACCOUNT_CLOUD_RPC_PATHS, rpcCallTarget, spaceCloudRpcSpaceId, isSpaceCloudRpcPath } from './account-rpc.js';

/**
 * One client, every machine. Every call goes to the account endpoint, which
 * forwards machine work to the machine holding the space or session it names.
 * A signed batch cannot be split or rewritten, so separate batch queues keep
 * cloud authority work, runtime metadata, and each machine target apart.
 */
export interface RoutedTransportOptions {
  /** Account RPC URL; it serves account work and forwards machine work to the current holder. */
  homeUrl: string;
  /** Signed fetch shared by every queue. */
  fetch: typeof globalThis.fetch;
  maxItems?: number;
}

const MAX_PROCEDURE_TAG_LENGTH = 512;

function procedurePaths(envelope: unknown): string[] {
  if (!envelope || typeof envelope !== 'object') return [];
  const items: unknown[] = 'batch' in envelope && Array.isArray(envelope.batch) ? envelope.batch : [envelope];
  const paths = new Set<string>();
  for (const item of items) {
    if (item && typeof item === 'object' && 'path' in item && typeof item.path === 'string') paths.add(encodeURIComponent(item.path));
  }
  return [...paths];
}

function procedureTag(paths: readonly string[]): string {
  const all = paths.join(',');
  if (all.length <= MAX_PROCEDURE_TAG_LENGTH) return all;
  let tag = '';
  let kept = 0;
  for (const path of paths) {
    const next = kept ? `${tag},${path}` : path;
    if (next.length + `,${paths.length - kept - 1}-more`.length > MAX_PROCEDURE_TAG_LENGTH) break;
    tag = next;
    kept++;
  }
  return `${tag}${kept ? ',' : ''}${paths.length - kept}-more`;
}

/**
 * Names a request's procedures in its URL (`?p=space.view,session.control`) so
 * request logs identify the work. Wrap the fetch before signing: the signature
 * covers the tagged target, and servers otherwise ignore the query.
 */
export function tagRpcProcedures(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  const tagged = (input: Parameters<typeof globalThis.fetch>[0], init?: Parameters<typeof globalThis.fetch>[1]): Promise<Response> => {
    if (typeof input !== 'string' || typeof init?.body !== 'string') return fetch(input, init);
    const decoded = deserialize(init.body);
    const tag = decoded.ok ? procedureTag(procedurePaths(decoded.value)) : '';
    return fetch(tag ? `${input}${input.includes('?') ? '&' : '?'}p=${tag}` : input, init);
  };
  // Bun's fetch type carries `preconnect`; the wrapper is only ever called.
  return tagged as typeof globalThis.fetch;
}

export function createRoutedTransport(options: RoutedTransportOptions): ClientTransport {
  const fetch = tagRpcProcedures(options.fetch);
  const batch = () => batchFetchTransport({ url: options.homeUrl, fetch, maxItems: options.maxItems ?? 32 });
  const home = batch();
  const account = batch();
  // Repository provisioning and image startup can outlast ordinary queries.
  // Keep those calls out of their batch and timeout budget.
  const provisioning = fetchTransport({ url: options.homeUrl, fetch, timeoutMs: 300_000 });
  const inspectorContext = batch();
  // The account Worker forwards a batch whole to one holder, and lets the
  // account authority choose cloud versus the live machine for workspace reads
  // before any provider proxy can wake a stopped machine. Never mix targets.
  const targets = new Map<string, ClientTransport>();
  const queue = (key: string): ClientTransport => {
    let transport = targets.get(key);
    if (!transport) { transport = batch(); targets.set(key, transport); }
    return transport;
  };

  const resolve = (path: string, input: unknown): ClientTransport => {
    if (path === 'project.create' || path === 'machine.createSandbox' ||
        path === 'machine.resume' || path === 'machine.sleep' || path === 'machine.destroy' ||
        (path.startsWith('machine.image.') && path !== 'machine.image.list' && path !== 'machine.image.events')) return provisioning;
    if (path === 'inspector.view' || path === 'inspector.transcript' || path === 'inspector.transcriptPage' || path === 'inspector.transcriptContent' || path === 'inspector.availability') return inspectorContext;
    if (Object.hasOwn(ACCOUNT_CLOUD_RPC_PATHS, path)) return account;
    if (isSpaceCloudRpcPath(path)) return queue(`inspector:${spaceCloudRpcSpaceId(input) ?? ''}`);
    const target = rpcCallTarget(path, input);
    if (!target) return home;
    return queue(target.kind === 'space' ? `space:${target.spaceId}` : `session:${target.sessionId}`);
  };

  return {
    request: (envelope, requestOptions) => resolve(envelope.path, envelope.input).request(envelope, requestOptions),
    stream: async (envelope, requestOptions) => {
      const transport = resolve(envelope.path, envelope.input);
      if (!transport.stream) throw new TypeError('Transport does not support streams');
      return transport.stream(envelope, requestOptions);
    },
  };
}
