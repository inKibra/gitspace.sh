/**
 * Ticket #42B (the backstop): transport-level WS payload cap.
 *
 * Root symptom: `[relay] machine ... disconnected (1006: Received too big
 * message)` at browser-connect time. Bun's default maxPayloadLength (16MB) is
 * enforced by uWebSockets at the TRANSPORT layer and closes the socket with
 * 1006 BEFORE our app-level parseMessage runs. These tests verify:
 *   1. RELAY_MAX_WS_PAYLOAD is set explicitly and generously above the 16MB
 *      app-level MAX_MESSAGE_SIZE.
 *   2. A frame larger than the old 16MB default no longer 1006-kills the
 *      relay WS connection — it is handled at the app layer instead.
 */

import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Server } from "bun";
import { generateRelayIdentity } from "../identity";
import { RELAY_MAX_WS_PAYLOAD, RELAY_WS_PAYLOAD_WARN } from "../protocol";
import { startRelayServer } from "./helpers/ports";
import { ensureControlStore } from "../control/store";
import type { WebSocketData } from "../types";

const TEST_HOST = "127.0.0.1";

describe("RELAY_MAX_WS_PAYLOAD constant", () => {
  const APP_MAX_MESSAGE_SIZE = 16 * 1024 * 1024;

  test("is set generously above the app-level 16MB message cap", () => {
    // The transport cap MUST exceed the app cap, otherwise a transiently-large
    // legit frame 1006-kills the socket before parseMessage ever runs.
    expect(RELAY_MAX_WS_PAYLOAD).toBeGreaterThan(APP_MAX_MESSAGE_SIZE);
    expect(RELAY_MAX_WS_PAYLOAD).toBe(64 * 1024 * 1024);
  });

  test("warn threshold sits below the hard cap", () => {
    expect(RELAY_WS_PAYLOAD_WARN).toBeGreaterThan(0);
    expect(RELAY_WS_PAYLOAD_WARN).toBeLessThan(RELAY_MAX_WS_PAYLOAD);
  });

  test("the relay Bun.serve config wires maxPayloadLength to the const", () => {
    // Guard against the config silently reverting to Bun's 16MB default.
    // Inspect the actual live server rather than trusting the source string.
    const identity = generateRelayIdentity("max-payload-config-test");
    const server = startRelayServer({
      bind: TEST_HOST,
      hostname: TEST_HOST,
      disableRateLimit: true,
      identity,
    });
    try {
      // Bun stores the websocket options; assert the value we passed is present.
      // (Not part of the public typed surface, hence the loose access.)
      const wsConfig = (server as unknown as { websocket?: { maxPayloadLength?: number } }).websocket;
      if (wsConfig && typeof wsConfig.maxPayloadLength === "number") {
        expect(wsConfig.maxPayloadLength).toBe(RELAY_MAX_WS_PAYLOAD);
      }
      // If Bun does not surface the config, the live round-trip test below is
      // the authoritative check.
    } finally {
      server.stop(true);
    }
  });
});

describe("relay does not 1006-kill oversize frames (live)", () => {
  let server: Server<WebSocketData>;
  let relayUrl = "";
  let relayHttpBase = "";
  let tempControlDir = "";
  let previousControlDir: string | undefined;

  beforeAll(async () => {
    previousControlDir = process.env.GITSPACE_CONTROL_DIR;
    tempControlDir = mkdtempSync(join(tmpdir(), "gssh-relay-maxpayload-test-"));
    process.env.GITSPACE_CONTROL_DIR = tempControlDir;
    ensureControlStore();

    server = startRelayServer({
      bind: TEST_HOST,
      hostname: TEST_HOST,
      disableRateLimit: true,
      identity: generateRelayIdentity("max-payload-live-test"),
    });
    relayUrl = `ws://${TEST_HOST}:${server.port}/ws?role=client`;
    relayHttpBase = `http://${TEST_HOST}:${server.port}`;

    const deadline = Date.now() + 3000;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      try {
        const res = await fetch(`${relayHttpBase}/health`);
        if (res.ok) break;
      } catch {
        // ignore until deadline
      }
      if (Date.now() > deadline) throw new Error("Relay did not become healthy");
      await new Promise((r) => setTimeout(r, 50));
    }
  });

  afterAll(() => {
    if (server) server.stop(true);
    if (previousControlDir === undefined) delete process.env.GITSPACE_CONTROL_DIR;
    else process.env.GITSPACE_CONTROL_DIR = previousControlDir;
    if (tempControlDir) rmSync(tempControlDir, { recursive: true, force: true });
  });

  test("a 20MB frame (over the old 16MB default) does not close with 1006", async () => {
    const ws = new WebSocket(relayUrl, { maxPayload: RELAY_MAX_WS_PAYLOAD });

    const outcome = await new Promise<
      | { kind: "message"; data: string }
      | { kind: "close"; code: number; reason: string }
      | { kind: "error"; message: string }
    >((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("test timed out")), 8000);
      const done = (r: Parameters<typeof resolve>[0]) => {
        clearTimeout(timer);
        resolve(r);
      };

      ws.on("open", () => {
        // 20MB payload: over Bun's default 16MB maxPayloadLength (which would
        // 1006-close before our handler), under RELAY_MAX_WS_PAYLOAD (64MB).
        // Non-JSON, so the relay app layer rejects it with INVALID_REQUEST
        // while keeping the connection alive — that response is the proof the
        // transport accepted the frame.
        ws.send("a".repeat(20 * 1024 * 1024));
      });
      ws.on("message", (data) => done({ kind: "message", data: data.toString() }));
      ws.on("close", (code, reason) =>
        done({ kind: "close", code, reason: reason.toString() }));
      ws.on("error", (err) => done({ kind: "error", message: err.message }));
    });

    try {
      // The failure mode we are guarding against is a transport 1006 close.
      if (outcome.kind === "close") {
        expect(outcome.code).not.toBe(1006);
      }
      // Positive proof: the relay's app layer handled the oversize frame and
      // replied (an INVALID_REQUEST error), i.e. the transport delivered it.
      expect(outcome.kind).toBe("message");
      if (outcome.kind === "message") {
        expect(outcome.data).toContain("INVALID_REQUEST");
      }
    } finally {
      try { ws.close(); } catch { /* ignore */ }
    }
  }, 15000);
});
