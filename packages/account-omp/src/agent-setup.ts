import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import type { AgentDefinitionSetup, AgentSetupView, SaveAgentDefinitionInput } from '@gitspace/protocol';
import type { AgentSession } from '@oh-my-pi/pi-coding-agent';
import { parseAgent } from '@oh-my-pi/pi-coding-agent/task/agents';
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery';
import { refreshAgentDiscovery } from '@oh-my-pi/pi-coding-agent/task';
import { formatModelString, resolveAgentModelSelection, resolveModelOverrideWithAuthFallback } from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import { withFileLock } from '@oh-my-pi/pi-utils/file-lock';
import { getHistoricalModelSelection } from '@oh-my-pi/pi-coding-agent/session/model-usage';

const MAX_DEFINITION_BYTES = 128 * 1024;
const WORKSPACE_AGENT_PATH = /^\.omp\/agents\/[a-zA-Z0-9][a-zA-Z0-9._-]*\.md$/;

/** Only native repo files are editable; a plugin may also have source=project. */
async function workspaceFile(root: string, path: string, createDirectories = false): Promise<string> {
  if (!WORKSPACE_AGENT_PATH.test(path)) throw new Error('Only workspace .omp/agents/*.md files can be saved');
  let parent = root;
  for (const part of ['.omp', 'agents']) {
    parent = join(parent, part);
    if (createDirectories) await mkdir(parent).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
    const info = await lstat(parent);
    if (!info.isDirectory() || info.isSymbolicLink() || await realpath(parent) !== parent) throw new Error('Agent directory symlinks are not writable');
  }
  const target = join(root, path);
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Agent definition must be a regular file, not a symlink');
  return target;
}

async function readRevision(path: string): Promise<{ revision: string; mode: number } | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return null; throw error; });
  if (!file) return null;
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > MAX_DEFINITION_BYTES) throw new Error(`Agent definition must be a regular file no larger than ${MAX_DEFINITION_BYTES} bytes`);
    const bytes = Buffer.allocUnsafe(info.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > info.size) throw new Error('Agent definition grew while reading; reload before saving');
    return { revision: createHash('sha256').update(bytes.subarray(0, length)).digest('hex'), mode: info.mode & 0o777 };
  } finally { await file.close(); }
}

export class WorkspaceAgentSetup {
  constructor(private readonly session: AgentSession, private readonly workspace: string) {}

  async view(): Promise<AgentSetupView> {
    const root = await realpath(this.workspace);
    const discovery = await discoverAgents(this.workspace, undefined, this.session.effectiveExtensionRoots);
    if (discovery.diagnostics?.length) throw new Error(`Agent discovery failed:\n${discovery.diagnostics.map((item) => `${item.path}: ${item.message}`).join('\n')}`);
    const activeModelPattern = this.session.model ? formatModelString(this.session.model) : undefined;
    const inheritedRole = getHistoricalModelSelection(this.session.sessionManager).role;
    const agents = await Promise.all(discovery.agents.map(async (agent): Promise<AgentDefinitionSetup> => {
      if (agent.content === undefined || !agent.revision || !agent.filePath) throw new Error(`Agent ${agent.name} has no loaded source snapshot`);
      const portable = relative(root, resolve(agent.filePath)).split('\\').join('/');
      let editable = false;
      if (WORKSPACE_AGENT_PATH.test(portable)) {
        try { await workspaceFile(root, portable); editable = true; } catch { /* The definition remains readable, but not writable. */ }
      }
      const selected = resolveAgentModelSelection({
        settingsOverride: this.session.settings.get('task.agentModelOverrides')[agent.name],
        agentModel: agent.model,
        settings: this.session.settings,
        activeModelPattern,
      });
      const { model } = await resolveModelOverrideWithAuthFallback(selected.patterns, activeModelPattern, this.session.modelRegistry, this.session.settings, this.session.sessionId);
      return {
        name: agent.name, description: agent.description, source: agent.source,
        path: editable ? portable : agent.filePath, editable, content: agent.content, revision: agent.revision,
        modelSelectors: agent.model ?? [], role: selected.role ?? (selected.selection === 'inherited' ? inheritedRole : null),
        provider: model?.provider ?? null, model: model?.id ?? null,
        selection: selected.selection === 'request' ? 'definition' : selected.selection,
        tools: agent.tools ?? [], spawns: agent.spawns === '*' ? '*' : agent.spawns?.join(',') ?? null,
      };
    }));
    return { sessionId: this.session.sessionId, agents };
  }

  async save(input: SaveAgentDefinitionInput): Promise<AgentSetupView> {
    if (Buffer.byteLength(input.content, 'utf8') > MAX_DEFINITION_BYTES) throw new Error(`Agent definition exceeds ${MAX_DEFINITION_BYTES} bytes`);
    if (input.expectedRevision !== null && !/^[a-f0-9]{64}$/.test(input.expectedRevision)) throw new Error('Invalid agent definition revision');
    if (!WORKSPACE_AGENT_PATH.test(input.path)) throw new Error('Only workspace .omp/agents/*.md files can be saved');
    const root = await realpath(this.workspace);
    // Parsing happens before mkdir or opening any writer, including create-only overrides.
    parseAgent(join(root, input.path), input.content, 'project');
    const target = await workspaceFile(root, input.path, true);
    await withFileLock(target, async () => {
    const directory = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    let temp: string | undefined;
    // On Linux pin all mutations to the opened directory, closing ancestor-swap races.
    const pinnedDirectory = process.platform === 'linux' ? `/proc/self/fd/${directory.fd}` : dirname(target);
    const pinnedTarget = join(pinnedDirectory, input.path.slice('.omp/agents/'.length));
    try {
      const opened = await directory.stat();
      const checkDirectory = async (): Promise<void> => {
        await workspaceFile(root, input.path);
        const current = await lstat(dirname(target));
        if (current.dev !== opened.dev || current.ino !== opened.ino) throw new Error('Agent directory changed during save');
      };
      await checkDirectory();
      const previous = await readRevision(pinnedTarget);
      if ((previous?.revision ?? null) !== input.expectedRevision) throw new Error('Agent definition revision conflict; reload before saving');
      temp = join(pinnedDirectory, `.${randomUUID()}.tmp`);
      const file = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, previous?.mode ?? 0o644);
      try { await file.writeFile(input.content, 'utf8'); await file.sync(); } finally { await file.close(); }
      await checkDirectory();
      if ((await readRevision(pinnedTarget))?.revision !== previous?.revision) throw new Error('Agent definition changed during save; reload before saving');
      if (input.expectedRevision === null) {
        // Atomic no-clobber publication even when another application creates the file.
        await link(temp, pinnedTarget);
        await unlink(temp);
      } else {
        await rename(temp, pinnedTarget);
      }
      temp = undefined;
      await directory.sync();
    } finally {
      if (temp) await unlink(temp).catch(() => {});
      await directory.close();
    }
    });
    try {
      await refreshAgentDiscovery(this.workspace, this.session.effectiveExtensionRoots);
      return await this.view();
    } catch (error) {
      throw new Error(`Agent definition saved, but discovery refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
