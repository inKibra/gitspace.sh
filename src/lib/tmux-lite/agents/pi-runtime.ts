import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { getWorkspaceRoot } from '../../../core/paths.js';
import type { AgentWorkspaceTarget } from '../../../agents/backend.js';
import type { OmpAgentSession, OmpCreateSessionResult } from './omp-types.js';

// Dynamic imports: oh-my-pi packages have module-level side effects (postmortem
// signal handlers that call process.exit, provider registration) that conflict
// with OpenTUI's terminal management. Keep these lazy.
const importOmpCodingAgent = () => import('@oh-my-pi/pi-coding-agent');
const importPiAi = () => import('@oh-my-pi/pi-ai');

/**
 * Pi agent directory, scoped under the configured workspace root.
 *
 * Structure:
 *   <workspace-root>/.pi/
 *     extensions/          ← gitspace-managed extensions
 *     sessions/            ← Pi session storage (by workspace path)
 *     settings.json        ← Pi settings (tool enable/disable)
 */
export function getPiAgentDir(): string {
  return join(getWorkspaceRoot(), '.pi');
}

/**
 * Ensure the Pi agent directory exists with expected subdirectories.
 */
export function ensurePiAgentDir(): string {
  const agentDir = getPiAgentDir();
  const dirs = [
    agentDir,
    join(agentDir, 'sessions'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }
  return agentDir;
}

/**
 * Build environment variables for a Pi agent session scoped to a workspace.
 *
 * Sets PI_CODING_AGENT_DIR so oh-my-pi reads config/extensions/sessions
 * from the GitSpace-managed directory (<workspace-root>/.pi/, default: ~/gitspace/.pi/)
 * instead of the upstream default (~/.omp/agent/).
 */
export function setupPiEnvironment(
  _target: AgentWorkspaceTarget,
): Record<string, string> {
  const agentDir = ensurePiAgentDir();
  return {
    PI_CODING_AGENT_DIR: agentDir,
  };
}

/**
 * Create a SessionManager pinned to GitSpace's managed Pi session root for a workspace.
 */
export async function createPiSessionManager(cwd: string) {
  const { SessionManager } = await importOmpCodingAgent();
  const agentDir = ensurePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionDir = SessionManager.getDefaultSessionDir(cwd, agentDir);
  return {
    agentDir,
    sessionManager: SessionManager.create(cwd, sessionDir),
  };
}

/**
 * Re-open an existing Pi session file in-process so GitSpace can subscribe to live SDK events
 * again after a tmux-lite restart.
 */
export async function openPiSession(cwd: string, sessionFilePath: string) {
  const {
    SessionManager,
    createAgentSession,
    discoverAuthStorage,
    ModelRegistry,
  } = await importOmpCodingAgent();
  const { getBundledModel } = await importPiAi();
  const agentDir = ensurePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const sessionManager = await SessionManager.open(sessionFilePath);
  const sessionContext = sessionManager.buildSessionContext();
  const authStorage = await discoverAuthStorage(agentDir);
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh('online-if-uncached');

  let restoredModel;
  const storedModel = sessionContext.models.default;
  if (storedModel) {
    const slashIndex = storedModel.indexOf('/');
    if (slashIndex > 0) {
      const provider = storedModel.slice(0, slashIndex);
      const modelId = storedModel.slice(slashIndex + 1);
      restoredModel = modelRegistry.find(provider, modelId) ?? undefined;
      if (!restoredModel) {
        try {
          restoredModel = getBundledModel(provider as Parameters<typeof getBundledModel>[0], modelId);
        } catch (err) {
          console.warn(`[pi-runtime] Failed to restore bundled model ${storedModel}:`, err);
          restoredModel = undefined;
        }
      }
    }
  }

  const result = await createAgentSession({
    agentDir,
    sessionManager,
    cwd,
    authStorage,
    modelRegistry,
    model: restoredModel,
    hasUI: true,
  });
  const { session, setToolUIContext } = result as unknown as OmpCreateSessionResult;
  if (!session?.sessionId) {
    throw new Error('Unexpected createAgentSession result shape — SDK version may be incompatible');
  }
  if (restoredModel && !session.model) {
    await session.setModel(restoredModel);
  }
  return {
    agentDir,
    sessionManager,
    session,
    setToolUIContext,
  };
}

/**
 * Persist the initially selected model into the session file immediately.
 * Without this, reopening an untouched session after tmux-lite restart can lose the transient
 * in-memory model choice and later prompts fail with "No model selected".
 */
export async function persistInitialPiSessionModel(session: OmpAgentSession): Promise<void> {
  if (!session.model) {
    return;
  }
  await session.setModel(session.model);
}
