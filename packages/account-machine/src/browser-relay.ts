import { mkdir, readdir, rename, rm, writeFile, lstat } from 'node:fs/promises';
import { dirname, join, resolve, relative } from 'node:path';
import { homedir } from 'node:os';
import type { BrowserRelayStatus } from '@gitspace/protocol';
import { EXTENSION_BUILD_FILE, extensionFiles } from '@gitspace/browser-extension';

type BrowserRelaySupervisorOptions = { environmentRoot: string; machineId: string; accountUrl: string; extensionPath?: string; enabled: boolean };
/** Installs the extension only. Pairing, transport and browser effects belong to the account worker. */
export class BrowserRelaySupervisor {
  readonly extensionPath: string;
  readonly endpoint: string;
  readonly chromeExtensionPath: string;
  constructor(private readonly options: BrowserRelaySupervisorOptions) {
    const endpoint = new URL(options.accountUrl);
    if (endpoint.protocol !== 'https:') throw new Error('Browser extension requires a secure account endpoint');
    this.endpoint = endpoint.origin;
    // A folder you can find when Chrome asks for it, beside the workspaces (`~/gitspace/spaces`); a computer is linked
    // to one account, whose extension it holds.
    this.extensionPath = resolve(options.extensionPath ?? join(homedir(), 'gitspace', 'chrome-extension'));
    const inside = relative(resolve(options.environmentRoot), this.extensionPath);
    if (!inside || !inside.startsWith('..') && !inside.startsWith('/')) throw new Error('Browser extension storage must be outside the environment root');
    const distro = process.env.WSL_DISTRO_NAME?.trim();
    this.chromeExtensionPath = distro ? `\\\\wsl.localhost\\${distro}${this.extensionPath.replaceAll('/', '\\')}` : this.extensionPath;
  }
  async status(): Promise<BrowserRelayStatus & { connected: boolean }> {
    const installed = await Bun.file(join(this.extensionPath, 'manifest.json')).exists();
    return { state: installed ? 'waiting' : 'stopped', connected: false, installed, owned: false, machineId: this.options.machineId, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, pairingCode: null, browserName: null, browserVersion: null, pairedKeyFingerprint: null, message: 'Chrome connects directly to your account. Pair and manage the browser in account Browser settings.' };
  }
  /** Writes this release's extension into the folder Chrome loads it from unpacked (`gitspace browser install`); the
   *  machine writes it again whenever it starts, so every machine update brings it. Each file is replaced whole and
   *  the build file goes last, so the extension, which reloads when that file names another build, never loads a
   *  half-written folder (`reloadIfReplaced`). */
  async setup(): Promise<BrowserRelayStatus> {
    await mkdir(dirname(this.extensionPath), { recursive: true });
    await mkdir(this.extensionPath, { recursive: true, mode: 0o700 });
    if ((await lstat(this.extensionPath)).isSymbolicLink()) throw new Error('Unsafe extension storage');
    const files = extensionFiles(this.endpoint);
    const names = [...Object.keys(files).filter(name => name !== EXTENSION_BUILD_FILE), EXTENSION_BUILD_FILE];
    for (const name of names) {
      const temporary = join(this.extensionPath, `.${name}.${process.pid}.tmp`);
      await writeFile(temporary, files[name]!, { mode: 0o600 });
      await rename(temporary, join(this.extensionPath, name));
    }
    for (const name of await readdir(this.extensionPath)) if (!(name in files)) await rm(join(this.extensionPath, name), { recursive: true, force: true });
    return this.status();
  }
  async stop(): Promise<BrowserRelayStatus> { throw new Error('Disconnect the browser in account Browser settings; machines do not own Chrome transport'); }
  async unpair(): Promise<BrowserRelayStatus> { throw new Error('Forget the paired browser in authenticated account Browser settings'); }
  async test(): Promise<BrowserRelayStatus> { throw new Error('Inspect account Browser status to verify the extension connection'); }
}
