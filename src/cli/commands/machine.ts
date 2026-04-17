/**
 * gssh machine serve|enroll|tmux
 *
 * Machine-side commands for daemon management, remote access, and terminal sessions.
 *
 * @module cli/commands/machine
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';
import { configureTmuxSandbox } from '../tmux-sandbox.js';
import { getTmuxLiteSandbox } from '../../lib/tmux-lite/protocol.js';

export function registerMachineCommands(parent: Command): void {
  const cmd = parent
    .command('machine')
    .description('Manage this machine as a remote-accessible host');

  // --------------------------------------------------------------------------
  // gssh machine serve [start|stop|status]
  // --------------------------------------------------------------------------
  registerMachineServeCommands(cmd);

  // --------------------------------------------------------------------------
  // gssh machine enroll --invite <token> [--label <name>]
  // --------------------------------------------------------------------------
  cmd
    .command('enroll')
    .description('Enroll this machine with a relay-machine invite token')
    .requiredOption('--invite <token>', 'Root-signed relay-machine invite token (or relay URL with #token)')
    .option('--label <name>', 'Human-readable machine label')
    .action(withErrorHandler(async (options) => {
      const { enrollMachine } = await import('../../commands/machine-enroll.js');
      await enrollMachine(options);
    }));

  // --------------------------------------------------------------------------
  // gssh machine tmux [start|stop|status|list|new|attach|kill|replay|hosting]
  // --------------------------------------------------------------------------
  registerMachineTmuxCommands(cmd);
}

// ============================================================================
// Serve
// ============================================================================

function registerMachineServeCommands(machine: Command): void {
  const serve = machine
    .command('serve')
    .description('Manage remote access daemon');

  // gssh machine serve start
  serve
    .command('start')
    .description('Start the serve daemon (auto-select relay when omitted)')
    .option('--relay <url>', 'Override default relay URL')
    .option('--relay-pubkey <pubkey>', 'Relay public key for explicit trust (base64)')
    .option('--bootstrap-token <token>', 'One-time bootstrap token for cloud machine registration')
    .option('--enrollment-token <token>', 'One-time relay-machine invite token for machine registration')
    .option('--unlock-token <token>', 'One-time token to request unlock grant from relay')
    .option('--workspace-id <id>', 'Cloud workspace id for unlock-token flow')
    .option('--ignore-keychain-and-skip-secrets', 'Skip keychain preload and skip secret-dependent scripts')
    .option('--takeover', 'Reclaim this machine for the current identity: clear persisted relay control state and forget any stale trust pin for the target relay so we can rebind. Use when recovering from mismatched ownership or trust pins.')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--password-stdin', 'Read password from stdin')
    .option('--foreground', "Run in foreground (don't daemonize)")
    .action(withErrorHandler(async (options) => {
      const { serveStart } = await import('../../commands/serve.js');
      await serveStart(options);
    }));

  // gssh machine serve stop
  serve
    .command('stop')
    .description('Stop the serve daemon')
    .action(withErrorHandler(async () => {
      const { serveStop } = await import('../../commands/serve.js');
      await serveStop();
    }, { skipSetupCheck: true }));

  // gssh machine serve status
  serve
    .command('status')
    .description('Show serve daemon status')
    .action(withErrorHandler(async () => {
      const { serveStatus } = await import('../../commands/serve.js');
      await serveStatus();
    }, { skipSetupCheck: true }));

}

// ============================================================================
// Tmux
// ============================================================================

function registerMachineTmuxCommands(machine: Command): void {
  const tmux = machine
    .command('tmux')
    .description('Manage tmux-lite terminal session daemon');
  configureTmuxSandbox(tmux);

  tmux
    .command('start')
    .description('Start the tmux-lite server daemon')
    .action(withErrorHandler(async () => {
      const { startTmux } = await import('../../commands/tmux.js');
      await startTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('stop')
    .description('Stop the tmux-lite server daemon')
    .option('--force', 'Stop even if sessions are active')
    .action(withErrorHandler(async (options) => {
      const { stopTmux } = await import('../../commands/tmux.js');
      await stopTmux({ force: options.force });
    }, { skipSetupCheck: true }));

  tmux
    .command('status')
    .description('Show tmux-lite server status')
    .action(withErrorHandler(async () => {
      const { statusTmux } = await import('../../commands/tmux.js');
      await statusTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('list')
    .description('List active tmux-lite sessions')
    .action(withErrorHandler(async () => {
      const { listTmux } = await import('../../commands/tmux.js');
      await listTmux();
    }, { skipSetupCheck: true }));

  tmux
    .command('new')
    .description('Create and attach to a new session')
    .argument('[name]', 'Session name')
    .action(withErrorHandler(async (name) => {
      const { newTmux } = await import('../../commands/tmux.js');
      await newTmux(name);
    }, { skipSetupCheck: true }));

  tmux
    .command('attach')
    .description('Attach to a session (by id or name)')
    .argument('<id>', 'Session ID or name')
    .option('--force', 'Take over if attached elsewhere')
    .action(withErrorHandler(async (id, options) => {
      const { attachTmux } = await import('../../commands/tmux.js');
      await attachTmux(id, { force: options.force });
    }, { skipSetupCheck: true }));

  tmux
    .command('kill')
    .description('Kill a session (by id or name)')
    .argument('<id>', 'Session ID or name')
    .action(withErrorHandler(async (id) => {
      const { killTmux } = await import('../../commands/tmux.js');
      await killTmux(id);
    }, { skipSetupCheck: true }));

  const replay = tmux
    .command('replay')
    .description('Inspect saved tmux-lite replays');
  configureTmuxSandbox(replay);

  replay
    .command('list')
    .description('List captured replays')
    .option('--all', 'Include dismissed replays')
    .action(withErrorHandler(async (options) => {
      const { listTmuxReplays } = await import('../../commands/tmux.js');
      listTmuxReplays({ all: options.all, sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  replay
    .command('text')
    .description('Print replay terminal text')
    .argument('<replay>', 'Replay ID, replay ID prefix, session ID, or session name')
    .option('--at-ms <number>', 'Replay time offset in milliseconds', (value: string) => parseInt(value, 10))
    .option('--scrollback-lines <number>', 'Scrollback lines to include', (value: string) => parseInt(value, 10))
    .option('--include-scrollback', 'Include scrollback lines before the visible screen')
    .action(withErrorHandler(async (replayRef, options) => {
      const { showTmuxReplayText } = await import('../../commands/tmux.js');
      await showTmuxReplayText(replayRef, {
        sandbox: getTmuxLiteSandbox(),
        atMs: options.atMs,
        scrollbackLines: options.scrollbackLines,
        includeScrollback: options.includeScrollback,
      });
    }, { skipSetupCheck: true }));

  replay
    .command('screenshot')
    .description('Render a replay frame to PNG')
    .argument('<replay>', 'Replay ID, replay ID prefix, session ID, or session name')
    .option('--at-ms <number>', 'Replay time offset in milliseconds', (value: string) => parseInt(value, 10))
    .option('--scrollback-lines <number>', 'Scrollback lines to include', (value: string) => parseInt(value, 10))
    .option('--include-scrollback', 'Include scrollback lines before the visible screen')
    .option('-o, --output <path>', 'Write PNG to this path')
    .action(withErrorHandler(async (replayRef, options) => {
      const { screenshotTmuxReplay } = await import('../../commands/tmux.js');
      await screenshotTmuxReplay(replayRef, {
        sandbox: getTmuxLiteSandbox(),
        output: options.output,
        atMs: options.atMs,
        scrollbackLines: options.scrollbackLines,
        includeScrollback: options.includeScrollback,
      });
    }, { skipSetupCheck: true }));

  replay
    .command('dismiss')
    .description('Soft-hide a replay from default listing')
    .argument('<replay>', 'Replay ID, replay ID prefix, session ID, or session name')
    .action(withErrorHandler(async (replayRef) => {
      const { dismissTmuxReplay } = await import('../../commands/tmux.js');
      dismissTmuxReplay(replayRef, { sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  replay
    .command('undismiss')
    .description('Restore a dismissed replay')
    .argument('<replay>', 'Replay ID, replay ID prefix, session ID, or session name')
    .action(withErrorHandler(async (replayRef) => {
      const { undismissTmuxReplay } = await import('../../commands/tmux.js');
      undismissTmuxReplay(replayRef, { sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  replay
    .command('delete')
    .description('Permanently delete a replay from disk')
    .argument('<replay>', 'Replay ID, replay ID prefix, session ID, or session name')
    .action(withErrorHandler(async (replayRef) => {
      const { deleteTmuxReplay } = await import('../../commands/tmux.js');
      deleteTmuxReplay(replayRef, { sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  replay
    .command('usage')
    .description('Show replay storage disk usage')
    .option('--json', 'Output as JSON')
    .option('--top <n>', 'Show only the N largest replays', (v: string) => parseInt(v, 10))
    .action(withErrorHandler(async (options) => {
      const { showTmuxReplayUsage } = await import('../../commands/tmux.js');
      showTmuxReplayUsage({ sandbox: getTmuxLiteSandbox(), json: options.json, top: options.top });
    }, { skipSetupCheck: true }));

  replay
    .command('prune')
    .description('Delete expired dismissed replays now')
    .action(withErrorHandler(async () => {
      const { pruneTmuxReplays } = await import('../../commands/tmux.js');
      pruneTmuxReplays({ sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  const hosting = tmux
    .command('hosting')
    .description('Configure tmux-lite service hosting');
  configureTmuxSandbox(hosting);

  hosting
    .command('status')
    .description('Show tmux-lite hosting status')
    .action(withErrorHandler(async () => {
      const { statusTmuxHosting } = await import('../../commands/tmux.js');
      await statusTmuxHosting({ sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  hosting
    .command('select')
    .description('Select the base host used for tmux-lite service hosting')
    .argument('[host]', 'Hosting base host, reserved name, or reserved .serve name')
    .action(withErrorHandler(async (host) => {
      const { selectTmuxHosting } = await import('../../commands/tmux.js');
      await selectTmuxHosting(host, { sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  hosting
    .command('set-name')
    .description('Set the machine name used in hosted service routes')
    .argument('<name>', 'Machine name')
    .action(withErrorHandler(async (name) => {
      const { setTmuxHostingMachineName } = await import('../../commands/tmux.js');
      await setTmuxHostingMachineName(name, { sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  hosting
    .command('enable')
    .description('Enable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { enableTmuxHosting } = await import('../../commands/tmux.js');
      await enableTmuxHosting({ sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  hosting
    .command('disable')
    .description('Disable tmux-lite service hosting')
    .action(withErrorHandler(async () => {
      const { disableTmuxHosting } = await import('../../commands/tmux.js');
      await disableTmuxHosting({ sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));

  hosting
    .command('clear')
    .description('Clear tmux-lite hosting configuration')
    .action(withErrorHandler(async () => {
      const { clearTmuxHosting } = await import('../../commands/tmux.js');
      await clearTmuxHosting({ sandbox: getTmuxLiteSandbox() });
    }, { skipSetupCheck: true }));
}
