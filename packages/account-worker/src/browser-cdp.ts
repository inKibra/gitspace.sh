import { z } from 'zod';

const Frame = z.object({ id: z.number().int().optional(), result: z.unknown().optional(), error: z.object({ message: z.string() }).optional(), method: z.string().optional(), params: z.record(z.string(), z.unknown()).optional(), sessionId: z.string().optional() });
export type BrowserChannel = { send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>; subscribe(listener: (event: z.infer<typeof Frame>) => void): () => void; close(): Promise<void> };
export type BrowserRenderingBinding = Pick<Fetcher, 'fetch'>;

export class WorkerBrowserConnection implements BrowserChannel {
  private sequence = 0;
  private pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; cancelTimer(): void }>();
  private listeners = new Set<(event: z.infer<typeof Frame>) => void>();
  private closed = false;
  constructor(private readonly socket: WebSocket) {
    socket.addEventListener('message', event => {
      try {
        if (typeof event.data !== 'string' || event.data.length > 12_000_000) throw new Error('Invalid browser frame');
        const frame = Frame.parse(JSON.parse(event.data));
        if (frame.id !== undefined) {
          const pending = this.pending.get(frame.id);
          if (!pending) return;
          this.pending.delete(frame.id); pending.cancelTimer();
          if (frame.error) pending.reject(new Error(frame.error.message)); else pending.resolve(frame.result);
        } else for (const listener of this.listeners) listener(frame);
      } catch { this.disconnect(); socket.close(1008, 'Invalid browser frame'); }
    });
    socket.addEventListener('close', () => this.disconnect());
    socket.addEventListener('error', () => this.disconnect());
  }
  private disconnect() {
    if (this.closed) return;
    this.closed = true;
    for (const pending of this.pending.values()) { pending.cancelTimer(); pending.reject(new Error('Browser connection lost; effect outcome uncertain')); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'disconnected' });
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error('Browser connection closed'));
    const id = ++this.sequence;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('Browser command timed out; effect outcome uncertain')); }, 30_000);
    this.pending.set(id, { resolve, reject, cancelTimer: () => clearTimeout(timer) });
    try { this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); }
    catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    return promise;
  }
  subscribe(listener: (event: z.infer<typeof Frame>) => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  async close() { this.disconnect(); this.socket.close(1000, 'Browser released'); }
}

export async function launchCloudBrowser(binding: BrowserRenderingBinding, signal: AbortSignal): Promise<BrowserChannel> {
  const acquired = await binding.fetch('https://browser.internal/v1/devtools/browser?keep_alive=600000', { method: 'POST', signal });
  if (!acquired.ok) throw new Error(`BrowserRendering acquisition failed (${acquired.status})`);
  const { sessionId } = z.object({ sessionId: z.string().min(1) }).parse(await acquired.json());
  const upgraded = await binding.fetch(`https://browser.internal/v1/devtools/browser/${encodeURIComponent(sessionId)}`, { headers: { Upgrade: 'websocket' }, signal });
  if (!upgraded.webSocket) throw new Error('BrowserRendering did not provide a CDP websocket');
  upgraded.webSocket.accept();
  return new WorkerBrowserConnection(upgraded.webSocket);
}
