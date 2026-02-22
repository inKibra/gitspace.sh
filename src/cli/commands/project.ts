/**
 * gssh project list|add|remove
 *
 * @module cli/commands/project
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerProjectCommands(parent: Command): void {
  const cmd = parent
    .command('project')
    .description('Manage projects');

  // gssh project list
  cmd
    .command('list')
    .description('List all projects')
    .option('--json', 'Output in JSON format')
    .option('--verbose', 'Show additional details')
    .action(withErrorHandler(async (options) => {
      const { listProjects } = await import('../../commands/list.js');
      await listProjects(options);
    }));

  // gssh project add
  cmd
    .command('add')
    .description('Add a new project from GitHub')
    .option('--no-clone', 'Create project structure without cloning')
    .option('--org <org>', 'Filter repos to specific organization')
    .option('--linear-key <key>', 'Provide Linear API key via flag')
    .option('--bundle-url <url>', 'Load bundle from remote URL (zip archive)')
    .option('--bundle-path <path>', 'Load bundle from local directory')
    .option('--skip-bundle', 'Skip bundle detection and onboarding')
    .action(withErrorHandler(async (options) => {
      const { addProject } = await import('../../commands/add.js');
      await addProject(options);
    }));

  // gssh project remove [name]
  cmd
    .command('remove')
    .description('Remove a project')
    .argument('[project-name]', 'Name of the project to remove')
    .option('--force', 'Skip confirmation prompts')
    .action(withErrorHandler(async (projectName, options) => {
      const { removeProject } = await import('../../commands/remove.js');
      await removeProject(projectName, options);
    }));
}
