import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  isHookInstalled,
  installHook,
  uninstallHook,
  MARKER_START_EXPORT as MARKER_START,
  MARKER_END_EXPORT as MARKER_END,
  BASH_ZSH_HOOK_EXPORT as BASH_ZSH_HOOK,
  FISH_HOOK_EXPORT as FISH_HOOK,
} from '../notifications';

// ============================================================================
// Test Setup
// ============================================================================

let tempDir: string;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'gssh-notifications-test-'));
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

// ============================================================================
// isHookInstalled
// ============================================================================

describe('isHookInstalled', () => {
  it('should return false for non-existent file', () => {
    const filePath = join(tempDir, 'nonexistent');
    expect(isHookInstalled(filePath)).toBe(false);
  });

  it('should return false for file without hook', () => {
    const filePath = join(tempDir, '.zshrc');
    writeFileSync(filePath, '# My zsh config\nexport PATH="/usr/local/bin:$PATH"\n');

    expect(isHookInstalled(filePath)).toBe(false);
  });

  it('should return true for file with hook marker', () => {
    const filePath = join(tempDir, '.zshrc');
    writeFileSync(filePath, `# My config\n${MARKER_START}\n# hook content\n${MARKER_END}\n`);

    expect(isHookInstalled(filePath)).toBe(true);
  });

  it('should detect hook anywhere in file', () => {
    const filePath = join(tempDir, '.bashrc');
    const content = `
# Existing config
export FOO=bar

${MARKER_START}
# hook content here
${MARKER_END}

# More config after
alias ll='ls -la'
`;
    writeFileSync(filePath, content);

    expect(isHookInstalled(filePath)).toBe(true);
  });
});

// ============================================================================
// installHook
// ============================================================================

describe('installHook', () => {
  it('should create file and install hook if file does not exist', () => {
    const filePath = join(tempDir, '.zshrc');

    const result = installHook(filePath, BASH_ZSH_HOOK);

    expect(result.installed).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(filePath)).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain(MARKER_START);
    expect(content).toContain(MARKER_END);
    expect(content).toContain('__gitspace_preexec');
  });

  it('should append hook to existing file', () => {
    const filePath = join(tempDir, '.zshrc');
    const existingContent = '# My existing config\nexport PATH="/usr/local/bin:$PATH"\n';
    writeFileSync(filePath, existingContent);

    const result = installHook(filePath, BASH_ZSH_HOOK);

    expect(result.installed).toBe(true);
    expect(result.created).toBe(false);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('My existing config');
    expect(content).toContain(MARKER_START);
  });

  it('should be idempotent - not install twice', () => {
    const filePath = join(tempDir, '.zshrc');
    writeFileSync(filePath, '');

    // First install
    const result1 = installHook(filePath, BASH_ZSH_HOOK);
    expect(result1.installed).toBe(true);

    const contentAfterFirst = readFileSync(filePath, 'utf-8');
    const markerCount1 = (contentAfterFirst.match(new RegExp(MARKER_START, 'g')) || []).length;
    expect(markerCount1).toBe(1);

    // Second install - should not add duplicate
    const result2 = installHook(filePath, BASH_ZSH_HOOK);
    expect(result2.installed).toBe(false);
    expect(result2.created).toBe(false);

    const contentAfterSecond = readFileSync(filePath, 'utf-8');
    const markerCount2 = (contentAfterSecond.match(new RegExp(MARKER_START, 'g')) || []).length;
    expect(markerCount2).toBe(1);
  });

  it('should create parent directories if needed', () => {
    const nestedPath = join(tempDir, '.config', 'fish', 'config.fish');

    const result = installHook(nestedPath, FISH_HOOK);

    expect(result.installed).toBe(true);
    expect(result.created).toBe(true);
    expect(existsSync(nestedPath)).toBe(true);

    const content = readFileSync(nestedPath, 'utf-8');
    expect(content).toContain('__gitspace_preexec');
    expect(content).toContain('fish_preexec');
  });

  it('should install fish hook with correct syntax', () => {
    const filePath = join(tempDir, 'config.fish');

    installHook(filePath, FISH_HOOK);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('set -q TMUX_LITE');
    expect(content).toContain('function __gitspace_preexec --on-event fish_preexec');
    expect(content).toContain('function __gitspace_postexec --on-event fish_postexec');
  });
});

// ============================================================================
// uninstallHook
// ============================================================================

describe('uninstallHook', () => {
  it('should return false for non-existent file', () => {
    const filePath = join(tempDir, 'nonexistent');
    expect(uninstallHook(filePath)).toBe(false);
  });

  it('should return false for file without hook', () => {
    const filePath = join(tempDir, '.zshrc');
    writeFileSync(filePath, '# My config\nexport FOO=bar\n');

    expect(uninstallHook(filePath)).toBe(false);

    // Content should be unchanged
    const content = readFileSync(filePath, 'utf-8');
    expect(content).toBe('# My config\nexport FOO=bar\n');
  });

  it('should remove hook block from file', () => {
    const filePath = join(tempDir, '.zshrc');
    const contentWithHook = `# Before hook
export FOO=bar

${BASH_ZSH_HOOK}

# After hook
export BAZ=qux
`;
    writeFileSync(filePath, contentWithHook);

    const result = uninstallHook(filePath);

    expect(result).toBe(true);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain(MARKER_START);
    expect(content).not.toContain(MARKER_END);
    expect(content).not.toContain('__gitspace_preexec');
    expect(content).toContain('FOO=bar');
    expect(content).toContain('BAZ=qux');
  });

  it('should be idempotent - only remove once', () => {
    const filePath = join(tempDir, '.zshrc');
    writeFileSync(filePath, `# Config\n${BASH_ZSH_HOOK}\n# End\n`);

    // First uninstall
    expect(uninstallHook(filePath)).toBe(true);

    // Second uninstall - nothing to remove
    expect(uninstallHook(filePath)).toBe(false);
  });

  it('should handle hook at start of file', () => {
    const filePath = join(tempDir, '.bashrc');
    writeFileSync(filePath, `${BASH_ZSH_HOOK}\n# Rest of config\n`);

    const result = uninstallHook(filePath);

    expect(result).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain(MARKER_START);
    expect(content).toContain('Rest of config');
  });

  it('should handle hook at end of file', () => {
    const filePath = join(tempDir, '.bashrc');
    writeFileSync(filePath, `# Start of config\nexport PATH="/bin"\n${BASH_ZSH_HOOK}`);

    const result = uninstallHook(filePath);

    expect(result).toBe(true);
    const content = readFileSync(filePath, 'utf-8');
    expect(content).not.toContain(MARKER_START);
    expect(content).toContain('Start of config');
  });

  it('should preserve file content outside hook block', () => {
    const filePath = join(tempDir, '.zshrc');
    const beforeHook = `# ZSH Configuration
export EDITOR=vim
export PATH="/usr/local/bin:$PATH"

# Aliases
alias gs='git status'
alias gd='git diff'
`;
    const afterHook = `
# More config
alias ll='ls -la'
export NODE_ENV=development
`;
    writeFileSync(filePath, `${beforeHook}${BASH_ZSH_HOOK}${afterHook}`);

    uninstallHook(filePath);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('export EDITOR=vim');
    expect(content).toContain("alias gs='git status'");
    expect(content).toContain("alias ll='ls -la'");
    expect(content).toContain('export NODE_ENV=development');
  });
});

// ============================================================================
// Round-trip tests (install then uninstall)
// ============================================================================

describe('install/uninstall round-trip', () => {
  it('should restore file to near-original state after round-trip', () => {
    const filePath = join(tempDir, '.zshrc');
    const originalContent = `# My ZSH config
export PATH="/usr/local/bin:$PATH"
alias ll='ls -la'
`;
    writeFileSync(filePath, originalContent);

    // Install
    installHook(filePath, BASH_ZSH_HOOK);
    const afterInstall = readFileSync(filePath, 'utf-8');
    expect(afterInstall).toContain(MARKER_START);

    // Uninstall
    uninstallHook(filePath);
    const afterUninstall = readFileSync(filePath, 'utf-8');

    // Should contain original content
    expect(afterUninstall).toContain('My ZSH config');
    expect(afterUninstall).toContain('PATH="/usr/local/bin');
    expect(afterUninstall).toContain("alias ll='ls -la'");
    expect(afterUninstall).not.toContain(MARKER_START);
  });

  it('should work with fish shell config', () => {
    const filePath = join(tempDir, 'config.fish');
    const originalContent = `# Fish config
set -x PATH /usr/local/bin $PATH
`;
    writeFileSync(filePath, originalContent);

    installHook(filePath, FISH_HOOK);
    expect(isHookInstalled(filePath)).toBe(true);

    uninstallHook(filePath);
    expect(isHookInstalled(filePath)).toBe(false);

    const content = readFileSync(filePath, 'utf-8');
    expect(content).toContain('Fish config');
  });
});

// ============================================================================
// Hook content validation
// ============================================================================

describe('hook content validation', () => {
  it('BASH_ZSH_HOOK should contain required markers', () => {
    expect(BASH_ZSH_HOOK).toContain(MARKER_START);
    expect(BASH_ZSH_HOOK).toContain(MARKER_END);
  });

  it('BASH_ZSH_HOOK should check for TMUX_LITE env var', () => {
    expect(BASH_ZSH_HOOK).toContain('TMUX_LITE');
  });

  it('BASH_ZSH_HOOK should emit OSC 133 sequences', () => {
    expect(BASH_ZSH_HOOK).toContain('133;C');
    expect(BASH_ZSH_HOOK).toContain('133;D');
  });

  it('BASH_ZSH_HOOK should emit OSC 777 for exit notifications', () => {
    expect(BASH_ZSH_HOOK).toContain('777;exit');
  });

  it('FISH_HOOK should contain required markers', () => {
    expect(FISH_HOOK).toContain(MARKER_START);
    expect(FISH_HOOK).toContain(MARKER_END);
  });

  it('FISH_HOOK should check for TMUX_LITE env var', () => {
    expect(FISH_HOOK).toContain('set -q TMUX_LITE');
  });

  it('FISH_HOOK should use fish event handlers', () => {
    expect(FISH_HOOK).toContain('--on-event fish_preexec');
    expect(FISH_HOOK).toContain('--on-event fish_postexec');
  });
});
