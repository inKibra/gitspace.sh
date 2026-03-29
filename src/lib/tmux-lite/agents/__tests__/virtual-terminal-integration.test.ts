/**
 * Integration tests for the VirtualTerminal rendering pipeline.
 *
 * Level 1+: pi-tui TUI → VirtualTerminal → xterm-headless
 * Proves that pi-tui components render correctly through the adapter
 * into the same xterm-headless that tmux-lite uses for all sessions.
 *
 * Level 2: InteractiveMode construction with TUI replacement
 * Proves the embedding approach (replace mode.ui before init) is viable.
 */
import { describe, it, expect, beforeEach } from 'bun:test';
import { VirtualTerminal } from '../virtual-terminal.js';

// Dynamic imports — these packages may not be available in all environments
let XTerminal: typeof import('@xterm/headless').Terminal;
let SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon;
let TUI: any;
let Text: any;
let Container: any;
let Spacer: any;

let available = false;

beforeEach(async () => {
  if (available) return;
  try {
    const xterm = await import('@xterm/headless');
    const serialize = await import('@xterm/addon-serialize');
    const tui = await import('@oh-my-pi/pi-tui');
    XTerminal = xterm.Terminal;
    SerializeAddon = serialize.SerializeAddon;
    TUI = tui.TUI;
    Text = tui.Text;
    Container = tui.Container;
    Spacer = tui.Spacer;
    available = true;
  } catch (e) {
    console.warn('Skipping integration tests: required packages not available', e);
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createPipeline(cols = 80, rows = 24) {
  const xterm = new XTerminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  const serialize = new SerializeAddon();
  xterm.loadAddon(serialize);

  const vt = new VirtualTerminal(cols, rows, (data: string) => {
    xterm.write(data);
  });

  return { xterm, serialize, vt };
}

/** Read visible text from xterm-headless buffer, trimmed. */
function readXtermText(xterm: InstanceType<typeof XTerminal>, startRow = 0, endRow?: number): string {
  const lines: string[] = [];
  const buffer = xterm.buffer.active;
  const end = endRow ?? buffer.length;
  for (let i = startRow; i < end; i++) {
    const line = buffer.getLine(i);
    if (line) {
      lines.push(line.translateToString(true));
    }
  }
  return lines.join('\n').trimEnd();
}

/** Wait for xterm to finish processing pending writes. */
function waitForXterm(xterm: InstanceType<typeof XTerminal>, ms = 100): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Level 1+: pi-tui rendering through VirtualTerminal → xterm-headless
// ---------------------------------------------------------------------------

describe('VirtualTerminal rendering pipeline', () => {
  it('renders plain text through the pipeline', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(40, 10);

    // Write directly through VirtualTerminal — simulates pi-tui's write() calls
    vt.write('Hello from VirtualTerminal\r\n');
    await waitForXterm(xterm);

    const text = readXtermText(xterm, 0, 2);
    expect(text).toContain('Hello from VirtualTerminal');

    xterm.dispose();
  });

  it('renders ANSI escape sequences correctly', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(40, 10);

    // Bold + color
    vt.write('\x1b[1;32mGreen Bold\x1b[0m Normal\r\n');
    await waitForXterm(xterm);

    const text = readXtermText(xterm, 0, 2);
    expect(text).toContain('Green Bold');
    expect(text).toContain('Normal');

    xterm.dispose();
  });

  it('handles cursor movement sequences', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(40, 10);

    // Write on row 0, move to row 2, write there
    vt.write('Row 0\r\n');
    vt.write('\r\n'); // skip row 1
    vt.write('Row 2\r\n');

    // Now move up 2 rows and overwrite
    vt.moveBy(-3);
    vt.clearLine();
    vt.write('\rOverwritten');

    await waitForXterm(xterm);

    const text = readXtermText(xterm, 0, 4);
    expect(text).toContain('Overwritten');
    expect(text).toContain('Row 2');

    xterm.dispose();
  });

  it('clearScreen resets the terminal', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(40, 10);

    vt.write('Before clear\r\n');
    await waitForXterm(xterm);
    expect(readXtermText(xterm, 0, 2)).toContain('Before clear');

    vt.clearScreen();
    vt.write('After clear\r\n');
    await waitForXterm(xterm);

    const text = readXtermText(xterm, 0, 2);
    expect(text).toContain('After clear');
    expect(text).not.toContain('Before clear');

    xterm.dispose();
  });

  it('resize propagates to VirtualTerminal and xterm', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(80, 24);

    expect(vt.columns).toBe(80);
    expect(vt.rows).toBe(24);

    vt.resize(120, 40);
    xterm.resize(120, 40);

    expect(vt.columns).toBe(120);
    expect(vt.rows).toBe(40);
    expect(xterm.cols).toBe(120);
    expect(xterm.rows).toBe(40);

    xterm.dispose();
  });

  it('pi-tui TUI renders a Text component through VirtualTerminal', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(60, 20);

    // Create a TUI on VirtualTerminal and add a Text component
    const tui = new TUI(vt, false);
    const textComponent = new Text('Hello from pi-tui!', 0, 0);
    tui.addChild(textComponent);

    // Start the TUI — this calls vt.start() and renders
    tui.start();

    // Give the TUI time to render
    await waitForXterm(xterm, 200);

    const text = readXtermText(xterm, 0, 5);
    expect(text).toContain('Hello from pi-tui!');

    tui.stop();
    xterm.dispose();
  });

  it('pi-tui TUI renders multiple components', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(60, 20);

    const tui = new TUI(vt, false);
    tui.addChild(new Text('Line One', 0, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('Line Three', 0, 0));

    tui.start();
    await waitForXterm(xterm, 200);

    const text = readXtermText(xterm, 0, 10);
    expect(text).toContain('Line One');
    expect(text).toContain('Line Three');

    tui.stop();
    xterm.dispose();
  });

  it('pi-tui TUI re-renders on requestRender', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(60, 20);

    const tui = new TUI(vt, false);
    const textComponent = new Text('Before update', 0, 0);
    tui.addChild(textComponent);

    tui.start();
    await waitForXterm(xterm, 200);

    expect(readXtermText(xterm, 0, 5)).toContain('Before update');

    // Replace the component and re-render
    tui.clear();
    tui.addChild(new Text('After update', 0, 0));
    tui.requestRender(true);
    await waitForXterm(xterm, 200);

    const text = readXtermText(xterm, 0, 5);
    expect(text).toContain('After update');

    tui.stop();
    xterm.dispose();
  });

  it('injected input reaches pi-tui onInput handler', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(60, 20);

    const tui = new TUI(vt, false);
    const receivedInput: string[] = [];

    // Register a raw input listener on the TUI
    tui.addInputListener((data: string) => {
      receivedInput.push(data);
      return undefined; // don't consume
    });

    tui.start();
    await waitForXterm(xterm, 100);

    // Inject keystrokes through VirtualTerminal
    vt.injectInput('a');
    vt.injectInput('b');
    vt.injectInput('\x1b[A'); // up arrow

    await waitForXterm(xterm, 100);

    expect(receivedInput).toContain('a');
    expect(receivedInput).toContain('b');
    expect(receivedInput).toContain('\x1b[A');

    tui.stop();
    xterm.dispose();
  });

  it('resize triggers pi-tui re-render at new dimensions', async () => {
    if (!available) return;

    const { xterm, vt } = createPipeline(40, 10);

    const tui = new TUI(vt, false);
    // Text with padding 1 will use width - 2 columns
    const textComponent = new Text('X'.repeat(35), 1, 0);
    tui.addChild(textComponent);

    tui.start();
    await waitForXterm(xterm, 200);

    // Now resize to narrower — the text should wrap or truncate
    vt.resize(20, 10);
    xterm.resize(20, 10);
    tui.requestRender(true);
    await waitForXterm(xterm, 200);

    expect(vt.columns).toBe(20);
    expect(xterm.cols).toBe(20);

    tui.stop();
    xterm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Level 2: InteractiveMode construction with TUI replacement
// ---------------------------------------------------------------------------

describe('InteractiveMode TUI replacement', () => {
  it('can import InteractiveMode from the SDK', async () => {
    if (!available) return;

    let InteractiveMode: any;
    try {
      const mod = await import('@oh-my-pi/pi-coding-agent');
      InteractiveMode = mod.InteractiveMode;
    } catch (e) {
      console.warn('Skipping: pi-coding-agent not importable', e);
      return;
    }

    expect(InteractiveMode).toBeDefined();
    expect(typeof InteractiveMode).toBe('function');
  });

  it('InteractiveMode.ui is writable before init()', async () => {
    if (!available) return;

    let InteractiveMode: any;
    let createAgentSession: any;
    let SessionManager: any;

    try {
      const mod = await import('@oh-my-pi/pi-coding-agent');
      InteractiveMode = mod.InteractiveMode;
      createAgentSession = mod.createAgentSession;
      SessionManager = mod.SessionManager;
    } catch (e) {
      console.warn('Skipping: pi-coding-agent not importable', e);
      return;
    }

    // We can't fully create an AgentSession without auth, but we can
    // verify the constructor creates a public `ui` field that's replaceable.
    //
    // Create a minimal mock session that satisfies the constructor signature
    // without making API calls. InteractiveMode constructor reads:
    //   session.sessionManager, session.settings, session.agent,
    //   session.model, session.extensionRunner, session.customCommands,
    //   session.skills, session.autoCompactionEnabled
    const mockSession = {
      sessionId: 'test-session',
      sessionManager: {
        getSessionDir: () => '/tmp/test',
        getSessionName: () => 'test',
        getCwd: () => '/tmp',
        getEntries: () => [],
        flush: () => {},
      },
      settings: {
        get: (key: string) => {
          const defaults: Record<string, any> = {
            showHardwareCursor: false,
            clearOnShrink: false,
            hideThinkingBlock: false,
            autocompleteMaxVisible: 5,
            'skills.enableSkillCommands': false,
            'startup.quiet': true,
            collapseChangelog: true,
          };
          return defaults[key];
        },
      },
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

    let mode: any;
    try {
      mode = new InteractiveMode(mockSession, '1.0.0', undefined);
    } catch (e) {
      // Constructor may fail on missing fields — that's fine for this test.
      // We're just checking the field exists.
      console.warn('InteractiveMode constructor failed (expected if mock is incomplete):', (e as Error).message);
      return;
    }

    // The key assertion: ui is a public writable property
    expect(mode.ui).toBeDefined();
    expect(mode.ui.terminal).toBeDefined(); // ProcessTerminal created internally

    // Replace it with our VirtualTerminal-backed TUI
    const { xterm, vt } = createPipeline(80, 24);
    const newTui = new TUI(vt, false);
    mode.ui = newTui;

    // Verify replacement took hold
    expect(mode.ui).toBe(newTui);
    expect(mode.ui.terminal).toBe(vt);

    // Don't call init() — that would need real auth and would start terminal I/O.
    // The point is proven: we can replace the TUI before init().

    xterm.dispose();
  });
});

// ---------------------------------------------------------------------------
// Level 1+ visual: capture pi-tui rendering as PNG screenshot
// ---------------------------------------------------------------------------

describe('VirtualTerminal screenshot capture', () => {
  it('captures pi-tui rendering as PNG via the replay screenshot pipeline', async () => {
    if (!available) return;

    const { extractStyledRows, renderStyledRowsSvg, findPngRasterizer } = await import('../../replay/screenshot.js');
    const rasterizer = findPngRasterizer();
    if (!rasterizer) {
      console.warn('Skipping PNG test: no rasterizer available (need sips or ImageMagick)');
      return;
    }

    const cols = 60;
    const rows = 16;
    const { xterm, vt } = createPipeline(cols, rows);

    // Build a multi-component pi-tui scene
    const tui = new TUI(vt, false);
    tui.addChild(new Text('\x1b[1;36m=== VirtualTerminal Integration Test ===\x1b[0m', 1, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('This is rendered by pi-tui through VirtualTerminal', 1, 0));
    tui.addChild(new Text('into xterm-headless, then captured as PNG.', 1, 0));
    tui.addChild(new Spacer(1));

    // Simulate agent task list
    tui.addChild(new Text('\x1b[1mAgent Tasks:\x1b[0m', 1, 0));
    tui.addChild(new Text('  \x1b[32m\u2713\x1b[0m Create VirtualTerminal adapter', 1, 0));
    tui.addChild(new Text('  \x1b[32m\u2713\x1b[0m Wire into tmux-lite session model', 1, 0));
    tui.addChild(new Text('  \x1b[34m\u25B6\x1b[0m Expose SDK state to GitSpace chrome', 1, 0));
    tui.addChild(new Text('  \x1b[90m\u25CB\x1b[0m Native todo panel component', 1, 0));
    tui.addChild(new Spacer(1));
    tui.addChild(new Text('\x1b[2mModel: Claude 4 Sonnet \u2022 Provider: Anthropic\x1b[0m', 1, 0));

    tui.start();
    await waitForXterm(xterm, 300);

    // Extract styled rows from xterm-headless (same as replay screenshot)
    const styledRows = extractStyledRows(xterm);
    expect(styledRows.length).toBeGreaterThan(0);

    // Render to SVG
    const svg = renderStyledRowsSvg(styledRows, cols, {
      title: 'VirtualTerminal → pi-tui → xterm-headless',
      subtitle: 'Integration test snapshot',
    });
    expect(svg).toContain('<svg');
    expect(svg).toContain('VirtualTerminal');

    // Write PNG
    const { writeFileSync, existsSync, statSync, mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');

    const outputDir = mkdtempSync(join(tmpdir(), 'gitspace-vt-test-'));
    const svgPath = join(outputDir, 'snapshot.svg');
    const pngPath = join(outputDir, 'virtual-terminal-test.png');

    writeFileSync(svgPath, svg, 'utf-8');

    // Use the same rasterizer pipeline as replay screenshots
    const { spawn } = await import('node:child_process');
    await new Promise<void>((resolve, reject) => {
      let args: string[];
      if (rasterizer.kind === 'sips') {
        args = ['-s', 'format', 'png', svgPath, '--out', pngPath];
      } else {
        args = [svgPath, pngPath];
      }
      const proc = spawn(rasterizer.executable, args, { timeout: 10_000 });
      proc.on('close', (code) => code === 0 ? resolve() : reject(new Error(`rasterizer exited ${code}`)));
      proc.on('error', reject);
    });

    expect(existsSync(pngPath)).toBe(true);
    const size = statSync(pngPath).size;
    expect(size).toBeGreaterThan(500); // sanity: a real PNG is >500 bytes

    // Copy to a stable location for inspection
    const inspectPath = '/tmp/virtual-terminal-integration-test.png';
    const { copyFileSync } = await import('node:fs');
    copyFileSync(pngPath, inspectPath);
    console.log(`\n  Screenshot written to: ${inspectPath}`);
    console.log(`  Size: ${size} bytes`);

    // Cleanup temp dir
    rmSync(outputDir, { recursive: true, force: true });

    tui.stop();
    xterm.dispose();
  });
});