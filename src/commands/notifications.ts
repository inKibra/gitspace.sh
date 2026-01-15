/**
 * Notifications command - manage shell integration hooks
 *
 * Commands:
 *   gssh notifications install   - Install shell hooks for notification integration
 *   gssh notifications uninstall - Remove shell hooks
 *   gssh notifications hook      - Print shell hook snippet
 *   gssh notifications status    - Show current notification config
 */

import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { logger } from '../utils/logger.js';
import { getNotificationConfig } from '../core/config.js';

// ============================================================================
// Shell Hook Snippets
// ============================================================================

const MARKER_START = '# >>> gitspace notifications >>>';
const MARKER_END = '# <<< gitspace notifications <<<';

/**
 * Bash/Zsh hook snippet
 * Uses PROMPT_COMMAND for bash, precmd for zsh
 * Emits OSC 133 C/D for command start/done and OSC 777 for exit codes
 */
const BASH_ZSH_HOOK = `${MARKER_START}
# GitSpace notification hooks - do not edit this block manually
# Emits OSC 133 (semantic shell integration) and OSC 777 (exit notifications)

# Only run inside tmux-lite sessions
if [[ -n "\${TMUX_LITE:-}" ]]; then
  # OSC 133 command start
  __gitspace_preexec() {
    printf '\\033]133;C\\007'
  }

  # OSC 133 command done + OSC 777 exit notification
  __gitspace_precmd() {
    local exit_code=$?
    printf '\\033]133;D;%d\\007' "$exit_code"
    if [[ $exit_code -ne 0 ]]; then
      printf '\\033]777;exit:%d\\007' "$exit_code"
    fi
  }

  # Install hooks based on shell
  if [[ -n "\${ZSH_VERSION:-}" ]]; then
    # Zsh: use preexec and precmd hooks
    autoload -Uz add-zsh-hook 2>/dev/null || true
    if type add-zsh-hook &>/dev/null; then
      add-zsh-hook preexec __gitspace_preexec
      add-zsh-hook precmd __gitspace_precmd
    fi
  elif [[ -n "\${BASH_VERSION:-}" ]]; then
    # Bash: use DEBUG trap and PROMPT_COMMAND
    __gitspace_debug_trap() {
      if [[ "\${BASH_COMMAND:-}" != "\${PROMPT_COMMAND:-}" ]] && [[ -z "\${__gitspace_in_prompt:-}" ]]; then
        __gitspace_preexec
      fi
    }
    trap '__gitspace_debug_trap' DEBUG

    __gitspace_prompt_cmd() {
      __gitspace_in_prompt=1
      __gitspace_precmd
      unset __gitspace_in_prompt
    }
    PROMPT_COMMAND="__gitspace_prompt_cmd\${PROMPT_COMMAND:+;}\${PROMPT_COMMAND:-}"
  fi
fi
${MARKER_END}`;

/**
 * Fish hook snippet
 * Uses fish_preexec and fish_postexec
 */
const FISH_HOOK = `${MARKER_START}
# GitSpace notification hooks - do not edit this block manually
# Emits OSC 133 (semantic shell integration) and OSC 777 (exit notifications)

# Only run inside tmux-lite sessions
if set -q TMUX_LITE
  function __gitspace_preexec --on-event fish_preexec
    printf '\\033]133;C\\007'
  end

  function __gitspace_postexec --on-event fish_postexec
    set -l exit_code $status
    printf '\\033]133;D;%d\\007' $exit_code
    if test $exit_code -ne 0
      printf '\\033]777;exit:%d\\007' $exit_code
    end
  end
end
${MARKER_END}`;

// ============================================================================
// Shell Config Paths
// ============================================================================

interface ShellConfig {
  name: string;
  paths: string[];
  hook: string;
}

function getShellConfigs(): ShellConfig[] {
  const home = homedir();
  return [
    {
      name: 'bash',
      paths: [
        join(home, '.bashrc'),
        join(home, '.bash_profile'),
      ],
      hook: BASH_ZSH_HOOK,
    },
    {
      name: 'zsh',
      paths: [
        join(home, '.zshrc'),
      ],
      hook: BASH_ZSH_HOOK,
    },
    {
      name: 'fish',
      paths: [
        join(home, '.config', 'fish', 'config.fish'),
      ],
      hook: FISH_HOOK,
    },
  ];
}

// ============================================================================
// Install/Uninstall Functions (exported for testing)
// ============================================================================

/** Exported for testing */
export const MARKER_START_EXPORT = MARKER_START;
export const MARKER_END_EXPORT = MARKER_END;
export const BASH_ZSH_HOOK_EXPORT = BASH_ZSH_HOOK;
export const FISH_HOOK_EXPORT = FISH_HOOK;

/**
 * Check if hook is already installed in a file
 */
export function isHookInstalled(filePath: string): boolean {
  if (!existsSync(filePath)) return false;
  const content = readFileSync(filePath, 'utf-8');
  return content.includes(MARKER_START);
}

/**
 * Install hook in a file (idempotent)
 */
export function installHook(filePath: string, hook: string): { installed: boolean; created: boolean } {
  try {
    // Check if already installed
    if (isHookInstalled(filePath)) {
      return { installed: false, created: false };
    }

    // Create parent directories if needed
    const dir = join(filePath, '..');
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    // Create file if it doesn't exist
    const created = !existsSync(filePath);
    if (created) {
      writeFileSync(filePath, '', 'utf-8');
    }

    // Check for existing DEBUG trap in Bash
    if (!created && (filePath.endsWith('.bashrc') || filePath.endsWith('.bash_profile'))) {
      const content = readFileSync(filePath, 'utf-8');
      if (content.includes('trap') && content.includes('DEBUG')) {
        logger.warning(`Warning: Existing DEBUG trap found in ${filePath}. The GitSpace hook may overwrite it.`);
      }
    }

    // Append hook
    appendFileSync(filePath, '\n' + hook + '\n', 'utf-8');
    return { installed: true, created };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to install hook in ${filePath}: ${msg}`);
    return { installed: false, created: false };
  }
}

/**
 * Remove hook from a file
 */
export function uninstallHook(filePath: string): boolean {
  try {
    if (!existsSync(filePath)) return false;

    const content = readFileSync(filePath, 'utf-8');
    if (!content.includes(MARKER_START)) {
      return false;
    }

    // Remove the hook block (including surrounding newlines)
    const pattern = new RegExp(
      `\\n?${escapeRegExp(MARKER_START)}[\\s\\S]*?${escapeRegExp(MARKER_END)}\\n?`,
      'g'
    );
    const newContent = content.replace(pattern, '\n');
    writeFileSync(filePath, newContent, 'utf-8');
    return true;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    logger.error(`Failed to uninstall hook from ${filePath}: ${msg}`);
    return false;
  }
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ============================================================================
// Command Handlers
// ============================================================================

/**
 * Install shell hooks for all detected shells
 */
export async function notificationsInstall(): Promise<void> {
  const configs = getShellConfigs();
  let anyInstalled = false;

  logger.log('Installing GitSpace notification hooks...\n');

  for (const config of configs) {
    for (const path of config.paths) {
      // Only install to the first existing file for each shell, or create the primary one
      const isPrimary = path === config.paths[0];

      if (existsSync(path) || isPrimary) {
        const result = installHook(path, config.hook);
        if (result.installed) {
          if (result.created) {
            logger.success(`Created and installed hook in: ${path}`);
          } else {
            logger.success(`Installed hook in: ${path}`);
          }
          anyInstalled = true;
        } else {
          logger.dim(`Already installed in: ${path}`);
        }
        break; // Only install once per shell
      }
    }
  }

  if (anyInstalled) {
    logger.log('\nRestart your shell or run "source ~/.bashrc" (or equivalent) to activate.');
    logger.log('Hooks only activate inside tmux-lite sessions (gssh workspaces).');
  } else {
    logger.log('\nAll hooks were already installed.');
  }
}

/**
 * Remove shell hooks from all shell configs
 */
export async function notificationsUninstall(): Promise<void> {
  const configs = getShellConfigs();
  let anyRemoved = false;

  logger.log('Removing GitSpace notification hooks...\n');

  for (const config of configs) {
    for (const path of config.paths) {
      if (uninstallHook(path)) {
        logger.success(`Removed hook from: ${path}`);
        anyRemoved = true;
      }
    }
  }

  if (anyRemoved) {
    logger.log('\nHooks removed. Restart your shell to complete.');
  } else {
    logger.log('\nNo hooks were installed.');
  }
}

/**
 * Print shell hook snippet for manual installation
 */
export async function notificationsHook(shell?: string): Promise<void> {
  const configs = getShellConfigs();

  if (!shell) {
    logger.log('Available shells: bash, zsh, fish');
    logger.log('Usage: gssh notifications hook --shell <shell>\n');
    return;
  }

  const config = configs.find(c => c.name === shell.toLowerCase());
  if (!config) {
    logger.error(`Unknown shell: ${shell}`);
    logger.log('Available shells: bash, zsh, fish');
    return;
  }

  logger.log(`# Add this to your ${config.paths[0]}:\n`);
  console.log(config.hook);
}

/**
 * Show current notification settings
 */
export async function notificationsStatus(): Promise<void> {
  const config = getNotificationConfig();

  logger.bold('Notification Settings\n');

  logger.log(`Enabled: ${config.enabled ? 'yes' : 'no'}`);
  logger.log(`Min command duration: ${config.minCommandDurationMs}ms`);
  logger.log(`Toast notifications: ${config.toast.enabled ? 'enabled' : 'disabled'}`);

  logger.log('\nNotification types:');
  logger.log(`  Exit notifications: ${config.types.exit ? 'on' : 'off'}`);
  logger.log(`  Idle notifications: ${config.types.idle ? 'on' : 'off'}`);
  logger.log(`  Bell notifications: ${config.types.bell ? 'on' : 'off'}`);
  logger.log(`  Title change notifications: ${config.types.title ? 'on' : 'off'}`);
  logger.log(`  OSC notifications: ${config.types.osc ? 'on' : 'off'}`);

  // Check shell hook installation status
  logger.log('\nShell hooks:');
  const configs = getShellConfigs();
  for (const shellConfig of configs) {
    for (const path of shellConfig.paths) {
      if (existsSync(path)) {
        const installed = isHookInstalled(path);
        const status = installed ? 'installed' : 'not installed';
        logger.log(`  ${shellConfig.name} (${path}): ${status}`);
        break;
      }
    }
  }
}
