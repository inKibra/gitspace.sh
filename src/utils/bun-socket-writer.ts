import type { Socket } from "bun";

type WritableData = Buffer | Uint8Array | ArrayBuffer;

/**
 * Bun sockets are unbuffered. `socket.write()` can write fewer bytes than provided
 * under backpressure. For framed protocols, partial writes will desync the reader.
 *
 * This helper buffers pending bytes and flushes them when the socket drains.
 */
export function createBufferedSocketWriter(socket: Socket<any>) {
  const queue: Buffer[] = [];
  let headOffset = 0;

  const flush = () => {
    while (queue.length > 0) {
      const head = queue[0]!;
      const remaining = head.length - headOffset;

      if (remaining <= 0) {
        queue.shift();
        headOffset = 0;
        continue;
      }

      const written = socket.write(head, headOffset, remaining);

      // -1: closed/shutting down. 0: backpressure.
      if (written <= 0) return;

      headOffset += written;
      if (headOffset >= head.length) {
        queue.shift();
        headOffset = 0;
      }
    }
  };

  const write = (data: WritableData) => {
    // Copy into a stable Buffer (avoids subarray lifetime issues and ensures queue owns bytes)
    const buf = Buffer.from(data as any);

    // Fast-path if nothing queued.
    if (queue.length === 0) {
      const written = socket.write(buf);

      if (written <= 0) {
        queue.push(buf);
        headOffset = 0;
        return;
      }

      if (written >= buf.length) return;

      queue.push(buf);
      headOffset = written;
      return;
    }

    queue.push(buf);
    flush();
  };

  const clear = () => {
    queue.length = 0;
    headOffset = 0;
  };

  const pendingBytes = () => {
    let total = 0;
    for (let i = 0; i < queue.length; i++) total += queue[i]!.length;
    return Math.max(0, total - headOffset);
  };

  return { write, flush, clear, pendingBytes };
}




