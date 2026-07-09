import { delimiter, join } from 'node:path';
import { chmodSync, mkdirSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { YAML } from 'bun';
import { fileURLToPath } from 'node:url';
import { getWorkspaceRoot } from '../../../core/paths.js';
import type { AgentWorkspaceTarget } from '../../../agents/backend.js';
import { resolveWorkspaceSessionLauncherArgs } from '../../../session/workspace-shell-hooks.js';
import { escapeShellArg } from '../../../utils/shell-escape.js';
import type { OmpAgentSession, OmpAuthStorage, OmpCreateSessionResult, OmpModelRegistry } from './omp-types.js';
import { getManagedSessionBootstrap } from './managed-defaults.js';

// Dynamic imports: oh-my-pi packages have module-level side effects (postmortem
// signal handlers that call process.exit, provider registration) that conflict
// with OpenTUI's terminal management. Keep these lazy and narrow so attach does
// not evaluate the package root barrel (which pulls in far more modules).
const importSdk = () => import('@oh-my-pi/pi-coding-agent/sdk');
const importSessionManagerModule = () => import('@oh-my-pi/pi-coding-agent/session/session-manager');
const importModelRegistryModule = () => import('@oh-my-pi/pi-coding-agent/config/model-registry');
const importAgentRegistryModule = () => import('@oh-my-pi/pi-coding-agent/registry/agent-registry');

/**
 * Per-WORKSPACE agent registries for IRC routing. OMP's IrcBus defaults to a
 * process-global AgentRegistry — correct when one process hosts one agent
 * tree, but our daemon hosts every workspace's sessions in-process, which
 * made agents in different workspaces addressable IRC peers (workflow spawns
 * in workspace A were messaging agents in workspace B). Scoping the registry
 * by workspace cwd confines IRC (send/list/wait) to same-workspace agents;
 * subagents inherit their parent session's registry.
 */
const workspaceAgentRegistries = new Map<string, unknown>();
async function agentRegistryForWorkspace(cwd: string): Promise<unknown> {
  const existing = workspaceAgentRegistries.get(cwd);
  if (existing) return existing;
  const { AgentRegistry } = (await importAgentRegistryModule()) as unknown as { AgentRegistry: new () => unknown };
  const registry = new AgentRegistry();
  workspaceAgentRegistries.set(cwd, registry);
  return registry;
}
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

export function getManagedPiBinDir(): string {
  return join(getPiAgentDir(), 'bin');
}

function buildShellCommand(args: string[]): string {
  return args
    .map((arg) => (/^[A-Za-z0-9_./:-]+$/.test(arg) ? arg : escapeShellArg(arg)))
    .join(' ');
}

function prependPathEntry(pathEntry: string, currentPath: string | undefined): string {
  const segments = (currentPath ?? '').split(delimiter).filter(Boolean);
  if (segments.includes(pathEntry)) {
    return [pathEntry, ...segments.filter((segment) => segment !== pathEntry)].join(delimiter);
  }
  return currentPath && currentPath.length > 0
    ? `${pathEntry}${delimiter}${currentPath}`
    : pathEntry;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ensureManagedPiConfigDefaults(agentDir: string): void {
  const configPath = join(agentDir, 'config.yml');
  let settings: Record<string, unknown> = {};

  if (existsSync(configPath)) {
    try {
      const parsed = YAML.parse(readFileSync(configPath, 'utf8'));
      if (!isRecord(parsed)) {
        return;
      }
      settings = parsed;
    } catch (error) {
      console.warn(`[pi-runtime] Failed to read managed Pi config defaults from ${configPath}:`, error);
      return;
    }
  }

  const contextPromotion = isRecord(settings.contextPromotion)
    ? { ...settings.contextPromotion }
    : {};
  if (typeof contextPromotion.enabled === 'boolean') {
    return;
  }

  contextPromotion.enabled = false;
  settings.contextPromotion = contextPromotion;
  try {
    writeFileSync(configPath, YAML.stringify(settings, null, 2), { mode: 0o600 });
  } catch (error) {
    console.warn(`[pi-runtime] Failed to write managed Pi config defaults to ${configPath}:`, error);
  }
}

export function ensureManagedPiBinScripts(launcherArgs: string[] = resolveWorkspaceSessionLauncherArgs()): string {
  const binDir = getManagedPiBinDir();
  if (!existsSync(binDir)) {
    mkdirSync(binDir, { recursive: true, mode: 0o700 });
  }

  const spaceLauncherCommand = buildShellCommand([...launcherArgs, 'space']);
  const spaceScriptPath = join(binDir, 'space');
  writeFileSync(spaceScriptPath, `#!/bin/sh\nexec ${spaceLauncherCommand} "$@"\n`, { mode: 0o755 });
  chmodSync(spaceScriptPath, 0o755);

  const gsshScriptPath = join(binDir, 'gssh');
  const isSourceLauncher = launcherArgs.length >= 2 && launcherArgs[1]?.endsWith('/src/index.ts');
  if (isSourceLauncher) {
    const gsshLauncherCommand = buildShellCommand(launcherArgs);
    writeFileSync(gsshScriptPath, `#!/bin/sh\nexec ${gsshLauncherCommand} "$@"\n`, { mode: 0o755 });
    chmodSync(gsshScriptPath, 0o755);
  } else if (existsSync(gsshScriptPath)) {
    unlinkSync(gsshScriptPath);
  }

  return binDir;
}

function buildManagedPiEnvironment(): Record<string, string> {
  const agentDir = ensurePiAgentDir();
  ensureManagedPiConfigDefaults(agentDir);
  const binDir = ensureManagedPiBinScripts();
  return {
    PI_CODING_AGENT_DIR: agentDir,
    PATH: prependPathEntry(binDir, process.env.PATH),
  };
}

function applyManagedPiEnvironment(): Record<string, string> {
  const env = buildManagedPiEnvironment();
  process.env.PI_CODING_AGENT_DIR = env.PI_CODING_AGENT_DIR;
  process.env.PATH = env.PATH;
  return env;
}


export function getManagedPiExtensionPaths(): string[] {
  return [fileURLToPath(new URL('./extensions/space-command.ts', import.meta.url))];
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
  return buildManagedPiEnvironment();
}

/**
 * Create a SessionManager pinned to GitSpace's managed Pi session root for a workspace.
 */
export async function createPiSessionManager(cwd: string) {
  const { SessionManager } = await importSessionManagerModule();
  const env = applyManagedPiEnvironment();
  const sessionDir = SessionManager.getDefaultSessionDir(cwd, env.PI_CODING_AGENT_DIR);
  return {
    agentDir: env.PI_CODING_AGENT_DIR,
    sessionManager: SessionManager.create(cwd, sessionDir),
  };
}

/**
 * Open an existing Pi session file read-only (loads its entry tree) so callers
 * can read the transcript via getLeafId()/getEntry(). The returned manager is
 * the SDK's own structure — read it and let it go; do not retain a second copy.
 */
export async function openPiSessionManager(sessionFilePath: string) {
  const { SessionManager } = await importSessionManagerModule();
  applyManagedPiEnvironment();
  return SessionManager.open(sessionFilePath);
}

/**
 * A refreshed model registry for the current managed agent dir — used by the
 * control seam to list available models and resolve a switch target.
 */
export async function createPiModelRegistry(): Promise<OmpModelRegistry> {
  const { discoverAuthStorage } = await importSdk();
  const { ModelRegistry } = await importModelRegistryModule();
  const env = applyManagedPiEnvironment();
  const authStorage = await discoverAuthStorage(env.PI_CODING_AGENT_DIR);
  const registry = new ModelRegistry(authStorage) as unknown as OmpModelRegistry;
  await registry.refresh('online-if-uncached');
  return registry;
}

/** The auth storage for the managed agent dir — list/add provider credentials. */
export async function createPiAuthStorage(): Promise<OmpAuthStorage> {
  const { discoverAuthStorage } = await importSdk();
  const env = applyManagedPiEnvironment();
  return (await discoverAuthStorage(env.PI_CODING_AGENT_DIR)) as unknown as OmpAuthStorage;
}

/** The global settings singleton, or null if not yet initialized (no session created). */
export async function getPiSettings(): Promise<{ get(path: string): unknown; set(path: string, value: unknown): void } | null> {
  const mod = (await import('@oh-my-pi/pi-coding-agent/config/settings')) as unknown as {
    isSettingsInitialized?: () => boolean;
    settings?: { get(path: string): unknown; set(path: string, value: unknown): void };
  };
  if (mod.isSettingsInitialized && !mod.isSettingsInitialized()) return null;
  return mod.settings ?? null;
}


/**
 * local:// unification (docs/ARTIFACT-PROTOCOL.md Q2): root each session's
 * local scratch at <artifacts mount>/.sessions/<sessionId> — addressable and
 * shareable, but git-ignored (bare repo info/exclude) so it never enters
 * branch history, rollups, or the pre-commit hook. The session id is only
 * known AFTER createAgentSession returns, so callers bind it immediately
 * after; the SDK resolves these lazily per tool call.
 */
export function makeLocalProtocolOptions(cwd: string): {
  options: { getArtifactsDir: () => string | null; getSessionId: () => string | null };
  bind: (sessionId: string) => void;
} {
  let sessionId: string | null = null;
  return {
    options: {
      // local:// maps straight into the artifacts mount. The SDK appends
      // '/local' (path.resolve(artifactsDir, "local")), so files land at
      // <workspace>/.gitspace/artifacts/local/ — no per-session .sessions dir.
      getArtifactsDir: () => join(cwd, '.gitspace', 'artifacts'),
      getSessionId: () => sessionId,
    },
    bind: (id: string) => { sessionId = id; },
  };
}

/**
 * Re-open an existing Pi session file in-process so GitSpace can subscribe to live SDK events
 * again after a tmux-lite restart.
 */
export async function openPiSession(cwd: string, sessionFilePath: string) {
  const { SessionManager } = await importSessionManagerModule();
  const { createAgentSession, discoverAuthStorage, discoverSkills } = await importSdk();
  const { ModelRegistry } = await importModelRegistryModule();
  const env = applyManagedPiEnvironment();
  const sessionManager = await SessionManager.open(sessionFilePath);
  const sessionContext = sessionManager.buildSessionContext();
  const authStorage = await discoverAuthStorage(env.PI_CODING_AGENT_DIR);
  const modelRegistry = new ModelRegistry(authStorage);
  await modelRegistry.refresh('online-if-uncached');

  let restoredModel;
  const storedModel = sessionContext.models.default;
  if (storedModel) {
    const slashIndex = storedModel.indexOf('/');
    if (slashIndex > 0) {
      const provider = storedModel.slice(0, slashIndex);
      const modelId = storedModel.slice(slashIndex + 1);
      // 16.x: the model registry resolves bundled models directly (getBundledModel removed).
      restoredModel = modelRegistry.find(provider, modelId) ?? undefined;
    }
  }

  const managedBootstrap = await getManagedSessionBootstrap(cwd, env.PI_CODING_AGENT_DIR, discoverSkills);

  const localProtocol = makeLocalProtocolOptions(cwd);
  const result = await createAgentSession({
    agentDir: env.PI_CODING_AGENT_DIR,
    sessionManager,
    cwd,
    authStorage,
    modelRegistry,
    model: restoredModel,
    additionalExtensionPaths: getManagedPiExtensionPaths(),
    skills: managedBootstrap.skills,
    hasUI: true,
    localProtocolOptions: localProtocol.options,
    // IRC scoping: one registry per workspace, not the process-global one.
    agentRegistry: (await agentRegistryForWorkspace(cwd)) as never,
  });
  const { session, setToolUIContext } = result as unknown as OmpCreateSessionResult;
  if (!session?.sessionId) {
    throw new Error('Unexpected createAgentSession result shape — SDK version may be incompatible');
  }
  localProtocol.bind(session.sessionId);
  if (restoredModel && !session.model) {
    await session.setModel(restoredModel);
  }
  return {
    agentDir: env.PI_CODING_AGENT_DIR,
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
