import accountWorker from '../packages/account-worker/src/index';
import { InspectorCloudArtifacts, readInspectorContext, readSavedInspectorTranscriptPage, readSavedInspectorTranscriptContent } from '../packages/account-worker/src/account-inspector-data';
import { createCloudWorkspace } from '../packages/account-worker/src/cloud-workspace-lifecycle';
import { transcriptPageRequestSchema, transcriptContentRequestSchema } from '../packages/blocks/src/index.js';
import { WorkspacePhaseSchema } from '../packages/protocol-workspace/src/index.js';
import { z } from 'zod';

export * from '../packages/account-worker/src/index';

// Private, local-only fixture entrypoint. Production Wrangler never imports this file.
const methods: Record<string, readonly string[]> = {
  CREDENTIALS: ['bootstrap', 'registerDevice', 'ensureInference', 'updateInferenceProfile', 'createInferenceProfile', 'assignInferenceProfile', 'cloudSetApiKey', 'cloudCredentialAccounts'],
  USER_SETTINGS: ['get', 'setHandle', 'snapshot'],
  USER_PROJECTS: ['put', 'list'],
  PROJECT_AUTHORITY: ['bootstrap', 'ensureGitSpaceProject', 'getProject', 'setProjectLifecycle', 'listWorkspaces', 'putWorkspace', 'getWorkspace', 'putCanonicalSession', 'putArtifactScope', 'getArtifactScope', 'listCanonicalSessions'],
  SPACE_AUTHORITY: ['bootstrap', 'get', 'beginClose', 'abortClose', 'commitClosed', 'beginOpen', 'failOpen', 'hasCloudRuntime', 'runtimeSnapshot', 'runtimeCodeCheckpoint', 'runtimeRepositoryCheckpoint', 'runtimeSession', 'runtimeSubmit', 'legacyMigrationStatus'],
};

export default {
  async fetch(request: Request, env: Env & { REHEARSAL_ONLY: string; REHEARSAL_TOKEN: string }): Promise<Response> {
    if (env.REHEARSAL_ONLY !== 'local-no-production' || !env.REHEARSAL_TOKEN) throw new Error('Rehearsal entrypoint requires isolated bindings');
    const path = new URL(request.url).pathname;
    if (!path.startsWith('/__rehearsal/')) return accountWorker.fetch(request, env);
    if (request.method !== 'POST' || request.headers.get('authorization') !== `Bearer ${env.REHEARSAL_TOKEN}`) return new Response(null, { status: 403 });
    const input = z.record(z.string(), z.unknown()).parse(await request.json());
    if (path === '/__rehearsal/git-transport') {
      z.object({}).strict().parse(input);
      return Response.json({ value: await env.ARTIFACTS.list({ limit: 1 }) });
    }
    if (path === '/__rehearsal/rpc') {
      const { binding, name, method, args } = input;
      if (typeof binding !== 'string' || typeof name !== 'string' || typeof method !== 'string' || !Array.isArray(args)
        || !methods[binding]?.includes(method) || (name !== env.ACCOUNT_ID && !name.startsWith(`${env.ACCOUNT_ID}:`))) return new Response(null, { status: 400 });
      const namespace = (env as unknown as Record<string, DurableObjectNamespace>)[binding]!;
      const owner = namespace.getByName(name) as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const value = await owner[method]!(...args);
      return Response.json({ value: value instanceof Response ? await value.json() : value ?? null });
    }
    if (path === '/__rehearsal/create-workspace') {
      const source = z.object({ projectId: z.string(), name: z.string(), branch: z.string(), phase: WorkspacePhaseSchema.optional(), sourceKind: z.enum(['base', 'workspace']), sourceRef: z.string() }).strict().parse(input);
      return Response.json({ value: await createCloudWorkspace(env, env.ACCOUNT_ID, source) });
    }
    if (path === '/__rehearsal/export') {
      const identity = z.object({ projectId: z.string(), workspaceId: z.string(), conversationId: z.string() }).parse(input);
      return env.SPACE_AUTHORITY.getByName(`${env.ACCOUNT_ID}:${identity.workspaceId}`).runtimeTranscript(identity, 'ndjson');
    }
    if (path === '/__rehearsal/share') {
      const value = z.object({ projectId: z.string(), workspaceId: z.string(), url: z.string(), hash: z.string() }).parse(input);
      const source = await readInspectorContext(env, env.ACCOUNT_ID, value.workspaceId, value.projectId);
      const artifacts = new InspectorCloudArtifacts(env, env.ACCOUNT_ID, source);
      return Response.json({ value: await artifacts.createShare(value.url, value.hash, new Date(Date.now() + 3_600_000).toISOString()) });
    }
    if (path === '/__rehearsal/transcript') {
      if (typeof input.projectId !== 'string' || typeof input.workspaceId !== 'string') return new Response(null, { status: 400 });
      const source = await readInspectorContext(env, env.ACCOUNT_ID, input.workspaceId, input.projectId);
      const value = input.content === true
        ? await readSavedInspectorTranscriptContent(env, env.ACCOUNT_ID, source, transcriptContentRequestSchema.parse(input.request))
        : await readSavedInspectorTranscriptPage(env, env.ACCOUNT_ID, source, transcriptPageRequestSchema.parse(input.request));
      return Response.json({ value });
    }
    return new Response(null, { status: 404 });
  },
};
