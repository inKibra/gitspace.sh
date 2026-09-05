export {};
const url = process.argv[2];
if (!url) throw new Error('RPC URL is required');
// `/rpc` requires a device signature; readiness is the unauthenticated health endpoint beside it.
const response = await fetch(new URL('/health', url));
if (!response.ok) throw new Error(`GitSpace machine health failed with ${response.status}`);
const health = await response.json() as { status?: unknown; generation?: unknown };
if (health.status !== 'ok') throw new Error('GitSpace machine is not healthy');
console.log(JSON.stringify({ status: 'ok', generation: health.generation ?? null }));
