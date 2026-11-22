import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import { DEVICE_SOCKET_PROTOCOL, scopeAllowsWorkspace, socketProtocolProof } from '@gitspace/protocol';
import { GHOST_QUESTION_MAX, GhostQuerySchema, RuntimeIdentitySchema, type GhostAskResult } from '@gitspace/protocol-runtime';
import { accountAccessResponse, activeAccount } from './account-access.js';
import { DEVICE_AUTHORITY_UNAVAILABLE, withDeviceAuthority } from './device-authority.js';
import { requireWorkspaceAccess } from './runtime-access.js';
import type { AgentGhost, GhostSession } from './ghost-session.js';

/** The request the account worker forwards to a new ghost's object: who opened it and what it reads (the session, up to
 * entry `until`), already authorized. */
const GHOST_SPEC_HEADER = 'x-gitspace-ghost';
const entry = z.number().int().nonnegative();
export const GhostSpecSchema = z.strictObject({
  ghostId: z.uuid(), projectId: z.string().min(1), workspaceId: z.string().min(1), conversationId: z.string().min(1).nullable(),
  until: entry.nullable(), deviceId: z.string().min(1), archived: z.boolean(),
});
export type GhostSpec = z.infer<typeof GhostSpecSchema>;

const id = z.string().min(1);
/** The agent conversation that asks a ghost (`ghost_ask`): only it may ask that ghost again. */
export const GhostAskerSchema = z.strictObject({ projectId: id, workspaceId: id, conversationId: id });
export type GhostAsker = z.infer<typeof GhostAskerSchema>;
/**
 * One `ghost_ask` question, as the asking workspace's object sends it to the ghost's, already authorized: the session is
 * a workspace of the asker's project. `open` starts the ghost (the session it reads, up to entry `until`, that
 * workspace's name, whether it is archived, and the asking conversation's inference profile); without it the question
 * is a follow-up.
 */
export const GhostAgentRequestSchema = z.strictObject({
  ghostId: z.uuid(), asker: GhostAskerSchema, question: z.string().trim().min(1).max(GHOST_QUESTION_MAX),
  open: z.strictObject({ workspaceId: id, workspace: z.string(), conversationId: id.nullable(), until: entry.nullable(), archived: z.boolean(), profileId: id }).nullable(),
});
export type GhostAgentRequest = z.infer<typeof GhostAgentRequestSchema>;
/** How a `ghost_ask` question ended: answered, refused because no ghost of this asker lives here, or failed (with when
 * the ghost fades, when it still lives). */
export type GhostAgentReply =
  | { status: 'answered'; result: GhostAskResult }
  | { status: 'faded' }
  | { status: 'failed'; message: string; expiresAt: string | null };

function fail(status: number, code: string, message: string) { return Response.json({ status: 'error', error: { code, message } }, { status, headers: { 'cache-control': 'private, no-store' } }); }

/**
 * `GET GHOST_PATH?projectId&workspaceId[&conversationId][&until]`, upgraded, from the account's own origin, signed in
 * `Sec-WebSocket-Protocol` as the dictation socket is. A ghost reads what its asker could open and spends inference, so
 * the device must be a browser with `rpc.read` and `session.prompt` that reaches the workspace; archived workspaces
 * pass (reads only). Each socket is a new ghost in its own object.
 */
export async function serveGhost(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== 'GET') return fail(405, 'METHOD_NOT_ALLOWED', 'Open a ghost with GET');
  if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(426, 'UPGRADE_REQUIRED', 'Expected a WebSocket');
  if (request.headers.get('origin') !== new URL(env.ACCOUNT_URL).origin) return fail(403, 'ORIGIN_REJECTED', 'Account origin required');
  const query = GhostQuerySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!query.success) return fail(400, 'GHOST_INVALID', 'A ghost names its project and workspace');
  const offered = socketProtocolProof(request.headers.get('sec-websocket-protocol'), DEVICE_SOCKET_PROTOCOL);
  if (!offered) return fail(400, 'GHOST_INVALID', 'Ghost authorization is missing');
  const auth = await withDeviceAuthority(env, (view, now) => view.authorizeRequest({ header: offered.proof, method: 'GET', target: `${url.pathname}${url.search}`, body: new Uint8Array(), capabilities: ['rpc.read', 'session.prompt'], browserOnly: true, accountScope: false }, now));
  if (auth.status === 'error') return fail(auth.error.code === DEVICE_AUTHORITY_UNAVAILABLE ? 503 : auth.error.code === 'RPC_FORBIDDEN' ? 403 : 401, auth.error.code, auth.error.message);
  const { device } = auth.value, { projectId, workspaceId, conversationId, until } = query.data;
  if (!scopeAllowsWorkspace(device.scope, projectId, workspaceId)) return fail(403, 'RPC_FORBIDDEN', 'Workspace is outside the device scope');
  const denied = accountAccessResponse(await activeAccount(env, env.ACCOUNT_ID));
  if (denied) return denied;
  let archived: boolean;
  try {
    archived = (await requireWorkspaceAccess(env, env.ACCOUNT_ID, RuntimeIdentitySchema.parse({ projectId, workspaceId }), false)).workspace.lifecycle !== 'active';
  } catch (error) { return fail(404, 'WORKSPACE_UNAVAILABLE', error instanceof Error ? error.message : String(error)); }
  const spec: GhostSpec = { ghostId: crypto.randomUUID(), projectId, workspaceId, conversationId: conversationId ?? null, until: until ?? null, deviceId: device.deviceId, archived };
  const opened = await env.GHOSTS.getByName(`${env.ACCOUNT_ID}:ghost:${spec.ghostId}`).fetch('https://ghost.internal/open', { headers: { upgrade: 'websocket', [GHOST_SPEC_HEADER]: JSON.stringify(spec) } });
  if (!opened.webSocket) return opened;
  return new Response(null, { status: 101, webSocket: opened.webSocket, headers: { 'sec-websocket-protocol': offered.protocol } });
}

/**
 * One ghost (`${ACCOUNT_ID}:ghost:<id>`): its conversation lives in this object's memory and nowhere else. It never
 * writes storage; its one alarm is the deadline. A person's ghost lives on one socket, and the alarm, `close` or the
 * socket closing ends it; an agent's ghost answers `ask` calls from the conversation that started it until the alarm.
 * An object that restarts has lost its ghost, which is what fading means anyway. The model loop and its read tools load
 * on the first socket or question, so the account worker's startup carries none of it.
 */
export class GhostDO extends DurableObject<Env> {
  #session: GhostSession | null = null;
  #agent: AgentGhost | null = null;

  async fetch(request: Request): Promise<Response> {
    if (this.#session || this.#agent) return fail(409, 'GHOST_OPEN', 'This ghost is already open');
    const spec = GhostSpecSchema.safeParse(JSON.parse(request.headers.get(GHOST_SPEC_HEADER) ?? 'null'));
    if (!spec.success || request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return fail(400, 'GHOST_INVALID', 'Ghosts open from the account worker');
    const [client, server] = Object.values(new WebSocketPair());
    server.accept();
    // Loaded here, not at startup: the account worker's startup is near Cloudflare's limit (see the class comment).
    const { openGhost } = await import('./ghost-session.js');
    const session = openGhost({ ctx: this.ctx, env: this.env, spec: spec.data, socket: server, ended: () => { if (this.#session === session) this.#session = null; } });
    this.#session = session;
    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * One question of an agent's ghost (`ghost_ask`, docs/GHOSTS-DESIGN.md §5.1). With `open` it starts the ghost, which
   * then answers only the conversation that started it; a follow-up finding no such ghost here (it faded, its object
   * restarted, or another conversation asks) is answered `faded`.
   */
  async ask(raw: GhostAgentRequest): Promise<GhostAgentReply> {
    const request = GhostAgentRequestSchema.parse(raw);
    // Loaded here, not at startup, as in `fetch`.
    const { askAgentGhost, openAgentGhost } = await import('./ghost-session.js');
    if (request.open) {
      if (this.#session || this.#agent) return { status: 'failed', message: 'This ghost is already open', expiresAt: null };
      let opened: AgentGhost | null = null;
      try {
        opened = await openAgentGhost({ ctx: this.ctx, env: this.env, ghostId: request.ghostId, asker: request.asker, open: request.open, ended: () => { if (this.#agent === opened) this.#agent = null; } });
      } catch (error) { return { status: 'failed', message: error instanceof Error ? error.message : String(error), expiresAt: null }; }
      this.#agent = opened;
    }
    const agent = this.#agent;
    const { asker } = request;
    if (!agent || agent.asker.projectId !== asker.projectId || agent.asker.workspaceId !== asker.workspaceId || agent.asker.conversationId !== asker.conversationId) return { status: 'faded' };
    return askAgentGhost(agent, request.question);
  }

  /** The deadline: the ghost fades. */
  async alarm(): Promise<void> { this.#session?.fade(); this.#agent?.session.fade(); }
}
