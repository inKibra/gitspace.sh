import { randomBytes } from "crypto";
import { createRelayServer } from "../../server";

type RelayServerConfig = Parameters<typeof createRelayServer>[0];

const DEFAULT_PORT_RANGE: [number, number] = [20000, 60000];
const DEFAULT_MAX_ATTEMPTS = 25;

function pickRandomPort([min, max]: [number, number]): number {
  const range = max - min + 1;
  const randomValue = randomBytes(4).readUInt32BE(0);
  return min + (randomValue % range);
}

function isPortInUseError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /EADDRINUSE/i.test(message) || /port .* in use/i.test(message);
}

export function startRelayServer(
  config: Omit<RelayServerConfig, "port"> & {
    port?: number;
    portRange?: [number, number];
    maxAttempts?: number;
  }
) {
  const {
    port,
    portRange = DEFAULT_PORT_RANGE,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    ...rest
  } = config;

  if (typeof port === "number") {
    return createRelayServer({ ...rest, port });
  }

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidate = pickRandomPort(portRange);
    try {
      return createRelayServer({ ...rest, port: candidate });
    } catch (error) {
      if (isPortInUseError(error)) {
        continue;
      }
      throw error;
    }
  }

  throw new Error("Failed to allocate relay port for tests");
}
