/**
 * VO recorder server: teleprompter + mic recorder against a rendered episode.
 *   bun tools/serve.ts   →   http://localhost:5190
 * Serves the recorder page at / and rendered episodes from marketing/out/.
 */
const marketingRoot = new URL('../..', import.meta.url).pathname;

Bun.serve({
  port: 5190,
  fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const path = p === '/' ? '/video/tools/record-vo.html' : p;
    return new Response(Bun.file(marketingRoot + path));
  },
});

console.log('VO recorder → http://localhost:5190');
