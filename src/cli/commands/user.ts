/**
 * gssh user identity|auth|host|config|notifications|migrate
 *
 * User-level commands: identity management, gitspace.sh authentication,
 * hosting, configuration, notifications.
 *
 * @module cli/commands/user
 */

import type { Command } from 'commander';
import { withErrorHandler } from '../error.js';

export function registerUserCommands(parent: Command): void {
  const cmd = parent
    .command('user')
    .description('User identity, authentication, and settings');

  registerIdentityCommands(cmd);
  registerAuthCommands(cmd);
  registerHostCommands(cmd);
  registerConfigCommands(cmd);
  registerNotificationsCommands(cmd);
  registerMigrateCommands(cmd);
}

// ============================================================================
// Identity
// ============================================================================

function registerIdentityCommands(user: Command): void {
  const identity = user
    .command('identity')
    .description('Manage user root identity');

  // gssh user identity init
  identity
    .command('init')
    .description('Initialize a new identity (generates 24-word mnemonic)')
    .option('--force', 'Overwrite existing identity')
    .action(withErrorHandler(async (options) => {
      const { initIdentity } = await import('../../commands/identity.js');
      await initIdentity(options);
    }));

  // gssh user identity show
  identity
    .command('show')
    .description('Show identity information')
    .option('--fingerprint', 'Show only fingerprint')
    .option('--json', 'Output in JSON format')
    .action(withErrorHandler(async (options) => {
      const { showIdentity } = await import('../../commands/identity.js');
      await showIdentity(options);
    }));

  // gssh user identity recover
  identity
    .command('recover')
    .description('Recover identity from 24-word mnemonic')
    .option('--cloud', 'Recover from GitSpace cloud backup (requires login)')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--force', 'Overwrite existing identity')
    .action(withErrorHandler(async (options) => {
      const { recoverIdentity } = await import('../../commands/identity.js');
      await recoverIdentity(options);
    }));

  // gssh user identity export
  identity
    .command('export')
    .description('Export public key in gssh-user: format (for sharing)')
    .action(withErrorHandler(async () => {
      const { exportIdentity } = await import('../../commands/identity.js');
      await exportIdentity();
    }));

  // gssh user identity import
  identity
    .command('import')
    .description('Import a peer public key (validates format)')
    .argument('<key>', 'Public key string (gssh-user:BASE64_KEY)')
    .action(withErrorHandler(async (key) => {
      const { importIdentity } = await import('../../commands/identity.js');
      await importIdentity(key);
    }));

  // gssh user identity remove
  identity
    .command('remove')
    .description('Remove identity from keychain (requires mnemonic to recover)')
    .option('--force', 'Skip confirmation')
    .action(withErrorHandler(async (options) => {
      const { removeIdentity } = await import('../../commands/identity.js');
      await removeIdentity(options);
    }));

  const backup = identity
    .command('backup')
    .description('Manage optional encrypted cloud backup of your user identity');

  backup
    .command('enable')
    .description('Enable/update encrypted cloud backup for your identity')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(withErrorHandler(async (options) => {
      const { enableIdentityBackup } = await import('../../commands/identity.js');
      await enableIdentityBackup(options);
    }));

  backup
    .command('status')
    .description('Show cloud backup status for your identity')
    .action(withErrorHandler(async () => {
      const { showIdentityBackupStatus } = await import('../../commands/identity.js');
      await showIdentityBackupStatus();
    }));

  backup
    .command('disable')
    .description('Disable and remove encrypted cloud backup for your identity')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(withErrorHandler(async (options) => {
      const { disableIdentityBackup } = await import('../../commands/identity.js');
      await disableIdentityBackup(options);
    }));

  backup
    .command('rotate-password')
    .description('Rotate the password used to encrypt cloud identity backup')
    .option('-y, --yes', 'Auto-confirm prompts')
    .action(withErrorHandler(async (options) => {
      const { rotateIdentityBackupPassword } = await import('../../commands/identity.js');
      await rotateIdentityBackupPassword(options);
    }));
}

// ============================================================================
// Auth
// ============================================================================

function registerAuthCommands(user: Command): void {
  const auth = user
    .command('auth')
    .description('Manage gitspace.sh authentication');

  auth
    .command('login')
    .description('Login with GitHub')
    .option('-y, --yes', 'Auto-confirm prompts')
    .option('--password-stdin', 'Read local identity password from stdin')
    .action(withErrorHandler(async (options) => {
      const { authLogin } = await import('../../commands/auth.js');
      await authLogin(options);
    }));

  auth
    .command('logout')
    .description('Logout and clear credentials')
    .action(withErrorHandler(async () => {
      const { authLogout } = await import('../../commands/auth.js');
      await authLogout();
    }, { skipSetupCheck: true }));

  auth
    .command('status')
    .description('Show login status')
    .action(withErrorHandler(async () => {
      const { authStatus } = await import('../../commands/auth.js');
      await authStatus();
    }, { skipSetupCheck: true }));

}

// ============================================================================
// Host
// ============================================================================

function registerHostCommands(user: Command): void {
  const host = user
    .command('host')
    .description('Manage gitspace.sh hosting subdomains');

  host
    .command('reserve')
    .description('Reserve a subdomain (e.g., brad.gitspace.sh)')
    .argument('<subdomain>', 'Subdomain name')
    .action(withErrorHandler(async (subdomain) => {
      const { hostReserve } = await import('../../commands/host.js');
      await hostReserve(subdomain);
    }));

  host
    .command('release')
    .description('Release a subdomain')
    .argument('[subdomain]', 'Subdomain name')
    .action(withErrorHandler(async (subdomain) => {
      const { hostRelease } = await import('../../commands/host.js');
      await hostRelease(subdomain);
    }, { skipSetupCheck: true }));

  host
    .command('list')
    .description('List your subdomains')
    .action(withErrorHandler(async () => {
      const { hostList } = await import('../../commands/host.js');
      await hostList();
    }, { skipSetupCheck: true }));

  host
    .command('set-primary')
    .description('Set primary subdomain for hosted relay and tmux hosting')
    .argument('<subdomain>', 'Subdomain name')
    .action(withErrorHandler(async (subdomain) => {
      const { hostSetPrimary } = await import('../../commands/host.js');
      await hostSetPrimary(subdomain);
    }, { skipSetupCheck: true }));

  host
    .command('status')
    .description('Show hosting status')
    .action(withErrorHandler(async () => {
      const { hostStatus } = await import('../../commands/host.js');
      await hostStatus();
    }, { skipSetupCheck: true }));

  host
    .command('doctor')
    .description('Check hosted relay readiness and remediation steps')
    .action(withErrorHandler(async () => {
      const { hostDoctor } = await import('../../commands/host.js');
      await hostDoctor();
    }, { skipSetupCheck: true }));
}

// ============================================================================
// Config
// ============================================================================

function registerConfigCommands(user: Command): void {
  const config = user
    .command('config')
    .description('Configure gitspace settings');

  // gssh user config notifications
  config
    .command('notifications')
    .description('Configure notification settings')
    .option('--show', 'Show current settings')
    .option('--reset', 'Reset to defaults')
    .action(withErrorHandler(async (options) => {
      const { configNotifications } = await import('../../commands/config.js');
      await configNotifications(options);
    }));

  // gssh user config linear [setup|show|clear]
  const linear = config
    .command('linear')
    .description('Configure Linear integration');

  linear
    .command('setup')
    .description('Configure Linear integration')
    .option('--project <name>', 'Configure for specific project')
    .action(withErrorHandler(async (options) => {
      const { linearSetup } = await import('../../commands/config.js');
      await linearSetup(options);
    }));

  linear
    .command('show')
    .description('Show Linear configuration')
    .option('--project <name>', 'Show project-specific configuration')
    .action(withErrorHandler(async (options) => {
      const { linearShow } = await import('../../commands/config.js');
      await linearShow(options);
    }));

  linear
    .command('clear')
    .description('Clear Linear configuration')
    .option('--global', 'Clear user-level configuration')
    .option('--project <name>', 'Clear project-specific configuration')
    .action(withErrorHandler(async (options) => {
      const { linearClear } = await import('../../commands/config.js');
      await linearClear(options);
    }));
}

// ============================================================================
// Notifications
// ============================================================================

function registerNotificationsCommands(user: Command): void {
  const notify = user
    .command('notifications')
    .description('Manage notification shell hooks');

  notify
    .command('install')
    .description('Install shell hooks for notification integration')
    .action(withErrorHandler(async () => {
      const { notificationsInstall } = await import('../../commands/notifications.js');
      await notificationsInstall();
    }, { skipSetupCheck: true }));

  notify
    .command('uninstall')
    .description('Remove shell hooks from shell config files')
    .action(withErrorHandler(async () => {
      const { notificationsUninstall } = await import('../../commands/notifications.js');
      await notificationsUninstall();
    }, { skipSetupCheck: true }));

  notify
    .command('hook')
    .description('Print shell hook snippet for manual installation')
    .option('--shell <shell>', 'Shell type (bash, zsh, fish)')
    .action(withErrorHandler(async (options) => {
      const { notificationsHook } = await import('../../commands/notifications.js');
      await notificationsHook(options.shell);
    }, { skipSetupCheck: true }));

  notify
    .command('status')
    .description('Show notification settings and hook installation status')
    .action(withErrorHandler(async () => {
      const { notificationsStatus } = await import('../../commands/notifications.js');
      await notificationsStatus();
    }, { skipSetupCheck: true }));
}

// ============================================================================
// Migrate
// ============================================================================

function registerMigrateCommands(user: Command): void {
  const migrate = user
    .command('migrate')
    .description('Migration and cleanup utilities');

  migrate
    .command('cleanup-legacy')
    .description('Delete stale keychain entries after migration to unified secrets')
    .option('-y, --yes', 'Skip confirmation prompt')
    .action(withErrorHandler(async (options) => {
      const { migrateCleanupLegacy } = await import('../../commands/migrate.js');
      await migrateCleanupLegacy(options);
    }));
}
