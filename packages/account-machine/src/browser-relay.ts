import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { BrowserRelayStatus } from '@gitspace/protocol';

interface BrowserRelaySupervisorOptions {
  environmentRoot: string;
  binaryPath?: string;
  port?: number;
  onError?: (error: unknown) => void;
}
type RelayProbe = {
  state: 'connected' | 'waiting' | 'offline';
  browserName: string | null;
  browserVersion: string | null;
};

function browserIdentity(product: unknown): Pick<RelayProbe, 'browserName' | 'browserVersion'> {
  if (typeof product !== 'string' || product.trim().length === 0) return { browserName: null, browserVersion: null };
  const [rawName, ...versionParts] = product.trim().split('/');
  const browserName = rawName === 'HeadlessChrome' ? 'Chrome' : rawName;
  return { browserName, browserVersion: versionParts.join('/') || null };
}


async function command(binaryPath: string, args: string[]): Promise<void> {
  const child = Bun.spawn([binaryPath, ...args], {
    env: Bun.env,
    stdin: 'ignore',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || stdout.trim() || `omp ${args[0] ?? ''} exited with ${exitCode}`);
}

export class BrowserRelaySupervisor {
  readonly extensionPath: string;
  readonly endpoint: string;
  readonly chromeExtensionPath: string;
  private readonly binaryPath: string;
  private process: Bun.Subprocess | null = null;
  private starting = false;
  private lastError: string | null = null;
  private stopped = false;

  constructor(private readonly options: BrowserRelaySupervisorOptions) {
    const port = options.port ?? 9_224;
    this.extensionPath = join(options.environmentRoot, '.browser-relay', 'extension');
    const distro = process.env.WSL_DISTRO_NAME?.trim();
    this.chromeExtensionPath = distro ? `\\\\wsl.localhost\\${distro}${this.extensionPath.replaceAll('/', '\\')}` : this.extensionPath;
    this.endpoint = `http://127.0.0.1:${port}`;
    this.binaryPath = options.binaryPath ?? process.env.GITSPACE_OMP_BINARY ?? Bun.which('omp') ?? 'omp';
  }

  async status(): Promise<BrowserRelayStatus> {
    const installed = await Bun.file(join(this.extensionPath, 'manifest.json')).exists();
    const probe = await this.probe();
    const identity = { browserName: probe.browserName, browserVersion: probe.browserVersion };
    if (probe.state === 'connected') return { state: 'connected', installed, owned: this.process !== null, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, ...identity, message: null };
    if (probe.state === 'waiting') return { state: 'waiting', installed, owned: this.process !== null, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, ...identity, message: 'Open Chrome and enable the GitSpace Browser Relay extension.' };
    if (this.starting) return { state: 'starting', installed, owned: true, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, ...identity, message: null };
    if (this.lastError) return { state: 'error', installed, owned: false, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, ...identity, message: this.lastError };
    return { state: 'stopped', installed, owned: false, extensionPath: this.extensionPath, chromeExtensionPath: this.chromeExtensionPath, endpoint: this.endpoint, ...identity, message: installed ? 'Browser Relay is installed but stopped.' : null };
  }

  async setup(): Promise<BrowserRelayStatus> {
    await mkdir(join(this.options.environmentRoot, '.browser-relay'), { recursive: true });
    if (!await Bun.file(join(this.extensionPath, 'manifest.json')).exists()) {
      await command(this.binaryPath, ['browser-relay', 'install', '--dir', this.extensionPath]);
    }
    await this.start();
    return this.status();
  }

  async start(): Promise<BrowserRelayStatus> {
    const installed = await Bun.file(join(this.extensionPath, 'manifest.json')).exists();
    if (!installed) throw new Error('Set up Browser Relay before starting it');
    if ((await this.probe()).state !== 'offline') return this.status();
    this.stopped = false;
    this.starting = true;
    this.lastError = null;
    try {
      await command(this.binaryPath, ['config', 'set', 'browser.relay', 'true']);
      await command(this.binaryPath, ['config', 'set', 'browser.relayUrl', this.endpoint]);
      const port = new URL(this.endpoint).port;
      const child = Bun.spawn([this.binaryPath, 'browser-relay', 'serve', '--port', port], {
        env: Bun.env,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      });
      this.process = child;
      void child.exited.then((exitCode) => {
        if (this.process === child) this.process = null;
        if (!this.stopped && exitCode !== 0) {
          this.lastError = `Browser Relay exited with code ${exitCode}`;
          this.options.onError?.(new Error(this.lastError));
        }
      });
      for (let attempt = 0; attempt < 30; attempt += 1) {
        if ((await this.probe()).state !== 'offline') break;
        await Bun.sleep(100);
      }
      if ((await this.probe()).state === 'offline') throw new Error('Browser Relay did not start');
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : 'Unable to start Browser Relay';
      throw error;
    } finally {
      this.starting = false;
    }
    return this.status();
  }

  async stop(): Promise<BrowserRelayStatus> {
    this.stopped = true;
    this.lastError = null;
    const child = this.process;
    this.process = null;
    if (child) {
      child.kill('SIGTERM');
      await child.exited;
    } else if ((await this.probe()).state !== 'offline') {
      throw new Error('Browser Relay is running outside this GitSpace process');
    }
    return this.status();
  }

  async test(): Promise<BrowserRelayStatus> {
    const status = await this.status();
    if (status.state !== 'connected') throw new Error(status.message ?? 'Browser Relay is not connected');
    return status;
  }

  private async probe(): Promise<RelayProbe> {
    try {
      const response = await fetch(`${this.endpoint}/json/version`, { signal: AbortSignal.timeout(800) });
      if (response.status === 200) {
        const payload = await response.json() as { Browser?: unknown };
        return { state: 'connected', ...browserIdentity(payload.Browser) };
      }
      if (response.status === 503) return { state: 'waiting', browserName: null, browserVersion: null };
      return { state: 'offline', browserName: null, browserVersion: null };
    } catch {
      return { state: 'offline', browserName: null, browserVersion: null };
    }
  }
}
