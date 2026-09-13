import { createRoot } from 'react-dom/client';
import { SettingsPage } from '../src/SettingsPage.js';
import '../src/styles.css';
import './settings-preview.css';

const settings = {
  version: 1 as const,
  revision: 3,
  onboardingComplete: true,
  profile: { displayName: 'Brad', handle: 'brad' },
  git: { authorName: 'Brad', authorEmail: 'brad@example.com' },
  defaults: { machineId: 'local-machine', enterAction: 'steer' as const },
  updatedAt: new Date().toISOString(),
  updatedBy: 'local-machine',
};
const unavailable = async (): Promise<never> => { throw new Error('This action needs an enrolled account, not the settings preview.'); };
const root = document.getElementById('root');
if (!root) throw new Error('preview root missing');
createRoot(root).render(<SettingsPage
  mode="settings"
  settings={settings}
  machines={[
    { id: 'local-machine', label: 'Darktop', state: 'online', kind: 'physical', provider: 'physical', notes: 'Bun and Docker installed.', desiredState: 'online', lifecycleRevision: 0, operationId: null, error: null },
    { id: 'sandbox-a', label: 'Cloudflare build-a', state: 'resuming', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'GitSpace runtime starting.', desiredState: 'online', lifecycleRevision: 2, operationId: 'resume-a', error: null },
    { id: 'sandbox-b', label: 'Cloudflare build-b', state: 'error', kind: 'sandbox', provider: 'cloudflare-sandbox', notes: 'Build isolation.', desiredState: 'online', lifecycleRevision: 4, operationId: null, error: 'Sandbox runtime exited before the RPC probe became ready.' },
  ]}
  ompSettings={[]}
  ompGeneration={4}
  models={[]}
  providers={{ providers: [], usage: null, usageStatus: 'idle', onShow: () => undefined, onRefreshUsage: unavailable, onSignIn: unavailable, onSignOut: unavailable, onSetApiKey: unavailable, login: { flow: null, respond: unavailable, cancel: unavailable } }}
  devices={[]}
  onRevokeDevice={unavailable}
  onSignOut={unavailable}
  onCreateApiClient={unavailable}
  canConnectBrowser={false}
  onCreateBrowserInvitation={unavailable}
  onBrowserInvitationStatus={unavailable}
  onCancelBrowserInvitation={unavailable}
  onBrowserConnected={unavailable}
  projects={[]}
  composioSetup={null}
  onPutComposioSetup={unavailable}
  onDeleteComposioSetup={unavailable}
  browserRelay={null}
  onSetupBrowserRelay={unavailable}
  onStartBrowserRelay={unavailable}
  onStopBrowserRelay={unavailable}
  onTestBrowserRelay={unavailable}
  deployment={null}
  onRevertDeployment={unavailable}
  ompSync={{ status: 'synced', message: null }}
  gitIdentity={{ generation: 1, publicKey: 'ssh-ed25519 AAAA preview', fingerprint: 'SHA256:preview', updatedAt: new Date().toISOString(), updatedBy: 'local-machine' }}
  onChange={() => undefined}
  onSave={async () => undefined}
  onSetOmpSetting={async () => undefined}
  onUpdateMachine={async () => undefined}
  onCreateSandbox={async () => { (window as typeof window & { __sandboxRequested?: boolean }).__sandboxRequested = true; }}
  onBack={() => undefined}
  onControlMachine={async (action, machineId) => { (window as typeof window & { __machineAction?: string }).__machineAction = `${action}:${machineId}`; }}
  onDestroyMachine={async (machineId) => { (window as typeof window & { __destroyedMachine?: string }).__destroyedMachine = machineId; }}
  onComplete={async () => undefined}
  saving={false}
  error={null}
/>);
