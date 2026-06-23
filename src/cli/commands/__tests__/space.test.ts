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

function isRequiredOption(command: Command, longFlag: string): boolean {
  return Boolean(command.options.find((option) => option.long === longFlag)?.required);
}

const envKeys = ['GSSH_SPACE_PROJECT', 'GSSH_SPACE_WORKSPACE', 'GITSPACE_WORKSPACE_ROOT'];
const envSnapshot = new Map(envKeys.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of envSnapshot) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('registerSpaceCommands goal surface', () => {
  test('registers the new goal command surface', () => {
    const space = findSubcommand(makeProgram(), 'space');
    expect(findSubcommand(space, 'goal', 'show').name()).toBe('show');
    expect(findSubcommand(space, 'goal', 'set').name()).toBe('set');
    expect(findSubcommand(space, 'goal', 'edit').name()).toBe('edit');
    expect(findSubcommand(space, 'goal', 'status').name()).toBe('status');

    expect(findSubcommand(space, 'goal', 'requirement', 'add').name()).toBe('add');
    expect(findSubcommand(space, 'goal', 'requirement', 'update').name()).toBe('update');
    expect(findSubcommand(space, 'goal', 'requirement', 'remove').name()).toBe('remove');
    expect(findSubcommand(space, 'goal', 'requirement', 'list').name()).toBe('list');
    expect(findSubcommand(space, 'goal', 'requirement', 'reorder').name()).toBe('reorder');
    expect(findSubcommand(space, 'goal', 'requirement', 'reopen').name()).toBe('reopen');

    expect(findSubcommand(space, 'goal', 'artifact', 'attach').name()).toBe('attach');
    expect(findSubcommand(space, 'goal', 'artifact', 'run').name()).toBe('run');

    expect(findSubcommand(space, 'goal', 'review', 'run').name()).toBe('run');
    expect(findSubcommand(space, 'goal', 'review', 'record').name()).toBe('record');
  });

  test('artifact attach and review record require a requirement scope', () => {
    const space = findSubcommand(makeProgram(), 'space');
    expect(isRequiredOption(findSubcommand(space, 'goal', 'artifact', 'attach'), '--requirement')).toBe(true);
    expect(isRequiredOption(findSubcommand(space, 'goal', 'artifact', 'run'), '--requirement')).toBe(true);
    expect(isRequiredOption(findSubcommand(space, 'goal', 'review', 'run'), '--requirement')).toBe(true);
    expect(isRequiredOption(findSubcommand(space, 'goal', 'review', 'record'), '--requirement')).toBe(true);
    expect(isRequiredOption(findSubcommand(space, 'goal', 'review', 'record'), '--decision')).toBe(true);
  });

  test('requirement add wires the contract authoring fields', () => {
    const add = findSubcommand(makeProgram(), 'space', 'goal', 'requirement', 'add');
    expect(isRequiredOption(add, '--title')).toBe(true);
    expect(isRequiredOption(add, '--kind')).toBe(true);
    expect(isRequiredOption(add, '--rubric')).toBe(true);
    expect(isRequiredOption(add, '--gen')).toBe(true);
    expect(isRequiredOption(add, '--judge')).toBe(true);
    expect(add.options.find((opt) => opt.long === '--gen-command')).toBeTruthy();
    expect(add.options.find((opt) => opt.long === '--judge-command')).toBeTruthy();
    expect(add.options.find((opt) => opt.long === '--expect')).toBeTruthy();
    expect(add.options.find((opt) => opt.long === '--model-hint')).toBeTruthy();
  });
});
