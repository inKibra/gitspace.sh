const PORT = Number(process.env.PORT ?? 7777);
const SERVE_URL = process.env.GITSPACE_SERVE_URL;
const PROCESS_NAME = process.env.GITSPACE_PROCESS_NAME ?? 'sample-server';
const INSTANCE = process.env.GITSPACE_PROCESS_INSTANCE ?? '1';

const COLORS = ['\x1b[36m', '\x1b[33m', '\x1b[35m', '\x1b[32m', '\x1b[34m'];
const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const UNDERLINE = '\x1b[4m';

const pad = (s: string, n: number) => s.padEnd(n);
const rpad = (s: string, n: number) => s.padStart(n);

const METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];
const PATHS = [
  '/', '/api/health', '/api/workspaces', '/api/workspaces/:id',
  '/api/sessions', '/api/sessions/:id/attach', '/api/machines',
  '/api/relay/status', '/api/config', '/assets/main.js', '/assets/style.css',
  '/favicon.ico',
];

let reqCount = 0;

function wideLog(method: string, path: string, status: number, durationMs: number, extra?: string) {
  reqCount++;
  const ts = new Date().toISOString();
  const color = COLORS[reqCount % COLORS.length];
  const statusColor = status < 300 ? '\x1b[32m' : status < 400 ? '\x1b[33m' : '\x1b[31m';

  const id = rpad(`#${reqCount}`, 8);
  const methodStr = pad(method, 8);
  const pathStr = pad(path, 40);
  const statusStr = `${statusColor}${status}${RESET}`;
  const dur = rpad(`${durationMs.toFixed(1)}ms`, 10);
  const mem = rpad(`${(process.memoryUsage.rss() / 1024 / 1024).toFixed(1)}MB`, 9);
  const extraStr = extra ? `  ${DIM}${extra}${RESET}` : '';

  const sep = `${DIM}|${RESET}`;

  console.log(
    `${DIM}${ts}${RESET} ${sep} ${color}${id}${RESET} ${sep} ${BOLD}${methodStr}${RESET} ${sep} ${pathStr} ${sep} ${statusStr} ${sep} ${dur} ${sep} rss=${mem}${extraStr}`
  );
}

function banner() {
  const line = '='.repeat(120);
  console.log(`\n${BOLD}\x1b[36m+${line}+${RESET}`);
  console.log(`${BOLD}\x1b[36m|${RESET}  ${BOLD}${PROCESS_NAME}#${INSTANCE}${RESET}${' '.repeat(Math.max(1, 107 - PROCESS_NAME.length - INSTANCE.length - 1))}${BOLD}\x1b[36m|${RESET}`);
  console.log(`${BOLD}\x1b[36m|${RESET}  Listening on port ${PORT}${' '.repeat(Math.max(1, 107 - 20 - String(PORT).length))}${BOLD}\x1b[36m|${RESET}`);
  if (SERVE_URL) {
    const urlLine = `  ${UNDERLINE}${SERVE_URL}${RESET}`;
    const rawLen = SERVE_URL.length + 2;
    console.log(`${BOLD}\x1b[36m|${RESET}${urlLine}${' '.repeat(Math.max(1, 109 - rawLen))}${BOLD}\x1b[36m|${RESET}`);
  }
  console.log(`${BOLD}\x1b[36m+${line}+${RESET}\n`);

  const header = `${DIM}${'timestamp'.padEnd(24)} | ${'req'.padEnd(8)} | ${'method'.padEnd(8)} | ${'path'.padEnd(40)} | ${'st'.padEnd(3)}  | ${'duration'.padEnd(10)} | memory${RESET}`;
  console.log(header);
  console.log(DIM + '-'.repeat(120) + RESET);
}

const HTML = `<!DOCTYPE html>
<html>
<head><title>${PROCESS_NAME}</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0d1117; color: #c9d1d9; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 2rem 3rem; text-align: center; max-width: 500px; }
  h1 { color: #58a6ff; margin: 0 0 0.5rem; }
  p { color: #8b949e; margin: 0.25rem 0; }
  code { background: #21262d; padding: 2px 6px; border-radius: 4px; font-size: 0.9em; }
  .up { color: #3fb950; font-weight: 600; }
  a { color: #58a6ff; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .serve-url { margin-top: 1rem; padding: 0.75rem; background: #21262d; border-radius: 8px; }
</style>
</head>
<body>
  <div class="card">
    <h1>gitspace sample-server</h1>
    <p class="up">running on port ${PORT}</p>
    <p>Request count: <code id="c">-</code></p>
    ${SERVE_URL ? `<div class="serve-url"><p style="font-size:0.75em;color:#484f58;margin:0 0 0.25rem">Serve URL</p><a href="${SERVE_URL}" target="_blank">${SERVE_URL}</a></div>` : ''}
    <p style="margin-top:1rem;font-size:0.8em;color:#484f58">Served by <code>.gitspace/processes.json</code></p>
  </div>
  <script>document.getElementById('c').textContent = new URLSearchParams(location.search).get('n') || '?';</script>
</body>
</html>`;

const server = Bun.serve({
  port: PORT,
  fetch(req) {
    const start = performance.now();
    const url = new URL(req.url);
    const method = req.method;
    const path = url.pathname;

    // health endpoint
    if (path === '/api/health') {
      const dur = performance.now() - start;
      wideLog(method, path, 200, dur, 'type=health');
      return Response.json({ status: 'ok', uptime: process.uptime(), requests: reqCount, serveUrl: SERVE_URL });
    }

    // json api stub
    if (path.startsWith('/api/')) {
      const dur = performance.now() - start;
      wideLog(method, path, 200, dur, `type=api  query=${url.search || 'none'}`);
      return Response.json({ path, method, ts: Date.now(), reqCount });
    }

    // html page
    const dur = performance.now() - start;
    wideLog(method, path, 200, dur, `type=html  ua=${req.headers.get('user-agent')?.slice(0, 50) ?? 'unknown'}`);
    return new Response(HTML.replace("'?'", `'${reqCount}'`), {
      headers: { 'content-type': 'text/html' },
    });
  },
});

banner();

// emit synthetic traffic logs periodically so there's always something to see
setInterval(() => {
  const method = METHODS[Math.floor(Math.random() * METHODS.length)];
  const path = PATHS[Math.floor(Math.random() * PATHS.length)];
  const status = Math.random() > 0.9 ? 404 : Math.random() > 0.95 ? 500 : 200;
  const dur = Math.random() * 80 + 0.5;
  wideLog(method, path, status, dur, `type=synthetic  worker=${Math.floor(Math.random() * 4)}`);
}, 1500);
