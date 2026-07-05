/**
 * Artifacts FS commands (docs/ARTIFACTS-FS.md).
 *
 * @module cli/commands/artifacts
 */
import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

async function resolveProject(explicit?: string): Promise<{ projectName: string; projectDir: string }> {
  const { getCurrentProject, getProjectDir, projectExists } = await import('../../core/config.js');
  const { SpacesError } = await import('../../types/errors.js');
  const projectName = explicit?.trim() || getCurrentProject() || '';
  if (!projectName || !projectExists(projectName)) {
    throw new SpacesError(explicit ? `Unknown project: ${explicit}` : 'No current project (use --project).', 'USER_ERROR', 1);
  }
  return { projectName, projectDir: getProjectDir(projectName) };
}

export function registerArtifactsCommands(program: Command): void {
  const cmd = program
    .command('artifacts')
    .description('Project artifacts repo (branch per workspace, roll-up to main)');

  cmd
    .command('status')
    .description('Show the artifacts repo, its branches, and remote')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (options: { project?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { artifactPaths, getArtifactsRemote } = await import('../../core/artifacts.js');
      const { logger } = await import('../../utils/logger.js');
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const { execFileSync } = await import('child_process');
      const { repoDir, blobsDir } = artifactPaths(projectDir);
      if (!existsSync(join(repoDir, 'HEAD'))) {
        logger.info(`No artifacts repo yet for '${projectName}' (created on first workspace/capture).`);
        return;
      }
      logger.info(`Artifacts repo: ${repoDir}`);
      logger.info(`Blob store:     ${blobsDir}${existsSync(blobsDir) ? '' : ' (empty)'}`);
      const remote = await getArtifactsRemote(projectDir);
      logger.info(`Remote:         ${remote ?? '(none — local only)'}`);
      const branches = execFileSync('git', ['-C', repoDir, 'branch', '--format=%(refname:short) %(objectname:short) %(subject)'], { encoding: 'utf8' }).trim();
      logger.info(`Branches:\n${branches.split('\n').map((l) => `  ${l}`).join('\n')}`);
    }));

  const remote = cmd.command('remote').description('Manage the artifacts remote (BYO git URL)');
  remote
    .command('add <url>')
    .description('Attach a git remote for the artifacts repo and record it in .gitspace/artifacts.json')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (url: string, options: { project?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { setArtifactsRemote, writeArtifactsPointerConfig } = await import('../../core/artifacts.js');
      const { getProjectBaseDir } = await import('../../core/config.js');
      const { logger } = await import('../../utils/logger.js');
      await setArtifactsRemote(projectDir, url);
      await writeArtifactsPointerConfig(getProjectBaseDir(projectName), { remote: url });
      logger.success(`Artifacts remote set: ${url}`);
      logger.info('.gitspace/artifacts.json written + staged in the base repo — commit it so clones rediscover the remote.');
      logger.info('Sync with: gssh artifacts sync');
    }));

  cmd
    .command('sync')
    .description('Fetch + fast-forward main, then push all artifact branches to the remote')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (options: { project?: string }) => {
      const { projectDir } = await resolveProject(options.project);
      const { syncArtifacts } = await import('../../core/artifacts.js');
      const { logger } = await import('../../utils/logger.js');
      const result = await syncArtifacts(projectDir);
      logger.success(`Synced (main ${result.fastForwarded ? 'fast-forwarded' : 'unchanged/none'}, all branches pushed).`);
    }));

  cmd
    .command('rollup <workspace>')
    .description("Merge a workspace's artifacts branch into main (curation happens at the merge)")
    .option('--project <name>', 'Project (defaults to current)')
    .option('--remove-branch', 'Delete the workspace branch after a clean merge')
    .action(withErrorHandler(async (workspace: string, options: { project?: string; removeBranch?: boolean }) => {
      const { projectDir } = await resolveProject(options.project);
      const { rollupArtifacts } = await import('../../core/artifacts.js');
      const { logger } = await import('../../utils/logger.js');
      const { mergeCommit } = await rollupArtifacts(projectDir, workspace, { removeBranch: options.removeBranch });
      logger.success(`Rolled up '${workspace}' into main (${mergeCommit.slice(0, 8)}).`);
    }));
}
