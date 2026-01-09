/**
 * PTY over Unix Socket Benchmark
 * Tests latency and throughput of piping PTY data over Unix domain sockets
 */

import { unlinkSync } from "fs";

const SOCKET_PATH = "/tmp/spaces-pty-bench.sock";

// Clean up any existing socket
try { unlinkSync(SOCKET_PATH); } catch {}

// ============== SERVER ==============
let serverTerminal: Bun.Terminal | null = null;
let serverProc: Bun.Subprocess | null = null;

const server = Bun.listen({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      console.log("[server] Client connected");
    },
    data(socket, data) {
      const msg = data.toString();

      if (msg.startsWith("{")) {
        const cmd = JSON.parse(msg);

        if (cmd.type === "run") {
          serverTerminal = new Bun.Terminal({
            cols: 120,
            rows: 40,
            data(term, output) {
              socket.write(output);
            }
          });

          serverProc = Bun.spawn(cmd.args, {
            terminal: serverTerminal,
            cwd: process.cwd(),
          });

          serverProc.exited.then(code => {
            socket.write(`\n__EXIT__${code}__`);
          });
        } else if (cmd.type === "resize") {
          serverTerminal?.resize(cmd.cols, cmd.rows);
        }
      } else {
        serverTerminal?.write(data);
      }
    },
    close(socket) {
      serverProc?.kill();
      serverTerminal?.close();
    },
    error(socket, error) {
      console.error("[server] Error:", error);
    }
  }
});

console.log(`[server] Listening on ${SOCKET_PATH}`);

// ============== CLIENT ==============
await Bun.sleep(50);

let bytesReceived = 0;
let messagesReceived = 0;
let startTime = 0;
let firstByteTime = 0;
let testResolve: () => void;

const client = await Bun.connect({
  unix: SOCKET_PATH,
  socket: {
    open(socket) {
      console.log("[client] Connected via Unix socket\n");
    },
    data(socket, data) {
      messagesReceived++;
      bytesReceived += data.byteLength;

      if (firstByteTime === 0) {
        firstByteTime = performance.now();
      }

      const str = data.toString();
      if (str.includes("__EXIT__")) {
        const elapsed = performance.now() - startTime;
        const throughput = (bytesReceived / 1024 / 1024) / (elapsed / 1000);
        const latency = firstByteTime - startTime;

        console.log(`\n--- Results ---`);
        console.log(`Bytes: ${(bytesReceived / 1024).toFixed(2)} KB`);
        console.log(`Chunks: ${messagesReceived}`);
        console.log(`Time: ${elapsed.toFixed(2)} ms`);
        console.log(`Throughput: ${throughput.toFixed(2)} MB/s`);
        console.log(`First byte: ${latency.toFixed(3)} ms`);
        testResolve?.();
      }
    },
    error(socket, error) {
      console.error("[client] Error:", error);
    }
  }
});

async function runTest(name: string, args: string[], waitMs = 2000) {
  console.log(`=== ${name} ===`);
  bytesReceived = 0;
  messagesReceived = 0;
  firstByteTime = 0;

  const done = new Promise<void>(r => { testResolve = r; });
  startTime = performance.now();
  client.write(JSON.stringify({ type: "run", args }));

  await Promise.race([done, Bun.sleep(waitMs)]);
}

await runTest("Latency: echo", ["echo", "hello"], 500);
await runTest("Throughput: seq 50k", ["seq", "1", "50000"], 3000);
await runTest("Realistic: ls -laR", ["ls", "-laR", "/usr/bin"], 5000);

// Interactive test
console.log("\n=== Interactive: bash session ===");
bytesReceived = 0;
messagesReceived = 0;
firstByteTime = 0;
startTime = performance.now();

client.write(JSON.stringify({ type: "run", args: ["bash"] }));
await Bun.sleep(100);

for (const cmd of ["echo test", "ls", "pwd", "exit"]) {
  await Bun.sleep(30);
  client.write(cmd + "\n");
}

await Bun.sleep(300);
console.log(`Interactive: ${(bytesReceived/1024).toFixed(2)} KB in ${(performance.now()-startTime).toFixed(0)} ms`);

server.stop();
client.end();
try { unlinkSync(SOCKET_PATH); } catch {}
console.log("\n✓ Done");
process.exit(0);
