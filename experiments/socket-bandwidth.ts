/**
 * Unix socket bandwidth test
 * How much can we push through a single socket?
 */
import { unlinkSync } from "fs";

const SOCKET_PATH = "/tmp/spaces-bw.sock";
try { unlinkSync(SOCKET_PATH); } catch {}

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const TEST_DURATION_MS = 2000;

let totalBytes = 0;
let messageCount = 0;

const server = Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      totalBytes += data.byteLength;
      messageCount++;
      // Echo back (simulates bidirectional)
      socket.write(data);
    },
  }
});

await Bun.sleep(50);

const chunk = Buffer.alloc(CHUNK_SIZE, "x");
let clientReceived = 0;

const client = await Bun.connect({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      clientReceived += data.byteLength;
    },
    drain(socket) {
      // Socket ready for more data - keep pumping
      socket.write(chunk);
    }
  }
});

console.log("Testing Unix socket bandwidth (bidirectional)...\n");

const start = performance.now();

// Prime the pump
for (let i = 0; i < 100; i++) {
  client.write(chunk);
}

await Bun.sleep(TEST_DURATION_MS);

const elapsed = (performance.now() - start) / 1000;
const serverThroughput = (totalBytes / 1024 / 1024) / elapsed;
const clientThroughput = (clientReceived / 1024 / 1024) / elapsed;

console.log("=== Single Socket Bandwidth ===");
console.log(`Server received: ${(totalBytes / 1024 / 1024).toFixed(0)} MB`);
console.log(`Client received: ${(clientReceived / 1024 / 1024).toFixed(0)} MB`);
console.log(`Server throughput: ${serverThroughput.toFixed(0)} MB/s`);
console.log(`Client throughput: ${clientThroughput.toFixed(0)} MB/s`);
console.log(`Messages: ${messageCount}`);
console.log(`Avg chunk: ${(totalBytes / messageCount / 1024).toFixed(1)} KB`);

// Context
console.log("\n=== Context ===");
console.log(`4K terminal @ 60fps: ~${(4000 * 60 * 60 / 1024 / 1024).toFixed(1)} MB/s worst case`);
console.log(`Typical terminal use: < 1 MB/s`);
console.log(`10 concurrent sessions: < 10 MB/s`);

server.stop();
client.end();
try { unlinkSync(SOCKET_PATH); } catch {}
