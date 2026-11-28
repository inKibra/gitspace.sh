import { contractDigest, deserialize } from 'result-rpc';
import { batchFetchTransport, fetchTransport, type ClientTransport } from 'result-rpc/client';
import { accountRpcAuthority, rpcCallTarget } from './account-rpc.js';
import { gitspaceContract } from './rpc-contract.js';

/**
 * Every call goes to the account endpoint, which serves cloud work or forwards
 * machine work only to the named machine. Signed batches cannot be split or
 * rewritten, so cloud authority work and each explicit machine target stay apart.
 */
export interface RoutedTransportOptions {
  /** Account RPC URL; serves cloud work and forwards explicitly named machine work. */
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
 * Names a request's procedures in its URL (`?p=space.view,runtime.snapshot`) so
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

/**
 * The budget of a call that outlasts an ordinary one, in ms; null for an ordinary call. Repository provisioning, image
 * startup, waking a paused cache for an environment run and a machine's sync capture get 300 s; a narration clip 120 s.
 * The web app and the MCP server both read it, so a call never has a shorter budget through one than the other.
 */
export function longRpcTimeoutMs(path: string): number | null {
  if (path === 'project.create' || path === 'workspace.create' || path === 'workspace.retryCreate' || path === 'machine.createSandbox' ||
      path === 'machine.resume' || path === 'machine.sleep' || path === 'machine.destroy' || path === 'environment.runChecks' || path === 'environment.runPhase' || path === 'runtime.sync' ||
      (path.startsWith('machine.image.') && path !== 'machine.image.list')) return 300_000;
  if (path === 'speech.clip') return 120_000;
  return null;
}

export function createRoutedTransport(options: RoutedTransportOptions): ClientTransport {
  const fetch = tagRpcProcedures(options.fetch);
  const batch = () => batchFetchTransport({ url: options.homeUrl, fetch, maxItems: options.maxItems ?? 32 });
  const home = batch();
  const account = batch();
  // Calls with a long budget (`longRpcTimeoutMs`) go alone, out of a batch and its budget.
  const provisioning = fetchTransport({ url: options.homeUrl, fetch, timeoutMs: 300_000 });
  // A narration clip takes seconds to make, and a walkthrough asks for its next ones while one plays: each goes alone,
  // so a clip answers when it is made, not when the slowest clip asked with it is, and none holds back other calls.
  const speech = fetchTransport({ url: options.homeUrl, fetch, timeoutMs: 120_000 });
  const inspectorContext = batch();
  // A batch answers when its slowest call does. The account-wide states every page reads on load wait on the account
  // vault, and a workspace's runtime reads wait on its runtime opening: each gets its own batch, so neither holds
  // back the other or the account's quick reads.
  const accountState = batch();
  const runtimes = new Map<string, ClientTransport>();
  // A signed machine batch goes whole to one explicit machine and workspace. A machine runs its own release, which
  // reloading this page cannot change: its replies carry this page's contract, so a machine on another release never
  // reports skew (the "GitSpace was updated" prompt). A reply this page cannot read still fails to decode.
  const contract = contractDigest(gitspaceContract);
  const targets = new Map<string, ClientTransport>();
  const queue = (key: string): ClientTransport => {
    let transport = targets.get(key);
    if (!transport) {
      const machine = batch();
      const stream = machine.stream;
      transport = {
        request: async (envelope, requestOptions) => {
          const outcome = await machine.request(envelope, requestOptions);
          return outcome.ok ? { ok: true, response: { ...outcome.response, contract: outcome.response.contract === null ? null : contract } } : outcome;
        },
        ...(stream ? {
          stream: async (envelope, requestOptions) => {
            const outcome = await stream(envelope, requestOptions);
            return outcome.ok ? { ok: true, response: { ...outcome.response, contract: outcome.response.contract === null ? null : contract } } : outcome;
          },
        } : {}),
      };
      targets.set(key, transport);
    }
    return transport;
  };

  const resolve = (path: string, input: unknown): ClientTransport => {
    if (path === 'speech.clip') return speech;
    if (longRpcTimeoutMs(path) !== null) return provisioning;
    if (path === 'inspector.view' || path === 'inspector.transcript' || path === 'inspector.transcriptPage' || path === 'inspector.transcriptContent' || path === 'inspector.availability') return inspectorContext;
    if (path === 'settings.state' || path === 'inference.list' || path === 'machine.image.list') return accountState;
    if (path === 'runtime.watch' || path === 'runtime.session') {
      const workspace = input !== null && typeof input === 'object' && 'workspaceId' in input && typeof input.workspaceId === 'string' ? input.workspaceId : '';
      let runtime = runtimes.get(workspace);
      if (!runtime) { runtime = batch(); runtimes.set(workspace, runtime); }
      return runtime;
    }
    if (accountRpcAuthority(path) === 'cloud') return account;
    const target = rpcCallTarget(path, input);
    if (!target) return home;
    if (target.kind === 'terminal') return queue(`terminal:${target.spaceId}:${target.machineId}`);
    return queue(`machine:${target.machineId}`);
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
