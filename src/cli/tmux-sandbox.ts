import type { Command } from 'commander';
import { applyTmuxLiteSandboxEnvironment } from '../lib/tmux-lite/protocol.js';

function resolveSandboxOption(command: Command | null | undefined): string | undefined {
  let current: Command | null | undefined = command;
  while (current) {
    const sandbox = current.opts<{ sandbox?: string }>().sandbox;
    if (sandbox) {
      return sandbox;
    }
    current = current.parent;
  }
  return undefined;
}

export function configureTmuxSandbox(command: Command): void {
  command.option('--sandbox <name>', 'Use an isolated tmux-lite runtime sandbox');
  command.hook('preAction', (_command, actionCommand) => {
    const sandbox = resolveSandboxOption(actionCommand);
    if (sandbox) {
      applyTmuxLiteSandboxEnvironment(sandbox);
    }
  });
}
