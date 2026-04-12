import { afterEach, describe, expect, mock, test } from 'bun:test';
import { Command } from 'commander';

mock.module('../../error.js', () => ({
  withErrorHandler: <T extends unknown[]>(handler: (...args: T) => Promise<void>) => handler,
}));

const { registerSpaceCommands } = await import('../space.js');

function makeProgram(): Command {
  const program = new Command();
  program.name('gssh');
  registerSpaceCommands(program);
  return program;
}

function findSubcommand(command: Command, ...path: string[]): Command {
  let current = command;
  for (const segment of path) {
    const next = current.commands.find((candidate) => candidate.name() === segment);
    if (!next) {
      throw new Error(`Missing subcommand: ${path.join(' ')}`);
    }
    current = next;
  }
  return current;
}

const envKeys = ['GSSH_SPACE_PROJECT', 'GSSH_SPACE_WORKSPACE'];
const envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

describe('registerSpaceCommands help usage', () => {
  test('shows gssh-prefixed usage outside workspace-scoped context', () => {
    delete process.env.GSSH_SPACE_PROJECT;
    delete process.env.GSSH_SPACE_WORKSPACE;

    const help = findSubcommand(makeProgram(), 'space', 'review').helpInformation();
    expect(help).toContain('Usage: gssh space review');
  });

  test('shows space-prefixed usage inside workspace-scoped context', () => {
    process.env.GSSH_SPACE_PROJECT = 'demo';
    process.env.GSSH_SPACE_WORKSPACE = 'ws-1';

    const help = findSubcommand(makeProgram(), 'space', 'review').helpInformation();
    expect(help).toContain('Usage: space review');
    expect(help).not.toContain('Usage: gssh space review');
  });
});
