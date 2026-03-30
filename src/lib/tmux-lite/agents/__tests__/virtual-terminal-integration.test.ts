import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, copyFileSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { Terminal as XTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { Container, Spacer, Text, TUI } from '@oh-my-pi/pi-tui';
import { VirtualTerminal } from '../virtual-terminal.js';
import { extractStyledRows, findPngRasterizer, renderStyledRowsSvg } from '../../replay/screenshot.js';

const tempPaths: string[] = [];

afterEach(() => {
  for (const filePath of tempPaths.splice(0)) {
    rmSync(filePath, { recursive: true, force: true });
  }
});

function createPipeline(cols = 80, rows = 24) {
  const xterm = new XTerminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize as any);
  const vt = new VirtualTerminal(cols, rows, (data: string) => xterm.write(data));
  return { xterm, serialize, vt };
}

function readXtermText(xterm: XTerminal, startRow = 0, endRow?: number): string {
  const lines: string[] = [];
  const buffer = xterm.buffer.active;
  const end = endRow ?? buffer.length;
  for (let i = startRow; i < end; i++) {
    const line = buffer.getLine(i);
    if (line) lines.push(line.translateToString(true));
  }
  return lines.join('\n').trimEnd();
}

function waitForXterm(ms = 120): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('VirtualTerminal integration', () => {
  it('renders pi-tui Text through VirtualTerminal into xterm-headless', async () => {
    const { xterm, vt } = createPipeline(60, 20);
    const tui = new TUI(vt, false);
    tui.addChild(new Text('Hello from pi-tui!', 0, 0));
    tui.start();
    await waitForXterm(200);
    const text = readXtermText(xterm, 0, 5);
    expect(text).toContain('Hello from pi-tui!');
    tui.stop();
    xterm.dispose();
  });

  it('routes injected input into pi-tui listeners', async () => {
    const { xterm, vt } = createPipeline(60, 20);
    const tui = new TUI(vt, false);
    const inputs: string[] = [];
    tui.addInputListener((data: string) => {
      inputs.push(data);
      return undefined;
    });
    tui.start();
    await waitForXterm();
    vt.injectInput('a');
    vt.injectInput('\x1b[A');
    await waitForXterm();
    expect(inputs).toEqual(['a', '\x1b[A']);
    tui.stop();
    xterm.dispose();
  });

  it('re-renders after resize with VirtualTerminal + xterm resize', async () => {
    const { xterm, vt } = createPipeline(40, 10);
    const tui = new TUI(vt, false);
    tui.addChild(new Text('X'.repeat(30), 1, 0));
    tui.start();
    await waitForXterm(200);
    vt.resize(20, 10);
    xterm.resize(20, 10);
    tui.requestRender(true);
    await waitForXterm(200);
    expect(vt.columns).toBe(20);
    expect(xterm.cols).toBe(20);
    tui.stop();
    xterm.dispose();
  });

  it('captures pi-tui rendering as PNG via the replay screenshot pipeline', async () => {
    const rasterizer = findPngRasterizer();
    if (!rasterizer) {
      console.warn('Skipping PNG test: no rasterizer available');
      return;
    }

    const cols = 60;
    const { xterm, vt } = createPipeline(cols, 16);
    const tui = new TUI(vt, false);
    tui.addChild(new Text('\x1b[1;36m=== VirtualTerminal Integration Test ===\x1b[0m', 1, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('This is rendered by pi-tui through VirtualTerminal', 1, 0));
    tui.addChild(new Text('into xterm-headless, then captured as PNG.', 1, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('\x1b[1mAgent Tasks:\x1b[0m', 1, 0));
    tui.addChild(new Text('  \x1b[32m\u2713\x1b[0m Create VirtualTerminal adapter', 1, 0));
    tui.addChild(new Text('  \x1b[32m\u2713\x1b[0m Wire into tmux-lite session model', 1, 0));
    tui.addChild(new Text('  \x1b[34m\u25B6\x1b[0m Start InteractiveMode in-process', 1, 0));
    tui.addChild(new Text('  \x1b[90m\u25CB\x1b[0m Attach from a live client', 1, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('\x1b[2mModel: Claude 4 Sonnet \u2022 Provider: Anthropic\x1b[0m', 1, 0));
    tui.start();
    await waitForXterm(250);

    const rows = extractStyledRows(xterm);
    expect(rows.length).toBeGreaterThan(0);
    const svg = renderStyledRowsSvg(rows, cols, {
      title: 'VirtualTerminal → pi-tui → xterm-headless',
      subtitle: 'Integration test snapshot',
    });
    expect(svg).toContain('<svg');

    const tempDir = mkdtempSync(join(tmpdir(), 'gitspace-vt-shot-'));
    tempPaths.push(tempDir);
    const svgPath = join(tempDir, 'snapshot.svg');
    const pngPath = join(tempDir, 'snapshot.png');
    writeFileSync(svgPath, svg, 'utf-8');

    await new Promise<void>((resolve, reject) => {
      const args = rasterizer.kind === 'sips'
        ? ['-s', 'format', 'png', svgPath, '--out', pngPath]
        : [svgPath, pngPath];
      const proc = spawn(rasterizer.executable, args, { timeout: 10_000 });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`rasterizer exited ${code}`)));
      proc.on('error', reject);
    });

    expect(existsSync(pngPath)).toBe(true);
    expect(statSync(pngPath).size).toBeGreaterThan(500);

    const stablePath = '/tmp/virtual-terminal-integration-test.png';
    copyFileSync(pngPath, stablePath);
    console.log(`\n  Screenshot written to: ${stablePath}`);

    tui.stop();
    xterm.dispose();
  });

  it('initializing Settings removes the InteractiveMode constructor blocker', async () => {
    const omp = await import('@oh-my-pi/pi-coding-agent');
    const discovery = await import('@oh-my-pi/pi-coding-agent/discovery');
    const { Settings, InteractiveMode, initTheme } = omp as any;
    const { initializeWithSettings } = discovery as any;
    const cwd = mkdtempSync(join(tmpdir(), 'gitspace-vt-cwd-'));
    const agentDir = mkdtempSync(join(tmpdir(), 'gitspace-vt-agent-'));
    tempPaths.push(cwd, agentDir);

    const settings = await Settings.init({ cwd, agentDir });
    initializeWithSettings(settings);
    await initTheme(
      false,
      settings.get('symbolPreset'),
      settings.get('colorBlindMode'),
      settings.get('theme.dark'),
      settings.get('theme.light'),
    );

    const mockSession = {
      sessionId: 'test-session',
      sessionManager: {
        getSessionDir: () => cwd,
        getSessionName: () => 'test',
        getCwd: () => cwd,
        getEntries: () => [],
        flush: () => {},
      },
      settings: Settings.instance,
      agent: {},
      model: { name: 'test-model', provider: 'test' },
      extensionRunner: { getRegisteredCommands: () => [] },
      customCommands: [],
      skills: [],
      autoCompactionEnabled: false,
      prompt: async () => {},
      subscribe: () => () => {},
      setModel: async () => {},
      dispose: () => {},
    };

    const mode = new InteractiveMode(mockSession, '1.0.0', undefined);
    expect(mode.ui).toBeDefined();

    const { xterm, vt } = createPipeline(80, 24);
    const replaced = new TUI(vt, false);
    mode.ui = replaced;
    expect(mode.ui).toBe(replaced);
    expect(mode.ui.terminal).toBe(vt);
    xterm.dispose();
  });
});
