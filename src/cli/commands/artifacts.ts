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
    .description('Provision a private GitHub artifacts repo (<owner>/<repo>-artifacts), push, mirror collaborators, upload blobs')
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
    .description('Show the artifacts repo, its tier (managed/BYO/local), branches, and blob sync state')
    .option('--project <name>', 'Project (defaults to current)')
    .action(withErrorHandler(async (options: { project?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { artifactPaths, getArtifactsRemote, getManagedArtifactsProject } = await import('../../core/artifacts.js');
      const { listLocalBlobs, checkRemoteBlobs } = await import('../../core/artifacts-managed.js');
      const { logger } = await import('../../utils/logger.js');
      const { existsSync } = await import('fs');
      const { join } = await import('path');
      const { execFileSync } = await import('child_process');
      const { repoDir, blobsDir } = artifactPaths(projectDir);
      if (!existsSync(join(repoDir, 'HEAD'))) {
        logger.info(`No artifacts repo yet for '${projectName}' (created on first workspace/capture).`);
        return;
      }
      const remote = await getArtifactsRemote(projectDir);
      const managedProject = await getManagedArtifactsProject(projectDir);
      const tier = managedProject
        ? `managed (${managedProject})`
        : remote ? 'BYO remote' : 'local only';
      logger.info(`Artifacts repo: ${repoDir}`);
      logger.info(`Tier:           ${tier}`);
      logger.info(`Remote:         ${remote ?? '(none — local only)'}`);
      logger.info(`Blob store:     ${blobsDir}${existsSync(blobsDir) ? '' : ' (empty)'}`);
      const blobs = listLocalBlobs(blobsDir);
      const blobBytes = blobs.reduce((sum, b) => sum + b.size, 0);
      logger.info(`Blobs:          ${blobs.length} local (${(blobBytes / (1024 * 1024)).toFixed(1)} MB)`);
      if (managedProject && blobs.length > 0) {
        try {
          const check = await checkRemoteBlobs(projectDir, managedProject);
          logger.info(`Blob sync:      ${check.present}/${check.total} present remotely, ${check.missing} pending upload`);
        } catch (e) {
          logger.dim(`Blob sync:      remote check unavailable (${e instanceof Error ? e.message.split('\n')[0] : e})`);
        }
      }
      const branches = execFileSync('git', ['-C', repoDir, 'branch', '--format=%(refname:short) %(objectname:short) %(subject)'], { encoding: 'utf8' }).trim();
      logger.info(`Branches:\n${branches.split('\n').map((l) => `  ${l}`).join('\n')}`);
    }));

  const managed = cmd.command('managed').description('gitspace.sh-managed artifacts (Tier 2: worker + R2 blob store)');
  managed
    .command('setup')
    .description('Provision (or attach to) managed artifacts on gitspace.sh and wire this project to it')
    .option('--project <name>', 'Project (defaults to current)')
    .option('--attach <handle/slug>', 'Attach to an existing managed artifacts project instead of deriving handle/slug')
    .action(withErrorHandler(async (options: { project?: string; attach?: string }) => {
      const { projectName, projectDir } = await resolveProject(options.project);
      const { getProjectBaseDir } = await import('../../core/config.js');
      const { setupManagedArtifacts, deriveManagedProjectRef, parseManagedProjectRef } = await import('../../core/artifacts-managed.js');
      const { logger } = await import('../../utils/logger.js');
      let ref: string;
      if (options.attach) {
        parseManagedProjectRef(options.attach);
        ref = options.attach;
      } else {
        ref = await deriveManagedProjectRef(projectName);
      }
      const result = await setupManagedArtifacts({
        projectDir,
        baseDir: getProjectBaseDir(projectName),
        project: ref,
      });
      logger.success(`Managed artifacts ready: ${result.project}`);
      logger.info(`Remote: ${result.gitUrl}`);
      logger.info(result.synced ? 'Initial sync complete (branches + blobs).' : 'Initial sync deferred — run: gssh artifacts sync');
      logger.info('.gitspace/artifacts.json written + staged in the base repo — commit it so other machines adopt automatically.');
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
      if (result.blobs) {
        const { uploaded, alreadyPresent, failed, total } = result.blobs;
        logger.info(`Blobs: ${uploaded} uploaded, ${alreadyPresent} already present (${total} total)${failed ? `, ${failed} FAILED` : ''}`);
      }
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
