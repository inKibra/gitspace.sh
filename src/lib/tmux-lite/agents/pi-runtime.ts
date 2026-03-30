import { join } from 'node:path';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import rootPackageJson from '../../../../package.json';
import { getWorkspaceRoot } from '../../../core/paths.js';
import type { AgentWorkspaceTarget } from '../../../agents/backend.js';
import type { OmpAgentSession, OmpModule, PiAiModule } from './omp-types.js';

const OMP_PACKAGE = '@oh-my-pi/pi-coding-agent';
const PI_AI_PACKAGE = '@oh-my-pi/pi-ai';
const OMP_BIN_NAME = 'omp';
const MANAGED_OMP_PACKAGE_SPEC = readManagedOmpPackageSpec();

/**
 * Pi agent directory, scoped under the configured workspace root.
 *
 * Default structure:
 *   <workspace-root>/.pi/
 *     bin/                 ← managed binaries (omp, fd, ast-grep, etc.)
 *     extensions/          ← gitspace-managed extensions
 *     sessions/            ← Pi session storage (by workspace path)
 *     node_modules/        ← oh-my-pi installation
 *     package.json         ← managed package manifest
 *     settings.json        ← Pi settings (tool enable/disable)
 */
export async function importOmpModule(): Promise<OmpModule> {
  return await import(OMP_PACKAGE) as unknown as OmpModule;
}

export async function importPiAiModule(): Promise<PiAiModule> {
  return await import(PI_AI_PACKAGE) as unknown as PiAiModule;
}


function readManagedOmpPackageSpec(): string {
  const spec = (rootPackageJson as {
    dependencies?: Record<string, string>;
  }).dependencies?.[OMP_PACKAGE]?.trim();
  if (!spec) {
    throw new Error(`Managed Pi package spec for ${OMP_PACKAGE} is missing from the root package manifest`);
  }
  return spec;
}

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
    join(agentDir, 'bin'),
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
 * Get the installed oh-my-pi version, or null if not installed.
 */
function getInstalledOmpVersion(agentDir: string): string | null {
  try {
    const pkgPath = join(agentDir, 'node_modules', OMP_PACKAGE, 'package.json');
    if (!existsSync(pkgPath)) return null;
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

/**
 * Get the path to the omp binary.
 */
export function getOmpBinPath(): string {
  const agentDir = getPiAgentDir();
  return join(agentDir, 'node_modules', '.bin', OMP_BIN_NAME);
}


/**
 * Ensure oh-my-pi is installed and up to date.
 * Installs to <workspace-root>/.pi/ with its own package.json so it's
 * independent of gitspace's node_modules.
 *
 * Returns the path to the omp binary.
 */
export async function ensureOmpInstalled(): Promise<string> {
  const agentDir = ensurePiAgentDir();
  const binPath = getOmpBinPath();

  // Ensure a package.json exists in the agent dir for bun install
  const pkgJsonPath = join(agentDir, 'package.json');
  if (!existsSync(pkgJsonPath)) {
    writeFileSync(pkgJsonPath, JSON.stringify({
      name: 'gitspace-pi-agent',
      private: true,
      dependencies: {
        [OMP_PACKAGE]: MANAGED_OMP_PACKAGE_SPEC,
      },
    }, null, 2));
  }

  // Check if already installed
  const installed = getInstalledOmpVersion(agentDir);
  if (installed && existsSync(binPath)) {
    return binPath;
  }

  // Install oh-my-pi
  execSync('bun install', {
    cwd: agentDir,
    stdio: 'ignore',
    timeout: 120_000,
  });

  if (!existsSync(binPath)) {
    throw new Error(`oh-my-pi installation failed: ${binPath} not found`);
  }

  return binPath;
}

/**
 * Update oh-my-pi to the managed repo-pinned version.
 * Called periodically (e.g., on tmux-lite server startup).
 */
export async function updateOmp(): Promise<{ version: string; updated: boolean }> {
  const agentDir = ensurePiAgentDir();
  const before = getInstalledOmpVersion(agentDir);

  // Update the dependency
  const pkgJsonPath = join(agentDir, 'package.json');
  const pkg = existsSync(pkgJsonPath)
    ? JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    : { name: 'gitspace-pi-agent', private: true, dependencies: {} };
  pkg.dependencies[OMP_PACKAGE] = MANAGED_OMP_PACKAGE_SPEC;
  writeFileSync(pkgJsonPath, JSON.stringify(pkg, null, 2));

  execSync('bun install', {
    cwd: agentDir,
    stdio: 'ignore',
    timeout: 120_000,
  });

  const after = getInstalledOmpVersion(agentDir);
  return {
    version: after ?? 'unknown',
    updated: before !== after,
  };
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
    // Both upstream Pi and oh-my-pi use PI_CODING_AGENT_DIR
    PI_CODING_AGENT_DIR: agentDir,
  };
}


/**
 * Create a SessionManager pinned to GitSpace's managed Pi session root for a workspace.
 */
export async function createPiSessionManager(cwd: string) {
  const agentDir = ensurePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const { SessionManager } = await importOmpModule();
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
  const agentDir = ensurePiAgentDir();
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const {
    SessionManager,
    createAgentSession,
    discoverAuthStorage,
    ModelRegistry,
  } = await importOmpModule();
  const { getBundledModel } = await importPiAiModule();
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
        } catch {
          restoredModel = undefined;
        }
      }
    }
  }

  const { session } = await createAgentSession({
    agentDir,
    sessionManager,
    cwd,
    authStorage,
    modelRegistry,
    model: restoredModel,
  });
  if (restoredModel && !session.model) {
    await session.setModel(restoredModel);
  }
  return {
    agentDir,
    sessionManager,
    session,
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