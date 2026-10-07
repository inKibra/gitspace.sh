import { mkdir, rm, writeFile, chmod, lstat } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import type { BrowserRelayStatus } from '@gitspace/protocol';
import { browserRelayFiles } from './browser-relay-extension.js';

type BrowserRelaySupervisorOptions = { environmentRoot: string; machineId: string; accountUrl: string; privateRoot?: string; enabled: boolean };
/** Installs the extension only. Pairing, transport and browser effects belong to the account worker. */
export class BrowserRelaySupervisor {
  readonly extensionPath: string;
  readonly endpoint: string;
  readonly chromeExtensionPath: string;
  private readonly privateRoot: string;
  constructor(private readonly options: BrowserRelaySupervisorOptions) {
    const endpoint = new URL(options.accountUrl);
    if (endpoint.protocol !== 'https:') throw new Error('Browser extension requires a secure account endpoint');
    this.endpoint = endpoint.origin;
    this.privateRoot = resolve(options.privateRoot ?? join(homedir(), '.gitspace-browser-relay', createHash('sha256').update(this.endpoint).digest('hex')));
    const inside = relative(resolve(options.environmentRoot), this.privateRoot);
    if (!inside || !inside.startsWith('..') && !inside.startsWith('/')) throw new Error('Browser extension storage must be outside the environment root');
    this.extensionPath = join(this.privateRoot, 'extension');
    const distro = process.env.WSL_DISTRO_NAME?.trim();
    this.chromeExtensionPath = distro ? `\\\\wsl.localhost\\${distro}${this.extensionPath.replaceAll('/', '\\')}` : this.extensionPath;
  }
  async status(): Promise<BrowserRelayStatus & { connected: boolean }> {
    const installed = await Bun.file(join(this.extensionPath, 'manifest.json')).exists();
    return { state: installed ? 'waiting' : 'stopped', connected: false, installed, owned: false, machineId: this.options.machineId, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, pairingCode: null, browserName: null, browserVersion: null, pairedKeyFingerprint: null, message: 'Chrome connects directly to your account. Pair and manage the browser in account Browser settings.' };
  }
  async setup(): Promise<BrowserRelayStatus> {
    await mkdir(this.privateRoot, { recursive: true, mode: 0o700 });
    if ((await lstat(this.privateRoot)).isSymbolicLink()) throw new Error('Unsafe extension storage');
    await chmod(this.privateRoot, 0o700);
    await rm(this.extensionPath, { recursive: true, force: true });
    await mkdir(this.extensionPath, { mode: 0o700 });
    const files = browserRelayFiles(this.endpoint);
    for (const [name, content] of Object.entries(files)) await writeFile(join(this.extensionPath, name), content, { mode: 0o600 });
    return this.status();
  }
  async start() { if (!(await this.status()).installed) throw new Error('Install the account browser extension first'); return this.status(); }
  async stop(): Promise<BrowserRelayStatus> { throw new Error('Disconnect the browser in account Browser settings; machines do not own Chrome transport'); }
  async unpair(): Promise<BrowserRelayStatus> { throw new Error('Forget the paired browser in authenticated account Browser settings'); }
  async test(): Promise<BrowserRelayStatus> { throw new Error('Inspect account Browser status to verify the extension connection'); }
}
