/**
 * gssh space [context|goal|chain|stack|review|notes|service|hosting|events|bundle]
 *
 * Hidden workspace-scoped command surface. Typical usage inside a workspace is
 * `space review list`, not `gssh space review list`.
 * Context is resolved from GSSH_SPACE_PROJECT / GSSH_SPACE_WORKSPACE when present,
 * and otherwise falls back to detecting the current workspace from the cwd.
 *
 * @module cli/commands/space
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { useSessionContext, getWorkspacePath } from '../workspace-context.js';
import { logger } from '../../utils/logger.js';


function collectRepeated(value: string, previous: string[]): string[] {
  return [...previous, value];
}
function shouldRenderWorkspaceScopedUsage(): boolean {
  const ctx = useSessionContext();
  return !!(ctx?.project && ctx.workspace);
}

function buildSpaceCommandUsage(cmd: Command): string {
  let cmdName = cmd.name();
  const aliases = (cmd as Command & { _aliases?: string[] })._aliases ?? [];
  if (aliases[0]) {
    cmdName = `${cmdName}|${aliases[0]}`;
  }

  let ancestors = '';
  for (let ancestor = cmd.parent; ancestor; ancestor = ancestor.parent) {
    if (ancestor.name() === 'space') {
      ancestors = shouldRenderWorkspaceScopedUsage() ? `space ${ancestors}` : `gssh space ${ancestors}`;
      break;
    }
    ancestors = `${ancestor.name()} ${ancestors}`;
  }

  return `${ancestors}${cmdName} ${cmd.usage()}`.trim();
}

function configureSpaceHelpRecursively(command: Command): void {
  command.configureHelp({
    commandUsage: buildSpaceCommandUsage,
  });
  for (const subcommand of command.commands) {
    configureSpaceHelpRecursively(subcommand);
  }
}

function requireSessionContext(): { project: string; workspace: string } {
  const ctx = useSessionContext();
  if (!ctx || !ctx.project || !ctx.workspace) {
    logger.error('Workspace context is missing.');
    logger.log('Space commands require either a workspace-scoped shell or a cwd inside a GitSpace workspace.');
    process.exit(1);
  }

  return {
    project: ctx.project,
    workspace: ctx.workspace,
  };
}

function collectFilter(value: string, previous: string[] = []): string[] {
  return [...previous, value];
}




export function registerSpaceCommands(parent: Command): void {
  const cmd = parent
    .command('space', { hidden: true })
    .description('Workspace-scoped commands such as `space review list`');

  cmd
    .command('context')
    .description('Show resolved workspace context')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showSpaceContext } = await import('../../commands/review.js');
      await showSpaceContext(options);
    }));

  registerSpaceReviewCommands(cmd);
  registerSpaceGoalCommands(cmd);
  registerSpaceChainCommands(cmd);
  registerSpaceStackCommands(cmd);
  registerSpaceNotesCommands(cmd);
  registerSpaceServiceCommands(cmd);
  registerSpaceHostingCommands(cmd);
  registerSpaceEventsCommands(cmd);
  registerSpaceBundleCommands(cmd);
  registerSpaceJournalCommands(cmd);
  registerSpaceGuideCommands(cmd);
  registerSpaceArtifactsCommands(cmd);
  registerSpaceWorkflowCommands(cmd);
  configureSpaceHelpRecursively(cmd);
}

function registerSpaceWorkflowCommands(space: Command): void {
  const workflow = space
    .command('workflow')
    .description('The workspace’s single canonical workflow spec (*.workflow.json on the artifacts mount)');

  workflow
    .command('validate')
    .description('Validate THE workflow: single spec, slice refs resolve to goal-doc headings, phase names sane. Dangling refs are warnings (exit 0); multiple specs / parse errors fail')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { validateSpaceWorkflow } = await import('../../commands/space-workflow.js');
      validateSpaceWorkflow(ctx, options);
    }));
}

/** '7d' / '24h' / '30m' → ms. */
function parseTtl(ttl: string): number {
  const m = ttl.trim().match(/^(\d+)\s*(m|h|d)$/);
  if (!m) throw new Error(`Invalid --ttl '${ttl}' — use e.g. 30m, 24h, 7d`);
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000);
}

/** Artifact-protocol verbs (docs/ARTIFACT-PROTOCOL.md). */
function registerSpaceArtifactsCommands(space: Command): void {
  const artifacts = space.command('artifacts').description('Workspace artifacts (mount at .gitspace/artifacts)');

  artifacts
    .command('share <relPath>')
    .description('Mint a signed public link for one artifact, served through your relay (requires serve active)')
    .option('--ttl <duration>', 'Link lifetime (30m / 24h / 7d)', '7d')
    .option('--max-uses <n>', 'Optional use cap')
    .option('--live', 'Serve current branch state instead of pinning a point-in-time capture')
    .action(withErrorHandler(async (relPath: string, options: { ttl: string; maxUses?: string; live?: boolean }) => {
      const ctx = requireSessionContext();
      const { send } = await import('../../lib/tmux-lite/cli.js');
      const { formatArtifactUri, parseLocalRef, localScratchRel } = await import('../../core/artifact-cap.js');
      // `local://<rel>` shares point at session scratch. Scratch is uncommitted,
      // so it can only be served LIVE (there is no commit to pin).
      const localRel = parseLocalRef(relPath);
      const mountRel = localRel ? localScratchRel(localRel) : relPath;
      const r = await send({
        type: 'artifact-share-mint',
        uri: formatArtifactUri(ctx.project, ctx.workspace, mountRel),
        ttlMs: parseTtl(options.ttl),
        maxUses: options.maxUses ? Number(options.maxUses) : undefined,
        live: localRel ? true : (options.live || undefined),
      });
      if (r.type === 'error') { logger.error(r.message); process.exit(1); }
      if (r.type !== 'artifact-share-mint') { logger.error('Unexpected response'); process.exit(1); }
      logger.success('Share link (anyone with the URL can read this one file):');
      logger.log(r.url);
      logger.info(`Expires ${new Date(r.expiresAt).toLocaleString()} · revoke: space artifacts share-revoke ${r.tokenId}`);
    }));

  artifacts
    .command('share-list')
    .description('List minted share links (this machine)')
    .action(withErrorHandler(async () => {
      const { send } = await import('../../lib/tmux-lite/cli.js');
      const r = await send({ type: 'artifact-share-list' });
      if (r.type !== 'artifact-share-list') { logger.error(r.type === 'error' ? r.message : 'Unexpected response'); process.exit(1); }
      if (r.shares.length === 0) { logger.info('No share links minted.'); return; }
      for (const sh of r.shares) {
        const state = sh.revokedAt ? 'revoked' : Date.now() > sh.expiresAt ? 'expired' : 'active';
        logger.log(`${sh.tokenId}  ${state.padEnd(7)}  uses ${sh.useCount}${sh.maxUses ? `/${sh.maxUses}` : ''}  ${sh.uri}`);
      }
    }));

  artifacts
    .command('share-revoke <tokenId>')
    .description('Revoke a share link (takes effect on the next request)')
    .action(withErrorHandler(async (tokenId: string) => {
      const { send } = await import('../../lib/tmux-lite/cli.js');
      const r = await send({ type: 'artifact-share-revoke', tokenId });
      if (r.type !== 'artifact-share-revoke') { logger.error(r.type === 'error' ? r.message : 'Unexpected response'); process.exit(1); }
      logger.success(r.revoked ? 'Revoked.' : 'Not found or already revoked.');
    }));

  artifacts
    .command('commit <paths...>')
    .description('Capture files already written in the artifacts mount: pointer split + provenance in one commit')
    .requiredOption('-m, --message <message>', 'Commit message')
    .option('--cap <token>', 'Capability token (from a trigger run prompt) — verified, and the write scope is enforced')
    .action(withErrorHandler(async (paths: string[], options: { message: string; cap?: string }) => {
      const ctx = requireSessionContext();
      const { getProjectDir } = await import('../../core/config.js');
      const { captureArtifacts, artifactsMountDir } = await import('../../core/artifacts.js');
      const { join } = await import('path');
      const projectDir = getProjectDir(ctx.project);
      const mount = artifactsMountDir(join(projectDir, 'workspaces', ctx.workspace));

      let allowedWrites: string[] | undefined;
      let provenance: Record<string, string | undefined> = { tool: 'cli' };
      if (options.cap) {
        const { verifyArtifactCap, capAllows, parseArtifactUri, formatArtifactUri } = await import('../../core/artifact-cap.js');
        const { getOrCreateArtifactCapKeypair } = await import('../../core/artifact-cap-key.js');
        const cap = verifyArtifactCap(options.cap, { publicKey: getOrCreateArtifactCapKeypair().publicKey });
        for (const p of paths) {
          if (!capAllows(cap, 'write', parseArtifactUri(formatArtifactUri(ctx.project, ctx.workspace, p)))) {
            const { SpacesError } = await import('../../types/errors.js');
            throw new SpacesError(`Capability does not permit writing ${p} (scope: ${cap.scope.join(', ')})`, 'USER_ERROR', 1);
          }
        }
        allowedWrites = cap.scope.map((u) => { try { return parseArtifactUri(u).relPath || '**'; } catch { return '(invalid)'; } });
        provenance = { tool: cap.sub.kind, ...(cap.sub.kind === 'trigger' ? { trigger: cap.sub.id } : {}), ...(cap.sub.kind === 'session' ? { session: cap.sub.id } : {}) };
      }
      const result = await captureArtifacts(projectDir, mount, paths.map((p) => ({ path: p, sourceFile: join(mount, p) })), {
        message: options.message,
        provenance,
        allowedWrites,
      });
      logger.success(`Captured ${paths.length} file(s) → ${result.commit.slice(0, 8)}${result.pointers.length ? ` (${result.pointers.length} as LFS pointers)` : ''}`);
    }));

  artifacts
    .command('promote <source> <destRelPath>')
    .description('Promote a working file (e.g. session scratch) into the versioned artifacts tree — the TYPING act')
    .option('-m, --message <message>', 'Commit message')
    .action(withErrorHandler(async (source: string, destRelPath: string, options: { message?: string }) => {
      const ctx = requireSessionContext();
      const { getProjectDir } = await import('../../core/config.js');
      const { captureArtifacts, artifactsMountDir, resolveLocalScratch } = await import('../../core/artifacts.js');
      const { parseLocalRef } = await import('../../core/artifact-cap.js');
      const { join, resolve } = await import('path');
      const { existsSync } = await import('fs');
      const projectDir = getProjectDir(ctx.project);
      const mount = artifactsMountDir(join(projectDir, 'workspaces', ctx.workspace));
      // `local://<rel>` sources resolve to session scratch; anything else is a
      // plain filesystem path.
      const localRel = parseLocalRef(source);
      const src = localRel ? resolveLocalScratch(mount, localRel).absPath : resolve(source);
      if (!existsSync(src)) {
        const { SpacesError } = await import('../../types/errors.js');
        throw new SpacesError(`Source not found: ${source}`, 'USER_ERROR', 1);
      }
      const result = await captureArtifacts(projectDir, mount, [{ path: destRelPath, sourceFile: src }], {
        message: options.message ?? `promote: ${destRelPath}`,
        provenance: { tool: 'promote' },
      });
      logger.success(`Promoted → ${destRelPath} (${result.commit.slice(0, 8)}). It now types as a curated artifact (feeds, rails, precedents).`);
    }));

  artifacts
    .command('scratch-path <rel>')
    .description('Print the absolute path of a local:// session-scratch file (creates the dir); write drafts there, then promote/share by local://<rel>')
    .action(withErrorHandler(async (rel: string) => {
      const ctx = requireSessionContext();
      const { getProjectDir } = await import('../../core/config.js');
      const { artifactsMountDir, resolveLocalScratch } = await import('../../core/artifacts.js');
      const { parseLocalRef } = await import('../../core/artifact-cap.js');
      const { join } = await import('path');
      const inner = parseLocalRef(rel) ?? rel; // accept both `local://x` and bare `x`
      const mount = artifactsMountDir(join(getProjectDir(ctx.project), 'workspaces', ctx.workspace));
      logger.log(resolveLocalScratch(mount, inner).absPath);
    }));

  artifacts
    .command('repair')
    .description('Convert raw large files in never-pushed commits to LFS pointers (fixes publish-gate refusals)')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { getProjectDir } = await import('../../core/config.js');
      const { repairArtifacts, artifactsMountDir, ensureArtifactsRepo } = await import('../../core/artifacts.js');
      const { join } = await import('path');
      const projectDir = getProjectDir(ctx.project);
      await ensureArtifactsRepo(projectDir); // repair relies on the pre-commit converter being current
      const mount = artifactsMountDir(join(projectDir, 'workspaces', ctx.workspace));
      const r = await repairArtifacts(projectDir, mount);
      if (r.repaired === 0) {
        logger.info('Nothing to repair — no raw large files in unpushed commits.');
        return;
      }
      logger.success(`Repaired: squashed ${r.repaired} commit(s) into ${r.commit?.slice(0, 8)} with pointer conversion.`);
      logger.info('Sync will push this branch on its next 5-minute tick.');
    }));
}



function registerSpaceJournalCommands(space: Command): void {
  const journal = space
    .command('journal')
    .description('Phase-boundary journal: narrative from the agent, state snapshots from the system');

  journal
    .command('phase-start')
    .description('Open a phase: record intent + snapshot goal/workflow/review state')
    .requiredOption('--phase <name>', 'Workflow phase name')
    .requiredOption('--intent <text>', 'What this phase intends to do and why')
    .option('--workflow-ref <ref>', 'Workflow spec reference, e.g. parity.workflow.json#phases[1]')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { journalPhaseStart } = await import('../../commands/space-journal.js');
      await journalPhaseStart(ctx, { phase: options.phase, intent: options.intent, workflowRef: options.workflowRef, json: options.json });
    }));

  journal
    .command('phase-end')
    .description('Close the open phase: record outcome, compute delta, auto-commit the repo. Blocked while the phase’s gate has owed requirements not accepted (escape: --revert; gate waives are human-only, via the UI)')
    .option('--outcome <text>', 'What actually happened (required unless --revert)')
    .option('--decision <text...>', 'Notable decision (repeatable)')
    .option('--surprise <text...>', 'Something unexpected (repeatable)')
    .option('--revert', 'Close WITHOUT satisfying the gate, marked reverted — the contract needs rewriting; the workflow returns to an earlier phase (default plan)')
    .option('--reason <text>', 'Why the phase is being reverted (required with --revert)')
    .option('--to <phase>', 'Phase the revert returns to (default: plan)')
    .option('--no-commit', 'Skip the phase-boundary auto-commit')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { journalPhaseEnd } = await import('../../commands/space-journal.js');
      await journalPhaseEnd(ctx, {
        outcome: options.outcome,
        decision: options.decision,
        surprise: options.surprise,
        noCommit: options.commit === false,
        revert: options.revert,
        reason: options.reason,
        to: options.to,
        json: options.json,
      });
    }));

  journal
    .command('status')
    .description('Show the open phase, if any')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { journalStatus } = await import('../../commands/space-journal.js');
      journalStatus(ctx, options);
    }));
}

function registerSpaceGuideCommands(space: Command): void {
  const guide = space
    .command('guide')
    .description('Review guide: analyzer worksheet + validated narrator submission');

  guide
    .command('analyze')
    .description('Build the narrator worksheet (clusters, grounding, staleness) and commit it')
    .option('--base <ref>', 'Base ref to diff against (default: project base branch)')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { guideAnalyze } = await import('../../commands/space-guide.js');
      await guideAnalyze(ctx, options);
    }));

  guide
    .command('submit')
    .description('Validate and commit narrated sections (merges cached sections for unchanged clusters)')
    .requiredOption('--file <path>', 'JSON file: { headSha, sections[], specEvolution? }')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { guideSubmit } = await import('../../commands/space-guide.js');
      await guideSubmit(ctx, options);
    }));

  guide
    .command('show')
    .description('Show the committed guide')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { guideShow } = await import('../../commands/space-guide.js');
      guideShow(ctx, options);
    }));
}

function registerSpaceGoalCommands(space: Command): void {
  const goal = space
    .command('goal')
    .description('Author goal doc, declare validation contract, and judge requirements');

  goal
    .command('show')
    .description('Show the current goal document')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceGoal } = await import('../../commands/space-goals.js');
      showSpaceGoal(ctx, options);
    }));

  goal
    .command('set')
    .description('Replace the current goal document')
    .option('--file <path>', 'Read goal markdown from file')
    .option('--stdin', 'Read goal markdown from stdin')
    .option('--body <text>', 'Goal markdown body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { setSpaceGoal } = await import('../../commands/space-goals.js');
      setSpaceGoal(ctx, options);
    }));

  goal
    .command('edit')
    .description('Edit the current goal document with EDITOR')
    .option('--editor <command>', 'Editor command')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { editSpaceGoal } = await import('../../commands/space-goals.js');
      editSpaceGoal(ctx, options);
    }));

  const doc = goal
    .command('doc')
    .description('Goal document structure (heading-anchored slices)');

  doc
    .command('slices')
    .description('List slice ids (slugified headings) parsed from the goal doc — the ids --slice and workflow phases reference')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { listSpaceGoalDocSlices } = await import('../../commands/space-goals.js');
      listSpaceGoalDocSlices(ctx, options);
    }));

  goal
    .command('status')
    .description('Show validation readiness for this goal')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceGoalStatus } = await import('../../commands/space-goals.js');
      showSpaceGoalStatus(ctx, options);
    }));

  const requirement = goal
    .command('requirement')
    .description('Declare artifact requirements; each requirement owns its rubric, generation, and judgment');

  requirement
    .command('add')
    .description('Declare an artifact requirement on the validation contract')
    .requiredOption('--title <title>', 'Requirement title (e.g. "Screenshot showing the hover state")')
    .requiredOption('--kind <kind>', 'Artifact kind: screenshot, video, test-output, note, file, url')
    .requiredOption('--rubric <text>', 'Acceptance criteria: what makes this evidence acceptable')
    .requiredOption('--gen <kind>', 'Generation: manual | command')
    .option('--gen-command <command>', 'Command to run when --gen=command')
    .requiredOption('--judge <kind>', 'Judgment: human | llm | command')
    .option('--judge-command <command>', 'Judgment command when --judge=command')
    .option('--expect <kind>', 'Command expectation: exit-zero | stdout-contains | stderr-empty | output-matches', 'exit-zero')
    .option('--expect-needle <text>', 'Required substring when --expect=stdout-contains')
    .option('--expect-pattern <regex>', 'Required regex when --expect=output-matches')
    .option('--model-hint <name>', 'Preferred LLM model when --judge=llm')
    .option('--optional', 'Mark the requirement optional (default: required)')
    .option('--slice <sliceId>', 'Goal-doc slice this requirement grounds in (see `space goal doc slices`; dangling ids warn, never fail)')
    .option('--phase <name>', 'Workflow phase that OWES this requirement — its gate blocks phase-end until acceptance (unknown names warn)')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      addSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('update')
    .description('Update an existing requirement on the validation contract')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--title <title>', 'New requirement title')
    .option('--kind <kind>', 'Artifact kind: screenshot, video, test-output, note, file, url')
    .option('--rubric <text>', 'Acceptance criteria')
    .option('--gen <kind>', 'Generation: manual | command')
    .option('--gen-command <command>', 'Command to run when --gen=command')
    .option('--judge <kind>', 'Judgment: human | llm | command')
    .option('--judge-command <command>', 'Judgment command when --judge=command')
    .option('--expect <kind>', 'Command expectation: exit-zero | stdout-contains | stderr-empty | output-matches')
    .option('--expect-needle <text>', 'Required substring when --expect=stdout-contains')
    .option('--expect-pattern <regex>', 'Required regex when --expect=output-matches')
    .option('--model-hint <name>', 'Preferred LLM model when --judge=llm')
    .option('--required', 'Mark the requirement required')
    .option('--optional', 'Mark the requirement optional')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { updateSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      updateSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('remove')
    .description('Remove an artifact requirement from this goal')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { removeSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      removeSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('list')
    .description('List artifact requirements on this goal')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { listSpaceGoalRequirements } = await import('../../commands/space-goals.js');
      listSpaceGoalRequirements(ctx, options);
    }));

  requirement
    .command('reorder')
    .description('Move an artifact requirement to a specific position (0-indexed)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .requiredOption('--position <index>', '0-indexed target position', (v) => parseInt(v, 10))
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { reorderSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      reorderSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('verdict')
    .description('Record an accept/reject verdict against the rubric (llm/human-judged requirements — in-phase judging; command-judged use `review run`)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--accept', 'The evidence satisfies the rubric — status becomes accepted (what phase gates count)')
    .option('--reject', 'The evidence does not satisfy the rubric — status stays review')
    .requiredOption('--notes <text>', 'Grounding for the verdict (what was examined, against which rubric line)')
    .option('--created-by <name>', 'Reviewer identity label')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { verdictSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      verdictSpaceGoalRequirement(ctx, options);
    }));

  requirement
    .command('reopen')
    .description('Reopen a requirement for re-review (sets status back to review)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { reopenSpaceGoalRequirement } = await import('../../commands/space-goals.js');
      reopenSpaceGoalRequirement(ctx, options);
    }));

  const artifact = goal
    .command('artifact')
    .description('Attach or generate artifacts that fulfill a requirement');

  artifact
    .command('attach')
    .description('Attach an artifact manually against a declared requirement')
    .requiredOption('--requirement <requirement>', 'Requirement id or title to fulfill')
    .option('--name <label>', 'Display label for the attached artifact')
    .option('--body <text>', 'Inline body (for note evidence)')
    .option('--file <path>', 'Read body from file')
    .option('--stdin', 'Read body from stdin')
    .option('--path <path>', 'Local path to a file/screenshot/video')
    .option('--url <url>', 'URL reference (for url requirements)')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { attachSpaceGoalEvidence } = await import('../../commands/space-goals.js');
      attachSpaceGoalEvidence(ctx, options);
    }));

  artifact
    .command('run')
    .description('Run the requirement\u2019s configured generation command to produce evidence')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { runSpaceGoalGeneration } = await import('../../commands/space-goals.js');
      runSpaceGoalGeneration(ctx, options);
    }));

  const review = goal
    .command('review')
    .description('Judge a requirement against its rubric (record human review or run command/LLM judgment)');

  review
    .command('run')
    .description('Run the requirement\u2019s configured judgment (command or LLM)')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { runSpaceGoalJudgment } = await import('../../commands/space-goals.js');
      runSpaceGoalJudgment(ctx, options);
    }));

  review
    .command('record')
    .description('Record a human review decision for a requirement')
    .requiredOption('--requirement <requirement>', 'Requirement id or title')
    .requiredOption('--decision <decision>', 'pass | changes | fail')
    .option('--body <text>', 'Review note')
    .option('--file <path>', 'Read note from file')
    .option('--stdin', 'Read note from stdin')
    .option('--score <n>', 'Judgement score 0-100')
    .option('--created-by <name>', 'Reviewer identity label')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { recordSpaceGoalHumanReview } = await import('../../commands/space-goals.js');
      recordSpaceGoalHumanReview(ctx, { ...options, score: options.score !== undefined ? Number(options.score) : undefined });
    }));
}

function registerSpaceChainCommands(space: Command): void {
  const chain = space
    .command('chain')
    .description('Manage this space linear goal chain');

  chain
    .command('show')
    .description('Show this goal chain')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceChain } = await import('../../commands/space-goals.js');
      showSpaceChain(ctx, options);
    }));

  chain
    .command('add-after')
    .description('Add a planned goal after the current workspace goal')
    .requiredOption('--title <title>', 'Goal title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceChainGoal } = await import('../../commands/space-goals.js');
      addSpaceChainGoal(ctx, options.title, 'after', options);
    }));

  chain
    .command('add-before')
    .description('Add a planned goal before the current workspace goal')
    .requiredOption('--title <title>', 'Goal title')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { addSpaceChainGoal } = await import('../../commands/space-goals.js');
      addSpaceChainGoal(ctx, options.title, 'before', options);
    }));

  chain
    .command('move-before')
    .description('Move the current goal before another goal in the current project')
    .argument('<target>', 'Goal id, workspace name, planned workspace name, or title to move before')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title to move (defaults to current workspace goal)')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (targetToken, options) => {
      const ctx = requireSessionContext();
      const { moveSpaceChainGoal } = await import('../../commands/space-goals.js');
      moveSpaceChainGoal(ctx, options.goal ?? ctx.workspace, targetToken, 'before', options);
    }));

  chain
    .command('move-after')
    .description('Move the current goal after another goal in the current project')
    .argument('<target>', 'Goal id, workspace name, planned workspace name, or title to move after')
    .option('--goal <goal>', 'Goal id, workspace name, planned workspace name, or title to move (defaults to current workspace goal)')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (targetToken, options) => {
      const ctx = requireSessionContext();
      const { moveSpaceChainGoal } = await import('../../commands/space-goals.js');
      moveSpaceChainGoal(ctx, options.goal ?? ctx.workspace, targetToken, 'after', options);
    }));

  chain
    .command('create-workspace')
    .description('Create a workspace for a planned goal')
    .option('--goal <goal>', 'Goal id, planned workspace name, or title (defaults to current goal)')
    .option('--name <workspace>', 'Workspace name')
    .option('--branch <branch>', 'Branch name')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { createSpaceChainWorkspace } = await import('../../commands/space-goals.js');
      await createSpaceChainWorkspace(ctx, options);
    }));
}

function registerSpaceStackCommands(space: Command): void {
  const stack = space
    .command('stack')
    .description('Validate this space git stack');

  stack
    .command('status')
    .description('Show adjacent goal workspace ancestry status')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showSpaceStackStatus } = await import('../../commands/space-goals.js');
      showSpaceStackStatus(ctx, options);
    }));
}

function registerSpaceNotesCommands(space: Command): void {
  const notes = space
    .command('notes')
    .description('Manage local workspace notes and todos');

  notes
    .command('list')
    .description('List workspace notes')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { listNotes } = await import('../../commands/notes.js');
      await listNotes(options);
    }));

  notes
    .command('add')
    .description('Add a workspace note')
    .option('--body <text>', 'Note body')
    .option('--stdin', 'Read note body from stdin')
    .option('--todo', 'Add as todo')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { addNote } = await import('../../commands/notes.js');
      await addNote(options);
    }));

  notes
    .command('update')
    .description('Update a workspace note')
    .requiredOption('--id <id>', 'Note id')
    .option('--body <text>', 'New body')
    .option('--todo', 'Convert to todo')
    .option('--note', 'Convert to note')
    .option('--priority <priority>', 'Todo priority: low, medium, high')
    .option('--done', 'Mark todo done')
    .option('--undone', 'Mark todo open')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { updateNote } = await import('../../commands/notes.js');
      await updateNote(options);
    }));

  notes
    .command('remove')
    .description('Remove a workspace note')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { removeNote } = await import('../../commands/notes.js');
      await removeNote(options);
    }));

  notes
    .command('done')
    .description('Mark a todo done')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { markNoteDone } = await import('../../commands/notes.js');
      await markNoteDone(options);
    }));

  notes
    .command('undone')
    .description('Mark a todo open')
    .requiredOption('--id <id>', 'Note id')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { markNoteUndone } = await import('../../commands/notes.js');
      await markNoteUndone(options);
    }));
}

function registerSpaceReviewCommands(space: Command): void {
  const review = space
    .command('review')
    .description('Diff review system');

  review
    .command('list')
    .description('Print review threads as structured JSON')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { showReviewList } = await import('../../commands/review.js');
      await showReviewList(options);
    }));

  review
    .command('import')
    .description('Import GitHub PR review comments as local threads')
    .option('--pr <number>', 'PR number to import from', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { importReview } = await import('../../commands/review.js');
      await importReview(options);
    }));

  review
    .command('push')
    .description('Push local review decisions to GitHub as a formal PR review')
    .option('--pr <number>', 'PR number to submit review on', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      requireSessionContext();
      const { pushReview } = await import('../../commands/review.js');
      await pushReview(options);
    }));

  review
    .command('hunks')
    .description('List hunks in a changed file')
    .argument('<file>', 'File path')
    .option('--format <format>', 'Output format: json (default) or text')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { listReviewHunks } = await import('../../commands/review.js');
      await listReviewHunks(file, options);
    }));

  review
    .command('add-hunk')
    .description('Add or update hunk review by hunk index')
    .argument('<file>', 'File path')
    .requiredOption('--index <number>', '1-based hunk index', (v: string) => parseInt(v, 10))
    .option('--body <text>', 'Optional comment body')
    .option('--approve', 'Set hunk decision to approved')
    .option('--reject', 'Set hunk decision to rejected')
    .option('--pending', 'Set hunk decision to pending')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addHunkReview } = await import('../../commands/review.js');
      await addHunkReview(file, options);
    }));

  review
    .command('add-file')
    .description('Add a file-level review thread')
    .argument('<file>', 'File path')
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addFileReview } = await import('../../commands/review.js');
      await addFileReview(file, options);
    }));

  review
    .command('add-line')
    .description('Add a line-range review thread')
    .argument('<file>', 'File path')
    .requiredOption('--start <number>', '1-based start line', (v: string) => parseInt(v, 10))
    .option('--end <number>', '1-based end line (defaults to start)', (v: string) => parseInt(v, 10))
    .option('--side <side>', 'LEFT or RIGHT side of diff (default: RIGHT)')
    .requiredOption('--body <text>', 'Comment body')
    .option('--json', 'Output structured JSON')
    .action(withErrorHandler(async (file, options) => {
      requireSessionContext();
      const { addLineReview } = await import('../../commands/review.js');
      await addLineReview(file, options);
    }));
}

function registerSpaceServiceCommands(space: Command): void {
  const service = space
    .command('service')
    .description('Manage workspace services');

  service
    .command('list')
    .description('List configured services')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { listProcesses } = await import('../../commands/process.js');
      await listProcesses({ workspace: getWorkspacePath(ctx.project, ctx.workspace) });
    }));

  service
    .command('start')
    .description('Start a service by name')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { startProcess } = await import('../../commands/process.js');
      await startProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('stop')
    .description('Stop a service by name')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { stopProcess } = await import('../../commands/process.js');
      await stopProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('attach')
    .description('Show attach hint for service')
    .requiredOption('--name <name>', 'Service name')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { attachProcess } = await import('../../commands/process.js');
      await attachProcess({ workspace: getWorkspacePath(ctx.project, ctx.workspace), name: options.name });
    }));

  service
    .command('open')
    .description('Open service HTTP ports in the browser')
    .requiredOption('--name <name>', 'Service name')
    .option('--port <name-or-number>', 'Open a specific HTTP port by name or number')
    .option('--all', 'Open all HTTP ports for this service')
    .option('--local', 'Prefer local localhost URLs')
    .option('--remote', 'Require hosted URLs')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { openProcess } = await import('../../commands/process.js');
      await openProcess({
        workspace: getWorkspacePath(ctx.project, ctx.workspace),
        name: options.name,
        port: options.port,
        all: options.all,
        local: options.local,
        remote: options.remote,
      });
    }));
}

function registerSpaceHostingCommands(space: Command): void {
  const hosting = space
    .command('hosting')
    .description('Configure tmux-lite service hosting');

  hosting
    .command('status')
    .description('Show tmux-lite hosting status')
    .action(withErrorHandler(async () => {
      const { statusTmuxHosting } = await import('../../commands/tmux.js');
      await statusTmuxHosting();
    }));

  hosting
    .command('select')
    .description('Select the base host used for tmux-lite service hosting')
    .argument('[host]', 'Hosting base host, reserved name, or reserved .serve name')
    .action(withErrorHandler(async (host) => {
      const { selectTmuxHosting } = await import('../../commands/tmux.js');
      await selectTmuxHosting(host);
    }));

  hosting
    .command('set-name')
    .description('Set the machine name used in hosted service routes')
    .argument('<name>', 'Machine name')
    .action(withErrorHandler(async (name) => {
      const { setTmuxHostingMachineName } = await import('../../commands/tmux.js');
      await setTmuxHostingMachineName(name);
    }));

  hosting
    .command('enable')
    .description('Enable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { enableTmuxHosting } = await import('../../commands/tmux.js');
      await enableTmuxHosting();
    }));

  hosting
    .command('disable')
    .description('Disable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { disableTmuxHosting } = await import('../../commands/tmux.js');
      await disableTmuxHosting();
    }));

  hosting
    .command('clear')
    .description('Clear tmux-lite hosting configuration')
    .action(withErrorHandler(async () => {
      const { clearTmuxHosting } = await import('../../commands/tmux.js');
      await clearTmuxHosting();
    }));
}

function registerSpaceEventsCommands(space: Command): void {
  const events = space
    .command('events')
    .description('Query workspace event logs');

  events
    .command('list')
    .description('List events (NDJSON)')
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 100)
    .option('--process <name>', 'Filter by process name')
    .option('--level <level>', 'Filter by event level')
    .option('--event <name>', 'Filter by event name')
    .option('--event-id <id>', 'Filter by event id')
    .option('--correlation-id <id>', 'Filter by correlation id')
    .option('--since <time>', 'Filter since duration (30m, 2h) or ISO timestamp')
    .option('--until <time>', 'Filter until duration (30m, 2h) or ISO timestamp')
    .option('--head [n]', 'Show oldest matching events', (v: string | undefined) => v === undefined ? 100 : Number(v))
    .option('--tail [n]', 'Show newest matching events', (v: string | undefined) => v === undefined ? 100 : Number(v))
    .option('--order <order>', 'Sort order: asc or desc')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { listEvents } = await import('../../commands/events.js');
      await listEvents({ ...options, ...ctx });
    }));

  events
    .command('show')
    .description('Show a single event by eventId')
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--event-id <id>', 'Event id')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { showEvent } = await import('../../commands/events.js');
      await showEvent({ ...options, ...ctx });
    }));

  events
    .command('tail')
    .description('Tail recent events')
    .option('--filter <expr>', 'Filter in key=value format (repeatable)', collectFilter, [])
    .option('--limit <n>', 'Limit results', (v: string) => Number(v), 50)
    .option('--process <name>', 'Filter by process name')
    .option('--level <level>', 'Filter by event level')
    .option('--event <name>', 'Filter by event name')
    .option('--event-id <id>', 'Filter by event id')
    .option('--correlation-id <id>', 'Filter by correlation id')
    .option('--since <time>', 'Filter since duration (30m, 2h) or ISO timestamp')
    .option('--until <time>', 'Filter until duration (30m, 2h) or ISO timestamp')
    .option('--follow', 'Continue streaming new events')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { tailEvents } = await import('../../commands/events.js');
      await tailEvents({ ...options, ...ctx });
    }));
}

function registerSpaceBundleCommands(space: Command): void {
  const bundle = space
    .command('bundle')
    .description('Manage workspace bundle configuration');

  bundle
    .command('refresh')
    .description('Re-run bundle onboarding for this workspace')
    .option('--force', 'Force refresh even if no changes detected')
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { bundleRefresh } = await import('../../commands/bundle.js');
      await bundleRefresh({
        project: ctx.project,
        workspace: ctx.workspace,
        force: options.force,
      });
    }));

  bundle
    .command('status')
    .description('Show bundle status for this workspace')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { bundleStatus } = await import('../../commands/bundle.js');
      await bundleStatus({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  bundle
    .command('show')
    .description('Show current bundle values, secret set-status, and confirm status')
    .action(withErrorHandler(async () => {
      const ctx = requireSessionContext();
      const { bundleShow } = await import('../../commands/bundle.js');
      await bundleShow({
        project: ctx.project,
        workspace: ctx.workspace,
      });
    }));

  bundle
    .command('edit')
    .description('Update bundle inputs, secrets, and confirm states')
    .option('--input <key=value>', 'Set a non-secret input value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--secret <key>', 'Prompt for a secret key value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--secret-unset <key>', 'Unset a secret key value (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .option('--confirm <id=status>', 'Set confirm status to passed|skipped (repeatable)', (value: string, previous: string[] = []) => {
      previous.push(value);
      return previous;
    })
    .action(withErrorHandler(async (options) => {
      const ctx = requireSessionContext();
      const { bundleEdit } = await import('../../commands/bundle.js');
      await bundleEdit({
        project: ctx.project,
        workspace: ctx.workspace,
        input: options.input,
        secret: options.secret,
        secretUnset: options.secretUnset,
        confirm: options.confirm,
      });
    }));
}
