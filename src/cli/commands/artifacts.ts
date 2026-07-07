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
    .command('provision')
    .description('Provision a private GitHub artifacts repo (<owner>/<repo>-artifacts), push, mirror collaborators, upload large files to GitHub LFS')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (options: { project?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { provisionGithubArtifacts } = await import('../../core/artifacts-github.js');
      const { getProjectBaseDir } = await import('../../core/config.js');
      const { logger } = await import('../../utils/logger.js');
      const r = await provisionGithubArtifacts(projectName, projectDir, getProjectBaseDir(projectName));
      logger.success(`${r.created ? 'Created' : 'Reusing'} ${r.slug}`);
      logger.info(`remote: ${r.url}`);
      logger.info(`pushed: ${r.pushed} · blobs uploaded: ${r.blobsUploaded} · collaborators mirrored: ${r.collaboratorsCopied}`);
      logger.info('Pointer committed to the code repo — other machines and teammates adopt it automatically.');
    }));

  cmd
    .command('status')
    .description('Show the artifacts repo, its tier (GitHub/BYO/local), branches, and blob state')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (options: { project?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { artifactPaths, getArtifactsRemote } = await import('../../core/artifacts.js');
      const { slugFromRemote } = await import('../../core/artifacts-github.js');
      const { logger } = await import('../../utils/logger.js');
      const { existsSync, readdirSync, statSync } = await import('fs');
      const { join } = await import('path');
      const { execFileSync } = await import('child_process');
      const { repoDir, blobsDir } = artifactPaths(projectDir);
      if (!existsSync(join(repoDir, 'HEAD'))) {
        logger.info(`No artifacts repo yet for '${projectName}' (created on first workspace/capture).`);
        return;
      }
      const remote = await getArtifactsRemote(projectDir);
      const slug = slugFromRemote(remote);
      const tier = slug ? `GitHub (${slug} — blobs via GitHub LFS)` : remote ? 'BYO remote (branches only; blobs stay local)' : 'local only';
      logger.info(`Artifacts repo: ${repoDir}`);
      logger.info(`Tier:           ${tier}`);
      logger.info(`Remote:         ${remote ?? '(none — local only)'}`);
      logger.info(`Blob store:     ${blobsDir}${existsSync(blobsDir) ? '' : ' (empty)'}`);
      let blobCount = 0;
      let blobBytes = 0;
      if (existsSync(blobsDir)) {
        for (const shard of readdirSync(blobsDir)) {
          const shardDir = join(blobsDir, shard);
          try {
            for (const oid of readdirSync(shardDir)) {
              blobCount += 1;
              blobBytes += statSync(join(shardDir, oid)).size;
            }
          } catch { /* not a dir */ }
        }
      }
      logger.info(`Blobs:          ${blobCount} local (${(blobBytes / (1024 * 1024)).toFixed(1)} MB)`);
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
      const { getArtifactsRemote } = await import('../../core/artifacts.js');
      const { slugFromRemote, syncGithubArtifacts } = await import('../../core/artifacts-github.js');
      if (slugFromRemote(await getArtifactsRemote(projectDir))) {
        const r = await syncGithubArtifacts(projectDir);
        logger.success(`Synced (branches pushed: ${r.pushed}, blobs uploaded to GitHub LFS: ${r.blobsUploaded}).`);
        return;
      }
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
