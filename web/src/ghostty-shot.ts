import { init, Terminal as GhosttyTerminal } from 'ghostty-web';

type Example = {
  id: string;
  title: string;
  subtitle: string;
  cols: number;
  rows: number;
  ansi: string;
};

const CSI = '\x1b[';
const OSC = '\x1b]';
const RESET = `${CSI}0m`;
const CLEAR = `${CSI}2J${CSI}H`;

function sgr(...codes: Array<number | string>): string {
  return `${CSI}${codes.join(';')}m`;
}

function oscTitle(value: string): string {
  return `${OSC}0;${value}\x07`;
}

function line(value = ''): string {
  return `${value}\r\n`;
}

const examples: Example[] = [
  {
    id: 'palette',
    title: 'ANSI Palette + Attributes',
    subtitle: 'bold, underline, inverse, dim, bright colors',
    cols: 84,
    rows: 22,
    ansi: [
      oscTitle('Ghostty Screenshot Lab'),
      CLEAR,
      line(`${sgr(1, 38, 5, 81)}GitSpace replay screenshot lab${RESET}`),
      line(`${sgr(2, 37)}Testing Ghostty-web fidelity for color-rich terminal captures.${RESET}`),
      line(),
      line(`${sgr(1)}Base palette${RESET}`),
      line(`  ${sgr(30)}black${RESET}  ${sgr(31)}red${RESET}  ${sgr(32)}green${RESET}  ${sgr(33)}yellow${RESET}  ${sgr(34)}blue${RESET}  ${sgr(35)}magenta${RESET}  ${sgr(36)}cyan${RESET}  ${sgr(37)}white${RESET}`),
      line(`  ${sgr(90)}bright black${RESET}  ${sgr(91)}bright red${RESET}  ${sgr(92)}bright green${RESET}  ${sgr(93)}bright yellow${RESET}`),
      line(`  ${sgr(94)}bright blue${RESET}  ${sgr(95)}bright magenta${RESET}  ${sgr(96)}bright cyan${RESET}  ${sgr(97)}bright white${RESET}`),
      line(),
      line(`${sgr(1)}Attributes${RESET}`),
      line(`  ${sgr(1, 38, 5, 120)}bold${RESET}  ${sgr(2, 38, 5, 246)}dim${RESET}  ${sgr(3, 38, 5, 215)}italic${RESET}  ${sgr(4, 38, 5, 75)}underline${RESET}  ${sgr(9, 38, 5, 203)}strike${RESET}`),
      line(`  ${sgr(7, 38, 5, 232, 48, 5, 159)}inverse video${RESET}  ${sgr(38, 2, 255, 121, 198)}truecolor pink${RESET}  ${sgr(48, 2, 17, 85, 204, 38, 2, 255, 255, 255)}rgb bg${RESET}`),
      line(),
      line(`${sgr(1)}Borders + selection-like blocks${RESET}`),
      line(`  ${sgr(48, 5, 238)}        ${RESET}${sgr(48, 5, 31)}        ${RESET}${sgr(48, 5, 64)}        ${RESET}${sgr(48, 5, 130)}        ${RESET}${sgr(48, 5, 196)}        ${RESET}`),
      line(`  ${sgr(38, 5, 244)}╭──────────────────────────────────────────────────────────────╮${RESET}`),
      line(`  ${sgr(38, 5, 244)}│${RESET} ${sgr(38, 5, 195)}Need feedback on spacing, palette, and text weight.${RESET} ${sgr(38, 5, 244)}│${RESET}`),
      line(`  ${sgr(38, 5, 244)}╰──────────────────────────────────────────────────────────────╯${RESET}`),
      line(),
      line(`${sgr(2, 37)}example=palette theme=gitspace-dark renderer=ghostty-web${RESET}`),
      `${CSI}?25l`,
    ].join(''),
  },
  {
    id: 'git-diff',
    title: 'Git Diff',
    subtitle: 'mixed insertions, deletions, headers, comments, search hits',
    cols: 100,
    rows: 24,
    ansi: [
      oscTitle('git diff --color'),
      CLEAR,
      line(`${sgr(38, 5, 39)}diff --git a/src/lib/tmux-lite/replay/screenshot.ts b/src/lib/tmux-lite/replay/screenshot.ts${RESET}`),
      line(`${sgr(38, 5, 244)}index 8f01ca1..f4a3d77 100644${RESET}`),
      line(`${sgr(31)}--- a/src/lib/tmux-lite/replay/screenshot.ts${RESET}`),
      line(`${sgr(32)}+++ b/src/lib/tmux-lite/replay/screenshot.ts${RESET}`),
      line(`${sgr(38, 5, 81)}@@ -84,12 +84,28 @@ export function renderTerminalSnapshotSvg(...)${RESET}`),
      line(` ${sgr(38, 5, 244)}const includeScrollback = options.includeScrollback ?? false;${RESET}`),
      line(`${sgr(31)}-const textElements = lineText.map((line, index) => {${RESET}`),
      line(`${sgr(31)}-  return \`<text x="${'${paddingX}'}" y="${'${y}'}">${'${content}'}</text>\`;${RESET}`),
      line(`${sgr(31)}-}).join('');${RESET}`),
      line(`${sgr(32)}+const styledRows = snapshot.screen.styledVisible.map((row, rowIndex) => {${RESET}`),
      line(`${sgr(32)}+  return renderStyledRowSvg({${RESET}`),
      line(`${sgr(32)}+    row,${RESET}`),
      line(`${sgr(32)}+    y: headerHeight + paddingY + fontSize + rowIndex * cellHeight,${RESET}`),
      line(`${sgr(32)}+    cellWidth,${RESET}`),
      line(`${sgr(32)}+    cellHeight,${RESET}`),
      line(`${sgr(32)}+  });${RESET}`),
      line(`${sgr(32)}+}).join('');${RESET}`),
      line(),
      line(`${sgr(90)}// TODO(brad): compare this to actual Ghostty screenshots side-by-side${RESET}`),
      line(`${sgr(33)}@@ reviewer${RESET} ${sgr(38, 5, 111)}This is the kind of screenshot fidelity pass we should ship next.${RESET}`),
      line(),
      line(`${sgr(2, 37)}Search: ${RESET}${sgr(30, 43)}renderStyledRowSvg${RESET} ${sgr(2, 37)}  7 matches  [1/7]${RESET}`),
      `${CSI}?25l`,
    ].join(''),
  },
  {
    id: 'dashboard',
    title: 'Build Dashboard',
    subtitle: 'box drawing, progress bars, wrapped log chunks, warnings',
    cols: 104,
    rows: 26,
    ansi: [
      oscTitle('build dashboard'),
      CLEAR,
      line(`${sgr(1, 38, 5, 81)}GitSpace Build Dashboard${RESET} ${sgr(2, 37)}recorded-resumable-sessions${RESET}`),
      line(`${sgr(38, 5, 244)}┌───────────────────────┬────────────┬──────────┬──────────────────────────────┐${RESET}`),
      line(`${sgr(38, 5, 244)}│${RESET} ${sgr(1)}Stage${RESET}                 ${sgr(38, 5, 244)}│${RESET} ${sgr(1)}Status${RESET}     ${sgr(38, 5, 244)}│${RESET} ${sgr(1)}Duration${RESET} ${sgr(38, 5, 244)}│${RESET} ${sgr(1)}Notes${RESET}                        ${sgr(38, 5, 244)}│${RESET}`),
      line(`${sgr(38, 5, 244)}├───────────────────────┼────────────┼──────────┼──────────────────────────────┤${RESET}`),
      line(`${sgr(38, 5, 244)}│${RESET} typecheck             ${sgr(38, 5, 244)}│${RESET} ${sgr(32)}passed${RESET}     ${sgr(38, 5, 244)}│${RESET} 12.4s    ${sgr(38, 5, 244)}│${RESET} strict TS, zero errors          ${sgr(38, 5, 244)}│${RESET}`),
      line(`${sgr(38, 5, 244)}│${RESET} replay screenshots     ${sgr(38, 5, 244)}│${RESET} ${sgr(33)}running${RESET}    ${sgr(38, 5, 244)}│${RESET} 04.1s    ${sgr(38, 5, 244)}│${RESET} capturing Ghostty review frames ${sgr(38, 5, 244)}│${RESET}`),
      line(`${sgr(38, 5, 244)}│${RESET} remote parity          ${sgr(38, 5, 244)}│${RESET} ${sgr(90)}pending${RESET}    ${sgr(38, 5, 244)}│${RESET} --       ${sgr(38, 5, 244)}│${RESET} out of scope for this pass      ${sgr(38, 5, 244)}│${RESET}`),
      line(`${sgr(38, 5, 244)}└───────────────────────┴────────────┴──────────┴──────────────────────────────┘${RESET}`),
      line(),
      line(` ${sgr(38, 5, 244)}replay render:${RESET} ${sgr(48, 5, 237, 38, 5, 255)} ##############      ${RESET} ${sgr(38, 5, 81)}68%${RESET}`),
      line(` ${sgr(38, 5, 244)}png encode:   ${RESET} ${sgr(48, 5, 22, 38, 5, 255)} ##########          ${RESET} ${sgr(38, 5, 120)}49%${RESET}`),
      line(),
      line(`${sgr(1, 38, 5, 220)}WARN${RESET} ${sgr(38, 5, 252)}wrapped log output should still look good inside the screenshot frame even when the terminal width forces long explanatory sentences to continue across multiple visual rows.${RESET}`),
      line(`${sgr(38, 5, 244)}[15:42:08]${RESET} ${sgr(38, 5, 110)}renderer${RESET} loaded font ${sgr(1)}JetBrains Mono${RESET} in 112ms`),
      line(`${sgr(38, 5, 244)}[15:42:09]${RESET} ${sgr(38, 5, 110)}renderer${RESET} wrote ${sgr(38, 5, 81)}24${RESET} styled rows and ${sgr(38, 5, 81)}196${RESET} text spans`),
      line(`${sgr(38, 5, 244)}[15:42:10]${RESET} ${sgr(38, 5, 110)}review${RESET} waiting on human feedback for contrast, padding, and cursor visibility`),
      `${CSI}?25l`,
    ].join(''),
  },
];

function getExample(exampleId: string | null): Example {
  return examples.find((example) => example.id === exampleId) ?? examples[0];
}

function injectBaseStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    :root {
      color-scheme: dark;
      font-family: Inter, system-ui, sans-serif;
      background: radial-gradient(circle at top, #1c2430 0%, #0b0f14 55%, #06080c 100%);
      color: #e6edf3;
    }

    * { box-sizing: border-box; }

    body {
      margin: 0;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }

    #app {
      width: max-content;
      max-width: 100%;
    }

    .shot-shell {
      display: flex;
      flex-direction: column;
      gap: 14px;
      padding: 18px;
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 24px;
      background: linear-gradient(180deg, rgba(14, 20, 28, 0.92), rgba(9, 13, 18, 0.96));
      box-shadow: 0 30px 90px rgba(0, 0, 0, 0.4);
    }

    .shot-label {
      display: flex;
      flex-direction: column;
      gap: 4px;
      padding: 0 4px;
    }

    .shot-title {
      font-size: 16px;
      font-weight: 650;
      letter-spacing: 0.01em;
    }

    .shot-subtitle {
      font-size: 12px;
      color: #8b949e;
    }

    .terminal-frame {
      width: max-content;
      border-radius: 18px;
      overflow: hidden;
      border: 1px solid rgba(255, 255, 255, 0.08);
      background: #0d1117;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
    }

    .terminal-chrome {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 14px;
      background: linear-gradient(180deg, #171d26, #121820);
      border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    }

    .terminal-dots {
      display: flex;
      gap: 8px;
    }

    .terminal-dot {
      width: 10px;
      height: 10px;
      border-radius: 999px;
    }

    .terminal-name {
      font-size: 12px;
      font-weight: 600;
      color: #c9d1d9;
    }

    .terminal-meta {
      font-size: 11px;
      color: #7d8590;
    }

    .terminal-body {
      padding: 12px;
      background: #0d1117;
    }

    .terminal-host {
      width: max-content;
    }

    .terminal-host canvas {
      display: block;
      border-radius: 10px;
      background: #0d1117;
    }
  `;
  document.head.appendChild(style);
}

async function main(): Promise<void> {
  injectBaseStyles();
  const params = new URLSearchParams(window.location.search);
  const example = getExample(params.get('example'));

  const app = document.getElementById('app');
  if (!app) {
    throw new Error('Missing app root');
  }

  app.innerHTML = `
    <div class="shot-shell">
      <div class="shot-label">
        <div class="shot-title">${example.title}</div>
        <div class="shot-subtitle">${example.subtitle}</div>
      </div>
      <div class="terminal-frame">
        <div class="terminal-chrome">
          <div class="terminal-dots">
            <span class="terminal-dot" style="background:#ff5f57"></span>
            <span class="terminal-dot" style="background:#febc2e"></span>
            <span class="terminal-dot" style="background:#28c840"></span>
          </div>
          <div class="terminal-name">${example.id}</div>
          <div class="terminal-meta">${example.cols}x${example.rows}</div>
        </div>
        <div class="terminal-body">
          <div class="terminal-host" id="terminal-host"></div>
        </div>
      </div>
    </div>
  `;

  await init();

  const host = document.getElementById('terminal-host');
  if (!host) {
    throw new Error('Missing terminal host');
  }

  const terminal = new GhosttyTerminal({
    fontSize: 14,
    fontFamily: "'JetBrains Mono', 'SF Mono', Monaco, monospace",
    cursorStyle: 'block',
    cursorBlink: false,
    theme: {
      background: '#0d1117',
      foreground: '#e6edf3',
      cursor: '#58a6ff',
      cursorAccent: '#0d1117',
      selectionBackground: '#264f78',
      selectionForeground: '#f0f6fc',
      black: '#484f58',
      red: '#ff7b72',
      green: '#3fb950',
      yellow: '#d29922',
      blue: '#58a6ff',
      magenta: '#bc8cff',
      cyan: '#39c5cf',
      white: '#b1bac4',
      brightBlack: '#6e7681',
      brightRed: '#ffa198',
      brightGreen: '#56d364',
      brightYellow: '#e3b341',
      brightBlue: '#79c0ff',
      brightMagenta: '#d2a8ff',
      brightCyan: '#56d4dd',
      brightWhite: '#f0f6fc',
    },
  });

  terminal.open(host);
  terminal.resize(example.cols, example.rows);
  terminal.write(example.ansi, () => {
    document.body.setAttribute('data-shot-ready', example.id);
  });
}

void main();
