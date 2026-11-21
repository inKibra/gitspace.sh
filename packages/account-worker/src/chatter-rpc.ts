import { deviceCanAdminister, scopeAllowsProject, type DeviceCapability, type GitSpaceRpcContext } from '@gitspace/protocol';
import { CHATTER_PROJECT_STRIP, ChatterFileActionSchema, type ChatterAuthor } from '@gitspace/protocol/chatter-contract';
import { GITSPACE_SOURCE_REPOSITORY } from '@gitspace/protocol/project-authority';
import {
  chatterDigestPreviewContract, chatterFileIssueContract, chatterHearingsContract, chatterIssuesContract, chatterPostContract, chatterSetProjectMuteContract, chatterSetVolumeContract,
  chatterTopicActContract, chatterTopicsContract, chatterVolumesContract, chatterWatchContract,
} from '@gitspace/protocol/rpc-contract';
import { err, ok } from 'result-rpc';
import { serverRpc } from 'result-rpc/server';
import { DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE, deviceAuthority } from './device-authority.js';
import { acrossRelease } from './release-worker.js';

/** The call's project is not one of the account's. */
class ChatterProjectMissing extends Error {}

/** A project's Chatter for people (docs/CHATTER-DESIGN.md §7–8). The account RPC admits `chatter.*` for project-scoped
 * and several-projects devices; here the device's scope must reach the call's project, and the project must be the
 * account's. A post reaches agents' context, so it needs `session.prompt` beside `rpc.write`. */
export function chatterCloudProcedures(env: Env, userId: string, deviceId: string) {
  const server = serverRpc.context<GitSpaceRpcContext>();
  const projects = env.USER_PROJECTS.getByName(userId);
  const message = (error: unknown) => error instanceof Error ? error.message : String(error);
  const chatter = async (projectId: string, capabilities: readonly DeviceCapability[]) => {
    const view = await deviceAuthority(env).current();
    if (!view) throw new Error(DEVICE_AUTHORITY_UNAVAILABLE_MESSAGE);
    const device = view.device(deviceId, Date.now());
    if (!device || !capabilities.every(capability => device.capabilities.includes(capability))) throw new Error('Chatter authorization has expired or lacks permission');
    if (!scopeAllowsProject(device.scope, projectId)) throw new Error('Project is outside the device scope');
    if (!(await projects.list()).some(entry => entry.id === projectId)) throw new ChatterProjectMissing();
    return { object: env.PROJECT_CHATTER.getByName(`${userId}:${projectId}`), device };
  };
  /** The person who connected this device, as their posts and topic actions name them. */
  const person = async (): Promise<ChatterAuthor> => {
    const { profile } = await env.USER_SETTINGS.getByName(userId).get(deviceId);
    return { kind: 'person', id: deviceId, name: profile.displayName.trim() || profile.handle || 'a person' };
  };

  const watch = server.implement(chatterWatchContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      return ok(await acrossRelease(() => object.watch({ after: input.after, before: input.before, topic: input.topic, limit: input.limit })));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'read Chatter', message: message(error) }));
    }
  });
  const topics = server.implement(chatterTopicsContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      return ok({ topics: await acrossRelease(() => object.topics({ query: input.query, limit: input.limit })) });
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'read Chatter topics', message: message(error) }));
    }
  });
  const post = server.implement(chatterPostContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.write', 'session.prompt']);
      const author = await person();
      const outcome = await acrossRelease(async () => await object.post({ projectId: input.projectId, id: input.id, topic: input.topic, kind: input.kind, text: input.text, author }));
      if (outcome.status === 'ok') return ok(outcome.value);
      return err(errors.ChatterInvalid({ field: outcome.failure.field, message: outcome.failure.message }));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'post to Chatter', message: message(error) }));
    }
  });
  const topicAct = server.implement(chatterTopicActContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.write']);
      const author = await person();
      const outcome = await acrossRelease(async () => await object.act({ projectId: input.projectId, key: input.key, action: input.action, author }));
      if (outcome.status === 'ok') return ok(outcome.value);
      const refused = outcome.failure;
      return err(refused.kind === 'invalid' ? errors.ChatterInvalid({ field: refused.field, message: refused.message }) : errors.TopicNotFound({ projectId: input.projectId, key: refused.key }));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'act on a Chatter topic', message: message(error) }));
    }
  });
  const issues = server.implement(chatterIssuesContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      return ok(await acrossRelease(() => object.issues(input.workspaceId)));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'read the workspace\'s issues', message: message(error) }));
    }
  });
  /** Filing or a draft decides as the person: the account RPC already required `operator.decide`; a draft leaves the
   * account, so it also needs account administration. */
  const fileIssue = server.implement(chatterFileIssueContract).handler(async ({ input, errors }) => {
    try {
      const action = ChatterFileActionSchema.parse(input.action);
      const { object, device } = await chatter(input.projectId, ['rpc.write']);
      if (action.kind === 'share' && !deviceCanAdminister(device, 'account.admin')) throw new Error('Opening a GitHub issue draft requires account administration');
      const issue = await acrossRelease(() => object.issue(input.key, input.workspaceId));
      if (!issue) return err(errors.TopicNotFound({ projectId: input.projectId, key: input.key }));
      const { topic, spot } = issue;
      const at = new Date().toISOString();
      let shareDraft: string | null = null;
      if (action.kind === 'file') {
        // Keyed by the topic, so filing it again replaces the account's copy with the newer excerpt.
        await env.ACCOUNT_STATE.getByName('account').fileIssue({
          id: `chatter:${input.projectId}:${topic.key}`, projectId: input.projectId, workspaceId: input.workspaceId, title: topic.display, excerpt: action.excerpt,
          tool: spot?.tool ?? null, model: 'unattributed', historyRef: spot?.reference ?? `history://${input.workspaceId}`, createdAt: topic.firstAt.toISOString(), filedAt: at, filedBy: deviceId,
        });
      } else {
        const reference = action.target === 'gitspace' ? GITSPACE_SOURCE_REPOSITORY : (await acrossRelease(() => env.PROJECT_AUTHORITY.getByName(`${userId}:${input.projectId}`).getProject()))?.repositoryReference;
        if (!reference) return err(errors.ChatterInvalid({ field: 'target', message: 'The project has no canonical repository' }));
        const repository = new URL(reference.replace(/^git@github\.com:/u, 'https://github.com/').replace(/\.git$/u, ''));
        if (repository.hostname !== 'github.com' || !/^\/[^/]+\/[^/]+\/?$/u.test(repository.pathname)) return err(errors.ChatterInvalid({ field: 'target', message: 'Issue drafts need a GitHub repository' }));
        const url = new URL(`${repository.pathname.replace(/\/$/u, '')}/issues/new`, 'https://github.com');
        url.searchParams.set('title', topic.display);
        url.searchParams.set('body', action.redactedExcerpt);
        shareDraft = url.toString();
      }
      const author = await person();
      const filed = await acrossRelease(async () => await object.filed({ projectId: input.projectId, key: topic.key, filed: { at, by: author.name, target: action.kind === 'file' ? 'gitspace' : action.target } }));
      return ok({ topic: filed, shareDraft });
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'file a Chatter issue', message: message(error) }));
    }
  });
  /** A strip as its volume line and digest name it: the project agent, or a workspace of the project with its phase. */
  const strip = async (projectId: string, id: string): Promise<{ name: string; phase: string | null } | null> => {
    if (id === CHATTER_PROJECT_STRIP) return { name: 'the project agent', phase: null };
    const workspace = await acrossRelease(() => env.PROJECT_AUTHORITY.getByName(`${userId}:${projectId}`).getWorkspace(id));
    return workspace && workspace.kind === 'worktree' ? { name: workspace.name, phase: workspace.phase ?? null } : null;
  };
  const volumes = server.implement(chatterVolumesContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      return ok(await acrossRelease(() => object.volumes()));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'read Chatter volumes', message: message(error) }));
    }
  });
  const setVolume = server.implement(chatterSetVolumeContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.write']);
      const named = await strip(input.projectId, input.strip);
      if (!named) return err(errors.ChatterInvalid({ field: 'strip', message: 'That is not a workspace of this project' }));
      const author = await person();
      return ok(await acrossRelease(async () => await object.setVolume({ projectId: input.projectId, strip: input.strip, name: named.name, phase: named.phase, level: input.level, muted: input.muted, author })));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'set a Chatter volume', message: message(error) }));
    }
  });
  const setProjectMute = server.implement(chatterSetProjectMuteContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.write']);
      const author = await person();
      return ok(await acrossRelease(async () => await object.setProjectMute({ projectId: input.projectId, on: input.on, author })));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'mute Chatter for the project', message: message(error) }));
    }
  });
  const hearings = server.implement(chatterHearingsContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      return ok(await acrossRelease(() => object.hearings(input.offset)));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'read who hears a post', message: message(error) }));
    }
  });
  const digestPreview = server.implement(chatterDigestPreviewContract).handler(async ({ input, errors }) => {
    try {
      const { object } = await chatter(input.projectId, ['rpc.read']);
      const named = await strip(input.projectId, input.listener);
      return ok(await acrossRelease(() => object.digestPreview({ listener: input.listener, name: named?.name ?? input.listener })));
    } catch (error) {
      if (error instanceof ChatterProjectMissing) return err(errors.ProjectNotFound({ projectId: input.projectId }));
      return err(errors.OperationFailed({ operation: 'hear Chatter as an agent', message: message(error) }));
    }
  });
  return { watch, post, topics, topicAct, issues, fileIssue, volumes, setVolume, setProjectMute, hearings, digestPreview };
}
