import { checkCommandExists } from './deps.js';
import { logger } from './logger.js';

type CloudflaredStream = 'stdout' | 'stderr';

interface CloudflaredOutputProcess {
  stdout: unknown;
  stderr: unknown;
}

interface TrackCloudflaredOutputOptions {
  includeLine?: (line: string, stream: CloudflaredStream) => boolean;
}

function isReadableStream(value: unknown): value is ReadableStream<Uint8Array> {
  return typeof value === 'object' && value !== null && 'getReader' in value;
}

export async function isCloudflaredInstalled(): Promise<boolean> {
  return checkCommandExists('cloudflared');
}

export function trackCloudflaredOutput(
  proc: CloudflaredOutputProcess,
  options: TrackCloudflaredOutputOptions = {},
): void {
  const streamReader = async (stream: unknown, streamKind: CloudflaredStream) => {
    if (!isReadableStream(stream)) {
      return;
    }

    const reader = stream.getReader();
    const decoder = new TextDecoder();

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        const text = decoder.decode(value, { stream: true }).trim();
        if (!text) {
          continue;
        }

        if (options.includeLine && !options.includeLine(text, streamKind)) {
          continue;
        }

        if (streamKind === 'stderr') {
          logger.warning(`[cloudflared] ${text}`);
        } else {
          logger.dim(`[cloudflared] ${text}`);
        }
      }
    } catch {
      // Ignore stream-reader errors while process exits.
    } finally {
      reader.releaseLock();
    }
  };

  void streamReader(proc.stdout, 'stdout');
  void streamReader(proc.stderr, 'stderr');
}
