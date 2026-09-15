const port = Number(process.env.PORT);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('GitSpace did not provide a valid PORT');
const hostname = process.env.HOST ?? '127.0.0.1';
const server = Bun.serve({
  hostname,
  port,
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/healthz') return Response.json({ status: 'ok', service: 'inspector-proof', port: server.port });
    return new Response(`<!doctype html><meta charset="utf-8"><style>body{background:#0f172a;color:#e2e8f0;font:16px system-ui;padding:40px}h1{color:#a5b4fc}code{color:#86efac}</style><h1>GitSpace workspace service</h1><p>OMP Hub owns this process.</p><p>Stable allocated port: <code>${server.port}</code></p>`, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
});
console.log(JSON.stringify({ event: 'service.ready', service: 'inspector-proof', hostname, port: server.port }));
