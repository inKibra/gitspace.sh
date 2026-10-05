import type { Duplex } from 'node:stream';
import { z } from 'zod';
import { ExecutorEffectUncertain } from './commands.js';
import type { RuntimeBrowserRelayChannel } from './browser-relay-transport.js';

const Message = z.object({ id: z.number().optional(), method: z.string().optional(), params: z.unknown().optional(), sessionId: z.string().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional() });
export const CdpEvent = z.object({ method: z.string(), sessionId: z.string().optional(), params: z.object({ sessionId: z.string().optional(), targetId: z.string().optional(), frame: z.object({ id: z.string(), parentId: z.string().optional(), url: z.string() }).optional() }).optional() });
/** Chromium's private inherited fd3/fd4 protocol; never a network endpoint. */
export class BrowserConnection implements RuntimeBrowserRelayChannel {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private listeners = new Set<(message: unknown) => void>();
  private buffered = Buffer.alloc(0);
  private closed = false;
  constructor(private readonly pipe: { input: Duplex; output: Duplex }) {
    pipe.output.on('data', this.receive);
    pipe.output.once('end', this.disconnected);
    pipe.output.once('error', this.disconnected);
    pipe.input.once('error', this.disconnected);
  }
  private receive = (chunk: Buffer) => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    let end: number;
    while ((end = this.buffered.indexOf(0)) !== -1) {
      if (end > 8_000_000) { this.disconnected(); return; }
      const raw = this.buffered.subarray(0, end).toString('utf8');
      this.buffered = this.buffered.subarray(end + 1);
      let message: z.infer<typeof Message>;
      try { message = Message.parse(JSON.parse(raw)); } catch { this.disconnected(); return; }
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(message.error.message)); else pending.resolve(message.result ?? {});
      } else for (const listener of this.listeners) listener(message);
    }
    if (this.buffered.length > 8_000_000) this.disconnected();
  };
  private disconnected = () => {
    if (this.closed) return;
    this.closed = true;
    this.pipe.output.off('data', this.receive);
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new ExecutorEffectUncertain('Browser disconnected after dispatch')); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'disconnected' });
  };
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Browser connection is stale'));
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.pending.delete(id); reject(new ExecutorEffectUncertain(`Browser command timed out: ${method}`)); }, 15_000);
    this.pending.set(id, { resolve, reject, timer });
    this.pipe.input.write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`, error => { if (error) this.disconnected(); });
    return promise;
  }
  subscribe(listener: (message: unknown) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() { this.disconnected(); }
}
