/**
 * Serve process hosting helpers tests
 */

import { describe, expect, test } from "bun:test";
import {
  buildServeIngressConfig,
  resolveCloudRelayUrlForConfig,
  type ProcessHostEntry,
} from "../serve";
import { buildProcessHostname, normalizeHostLabel } from "../../utils/hostnames";

describe("process hosting helpers", () => {
  test("normalizeHostLabel cleans and lowercases", () => {
    expect(normalizeHostLabel("My App")).toBe("my-app");
    expect(normalizeHostLabel("API__Server")).toBe("api-server");
    expect(normalizeHostLabel("---")).toBe("x");
  });

  test("buildProcessHostname assembles expected segments", () => {
    const hostname = buildProcessHostname(
      "brad.serve.gitspace.sh",
      "my-workspace",
      "web-api",
      2,
      "web"
    );

    expect(hostname).toBe('w-my-workspace-p-web-api-i-2-o-web.brad.serve.gitspace.sh');
  });

  test("buildServeIngressConfig adds fallback", () => {
    const entries: ProcessHostEntry[] = [
      {
        hostname: "alpha-api-1-web.brad.serve.gitspace.sh",
        service: "http://127.0.0.1:3000",
        protocol: "http",
        workspaceId: "alpha",
        processName: "api",
        instance: 1,
        port: 3000,
        portName: "web",
      },
      {
        hostname: "alpha-api-1-tcp.brad.serve.gitspace.sh",
        service: "tcp://127.0.0.1:9000",
        protocol: "tcp",
        workspaceId: "alpha",
        processName: "api",
        instance: 1,
        port: 9000,
        portName: "tcp",
      },
    ];

    const config = buildServeIngressConfig(entries);
    expect(config).toContain("ingress:");
    expect(config).toContain("hostname: alpha-api-1-web.brad.serve.gitspace.sh");
    expect(config).toContain("service: http://127.0.0.1:3000");
    expect(config).toContain("hostname: alpha-api-1-tcp.brad.serve.gitspace.sh");
    expect(config).toContain("service: tcp://127.0.0.1:9000");
    expect(config).toContain("service: http_status:404");
  });

  test("resolveCloudRelayUrlForConfig derives hosted relay url for 0.0.0.0 binds", () => {
    expect(resolveCloudRelayUrlForConfig('ws://0.0.0.0:4480/ws', {
      subdomain: 'brad',
      createdAt: Date.now(),
    })).toBe('wss://brad.gitspace.sh/ws');
  });

  test('buildProcessHostname preserves field-boundary uniqueness', () => {
    const first = buildProcessHostname(
      'brad.serve.gitspace.sh',
      'alpha-beta',
      'api',
      1,
      'web',
    );
    const second = buildProcessHostname(
      'brad.serve.gitspace.sh',
      'alpha',
      'beta-api',
      1,
      'web',
    );

    expect(first).not.toBe(second);
  });
});
