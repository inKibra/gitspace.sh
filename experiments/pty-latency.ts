/**
 * Pure latency test - measure keystroke round-trip time
 */
import { unlinkSync } from "fs";

const SOCKET_PATH = "/tmp/spaces-latency.sock";
try { unlinkSync(SOCKET_PATH); } catch {}

let terminal: Bun.Terminal;
let clientSocket: any;

const server = Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      clientSocket = socket;
      terminal = new Bun.Terminal({
        cols: 80,
        rows: 24,
        data(term, output) {
          socket.write(output);
        }
      });

      // Spawn cat - echoes input immediately
      Bun.spawn(["cat"], { terminal });
    },
    data(socket, data) {
      terminal.write(data);
    },
  }
});

await Bun.sleep(50);

const latencies: number[] = [];
let pendingResolve: ((t: number) => void) | null = null;
let sendTime = 0;

const client = await Bun.connect({
  unix: SOCKET_PATH,
  socket: {
    data(socket, data) {
      if (pendingResolve) {
        const latency = performance.now() - sendTime;
        pendingResolve(latency);
        pendingResolve = null;
      }
    },
  }
});

async function measureRoundTrip(): Promise<number> {
  return new Promise(resolve => {
    pendingResolve = resolve;
    sendTime = performance.now();
    client.write("x");
  });
}

// Warmup
for (let i = 0; i < 10; i++) {
  await measureRoundTrip();
}

// Measure
console.log("Measuring 1000 keystroke round-trips over Unix socket...\n");

for (let i = 0; i < 1000; i++) {
  const lat = await measureRoundTrip();
  latencies.push(lat);
}

latencies.sort((a, b) => a - b);

const avg = latencies.reduce((a, b) => a + b) / latencies.length;
const p50 = latencies[Math.floor(latencies.length * 0.5)];
const p95 = latencies[Math.floor(latencies.length * 0.95)];
const p99 = latencies[Math.floor(latencies.length * 0.99)];
const min = latencies[0];
const max = latencies[latencies.length - 1];

console.log("=== Keystroke Round-Trip Latency ===");
console.log(`Min:    ${min.toFixed(3)} ms`);
console.log(`Avg:    ${avg.toFixed(3)} ms`);
console.log(`P50:    ${p50.toFixed(3)} ms`);
console.log(`P95:    ${p95.toFixed(3)} ms`);
console.log(`P99:    ${p99.toFixed(3)} ms`);
console.log(`Max:    ${max.toFixed(3)} ms`);

// Compare to typical human perception
console.log("\n=== Context ===");
console.log(`Human perception threshold: ~13ms`);
console.log(`60 FPS frame time: 16.67ms`);
console.log(`Typical SSH local: 1-5ms`);
console.log(`Typical SSH remote: 20-100ms`);

server.stop();
client.end();
try { unlinkSync(SOCKET_PATH); } catch {}
