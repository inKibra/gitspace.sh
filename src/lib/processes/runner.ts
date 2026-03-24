#!/usr/bin/env bun
/**
 * Process runner + event collector
 */

import { spawn } from "bun";
import { readFileSync } from "fs";
import { join } from "path";
import { WideEventCollector } from "../events/collector.js";
import { buildProcessEventsConfig } from "./events-config.js";
import { loadProcessesConfig, getProcessDefinition } from "./config.js";
import { recordProcessExit } from "./state.js";
import { buildProcessHostname } from "../../utils/hostnames.js";
import type { WideEvent } from "../../types/events.js";

interface RunnerOptions {
  workspacePath: string;
  processName: string;
  instance: number;
}

function parseArgs(argv: string[]): RunnerOptions {
  const args = new Map<string, string>();
  const filtered = argv.filter((arg) => arg !== "--internal-process-runner");
  for (let i = 0; i < filtered.length; i += 2) {
    const key = filtered[i];
    const value = filtered[i + 1];
    if (!key || !value) {
      continue;
    }
    args.set(key, value);
  }

  const workspacePath = args.get("--workspace");
  const processName = args.get("--process");
  const instanceRaw = args.get("--instance");

  if (!workspacePath || !processName || !instanceRaw) {
    throw new Error("Usage: --workspace <path> --process <name> --instance <n>");
  }

  const instance = Number.parseInt(instanceRaw, 10);
  if (!Number.isFinite(instance) || instance <= 0) {
    throw new Error(`Invalid instance value: ${instanceRaw}`);
  }

  return { workspacePath, processName, instance };
}

function printEventLine(event: WideEvent): void {
  const level = event.level.toUpperCase();
  const message = event.message.trim();
  const label = `${event.eventName} (${event.eventId})`;
  console.log(`[event:${level}] ${label} — ${message}`);
}

function shouldSuppressRaw(definition: ReturnType<typeof getProcessDefinition>): boolean {
  if (!definition) return true;
  if (definition.events?.enabled === false) return true;
  if (definition.events?.mode === "json") return false;
  return definition.events?.keepRawOutput === true ? false : true;
}

async function run(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const config = loadProcessesConfig(opts.workspacePath);
  const definition = getProcessDefinition(config, opts.processName);

  if (!definition?.command) {
    throw new Error(`Process ${opts.processName} is missing command`);
  }

  const cwd = definition.cwd ? join(opts.workspacePath, definition.cwd) : opts.workspacePath;
  const commandArgs = [definition.command, ...(definition.args ?? [])];
  const workspaceId = opts.workspacePath.split("/").pop() ?? opts.workspacePath;
  // Inject PORT from the first declared port (gitspace owns port allocation)
  const firstPort = definition.ports?.[0];
  const serveDomain = process.env.GITSPACE_SERVE_DOMAIN;
  const portEnv: Record<string, string> = {};
  if (firstPort?.port) {
    portEnv.PORT = String(firstPort.port);
  }
  if (serveDomain && firstPort) {
    const portLabel = firstPort.name?.trim() || String(firstPort.port);
    const hostname = buildProcessHostname(serveDomain, workspaceId, opts.processName, opts.instance, portLabel);
    portEnv.GITSPACE_SERVE_URL = `https://${hostname}`;
  }

  const env = {
    ...process.env,
    ...(definition.env ?? {}),
    ...portEnv,
    GITSPACE_PROCESS_NAME: opts.processName,
    GITSPACE_PROCESS_INSTANCE: String(opts.instance),
    TMUX_LITE: process.env.TMUX_LITE ?? "runner",
  } as Record<string, string>;

  const processName = opts.processName;
  const projectName = opts.workspacePath.split("/").slice(-3, -2)[0] ?? "";
  const eventsConfig = buildProcessEventsConfig(projectName, definition);

  const collector = new WideEventCollector({
    config: eventsConfig,
    sessionId: "",
    workspacePath: opts.workspacePath,
    workspaceId,
    projectName,
    processName,
    processInstance: opts.instance,
  });

  const suppressRaw = shouldSuppressRaw(definition);
  const prefix = eventsConfig.prefix || "@event";

  let stdoutBuffer = "";
  let stderrBuffer = "";

  const child = spawn({
    cmd: commandArgs,
    cwd,
    env,
    stdout: "pipe",
    stderr: "pipe",
  });

  const handleChunk = (data: Uint8Array, stream: "stdout" | "stderr") => {
    const buffer = Buffer.from(data);
    const rawText = buffer.toString("utf-8");

    const pending = stream === "stdout" ? stdoutBuffer : stderrBuffer;
    const combined = pending + rawText;
    const parts = combined.split("\n");

    let remainder = "";
    if (combined.endsWith("\n")) {
      parts.pop();
    } else {
      remainder = parts.pop() ?? "";
    }

    if (stream === "stdout") {
      stdoutBuffer = remainder;
    } else {
      stderrBuffer = remainder;
    }

    const eventLines: string[] = [];
    let nonEventPayload = "";
    let hasNonEventContent = false;

    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.startsWith(prefix)) {
        eventLines.push(trimmed);
      } else {
        nonEventPayload += `${line}\n`;
        if (trimmed.length > 0) {
          hasNonEventContent = true;
        }
      }
    }

    if (!suppressRaw) {
      if (stream === "stderr") {
        process.stderr.write(buffer);
      } else {
        process.stdout.write(buffer);
      }
    } else if (hasNonEventContent) {
      if (stream === "stderr") {
        process.stderr.write(nonEventPayload);
      } else {
        process.stdout.write(nonEventPayload);
      }
    }

    if (eventLines.length > 0) {
      const eventBuffer = Buffer.from(eventLines.join("\n") + "\n");
      const events = collector.handleChunk(eventBuffer);
      for (const event of events) {
        printEventLine(event);
      }
    }
  };

  const stdoutStream = child.stdout as ReadableStream<Uint8Array> | null;
  const streamDrains: Array<Promise<void>> = [];
  if (stdoutStream) {
    const reader = stdoutStream.getReader();
    const drain = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        handleChunk(value, "stdout");
      }
    })();
    streamDrains.push(drain);
  }

  const stderrStream = child.stderr as ReadableStream<Uint8Array> | null;
  if (stderrStream) {
    const reader = stderrStream.getReader();
    const drain = (async () => {
      while (true) {
        const { value, done } = await reader.read();
        if (done || !value) break;
        handleChunk(value, "stderr");
      }
    })();
    streamDrains.push(drain);
  }

  const exitCode = await child.exited;
  await Promise.all(streamDrains);
  collector.finalize();
  try {
    recordProcessExit(opts.workspacePath, opts.processName, opts.instance, exitCode ?? 0);
  } catch {}
  process.exit(exitCode ?? 0);
}

run().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`process runner failed: ${message}`);
  process.exit(1);
});
