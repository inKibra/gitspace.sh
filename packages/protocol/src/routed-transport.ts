import { batchFetchTransport, createBrowserClient, fetchTransport, type ClientTransport } from 'result-rpc/client';
import { gitspaceContract, type SpacePlacementView } from './rpc-contract.js';
import { ACCOUNT_CLOUD_RPC_PATHS, ACCOUNT_RUNTIME_RPC_PATHS } from './account-rpc.js';

/**
 * One client, every machine. Calls naming a space go to the machine that
 * holds it; calls that name a session are located first. Account operations go
 * to the home endpoint, which may be an account Worker or a machine. Separate
 * batch queues keep cloud authority work independent of machine availability
 * without rewriting a signed request.
 */
export interface RoutedTransportOptions {
  /** RPC URL of the machine the caller can always reach; the routing table is read from it. */
  homeUrl: string;
  /** Signed fetch shared by every destination. */
  fetch: typeof globalThis.fetch;
  maxItems?: number;
  placementsTtlMs?: number;
}

interface RouteTable {
  at: number;
  homeMachineId: string;
  bySpace: Record<string, SpacePlacementView>;
}

export interface RoutedTransport extends ClientTransport {
  /** Current placements as last read; refreshes on demand. */
  placements(): Promise<RouteTable['bySpace']>;
  /** Forget cached routes; the next call re-reads the table. */
  invalidate(): void;
}

const PLACEMENTS_TTL_MS = 5_000;

function spaceIdOf(path: string, input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const record = input as Record<string, unknown>;
  const candidate = [record.spaceId, record.workspaceId].find((value): value is string => typeof value === 'string');
  if (candidate) return candidate;
  if (path === 'bootstrap' || path === 'workspace.create' || path === 'session.createProject' || path === 'events') {
    return typeof record.projectId === 'string' ? record.projectId : null;
  }
  return null;
}

function sessionIdOf(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const value = (input as Record<string, unknown>).sessionId;
  return typeof value === 'string' ? value : null;
}

export function createRoutedTransport(options: RoutedTransportOptions): RoutedTransport {
  const transports: Record<string, ClientTransport> = {};
  const transportFor = (url: string): ClientTransport => {
    transports[url] ??= batchFetchTransport({ url, fetch: options.fetch, maxItems: options.maxItems ?? 32 });
    return transports[url];
  };
  const home = transportFor(options.homeUrl);
  const account = batchFetchTransport({ url: options.homeUrl, fetch: options.fetch, maxItems: options.maxItems ?? 32 });
  // Initializing and uploading a Git repository can outlast ordinary queries.
  // Keep creation's longer deadline out of their batch and timeout budget.
  const projectCreation = fetchTransport({ url: options.homeUrl, fetch: options.fetch, timeoutMs: 300_000 });
  // Runtime schemas/provider capabilities come from a machine when online,
  // with canonical cloud views when offline. Keep that choice independently signed.
  const runtimeMetadata = batchFetchTransport({ url: options.homeUrl, fetch: options.fetch, maxItems: options.maxItems ?? 32 });
  const homeClient = createBrowserClient({ contract: gitspaceContract, transport: home });
  const sessionSpaces: Record<string, string> = {};
  let table: RouteTable | null = null;
  let loading: Promise<RouteTable | null> | null = null;

  const readTable = (): Promise<RouteTable | null> => {
    if (table && Date.now() - table.at < (options.placementsTtlMs ?? PLACEMENTS_TTL_MS)) return Promise.resolve(table);
    loading ??= (async () => {
      try {
        const result = await homeClient.placements({});
        if (result.status !== 'ok') return table;
        const bySpace: Record<string, SpacePlacementView> = {};
        for (const space of result.value.spaces) bySpace[space.spaceId] = space;
        table = { at: Date.now(), homeMachineId: result.value.machineId, bySpace };
        return table;
      } catch {
        return table;
      } finally {
        loading = null;
      }
    })();
    return loading;
  };

  const urlForSpace = async (spaceId: string): Promise<string> => {
    const current = await readTable();
    const placement = current?.bySpace[spaceId];
    if (!current || !placement) return options.homeUrl;
    // The home machine's catalog endpoint may be loopback or a relay hop; the
    // URL the caller already reaches it on is always right for it.
    if (placement.holderId === current.homeMachineId || !placement.endpoint) return options.homeUrl;
    return placement.endpoint;
  };

  const urlForSession = async (sessionId: string): Promise<string> => {
    const known = sessionSpaces[sessionId];
    if (known) return urlForSpace(known);
    try {
      const located = await homeClient.session.locate({ sessionId });
      if (located.status === 'ok' && located.value) {
        sessionSpaces[sessionId] = located.value.spaceId;
        return urlForSpace(located.value.spaceId);
      }
    } catch { /* fall through to home */ }
    return options.homeUrl;
  };

  const resolve = async (path: string, input: unknown): Promise<ClientTransport> => {
    if (path === 'project.create') return projectCreation;
    if (Object.hasOwn(ACCOUNT_RUNTIME_RPC_PATHS, path)) return runtimeMetadata;
    if (Object.hasOwn(ACCOUNT_CLOUD_RPC_PATHS, path)) return account;
    // Routing reads never recurse into routing.
    if (path === 'placements' || path === 'session.locate') return home;
    const spaceId = spaceIdOf(path, input);
    if (spaceId) return transportFor(await urlForSpace(spaceId));
    const sessionId = sessionIdOf(input);
    if (sessionId) return transportFor(await urlForSession(sessionId));
    return home;
  };

  return {
    request: async (envelope, requestOptions) => (await resolve(envelope.path, envelope.input)).request(envelope, requestOptions),
    stream: async (envelope, requestOptions) => {
      const transport = await resolve(envelope.path, envelope.input);
      if (!transport.stream) throw new TypeError('Transport does not support streams');
      return transport.stream(envelope, requestOptions);
    },
    placements: async () => (await readTable())?.bySpace ?? {},
    invalidate: () => { table = null; },
  };
}
