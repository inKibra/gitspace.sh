import { parentPort } from 'node:worker_threads';
import { z } from 'zod';
const plainText = /[\t\x20-\x7e]+/y;
const MAX_ROW = 16384;
/** Bounded terminal view, independent of the durable raw log cursor. */
export class TerminalProjection {
  private rows: string[] = [''];
  private column = 0;
  private escape = '';
  constructor(private readonly limit = 1000) {}
  push(text: string): void {
    for (let offset = 0; offset < text.length;) {
      if (!this.escape) {
        plainText.lastIndex = offset;
        const span = plainText.exec(text)?.[0];
        if (span) {
          const row = this.rows.at(-1)!;
          this.rows[this.rows.length - 1] = (row.slice(0, this.column).padEnd(this.column) + span + row.slice(this.column + span.length)).slice(-MAX_ROW);
          this.column = Math.min(MAX_ROW, this.column + span.length);
          offset += span.length;
          continue;
        }
      }
      const char = String.fromCodePoint(text.codePointAt(offset)!);
      offset += char.length;
      if (this.escape) {
        this.escape += char;
        if (this.escape === '\x1b[' || this.escape === '\x1b]') continue;
        if (this.escape.startsWith('\x1b]')) { if (char === '\x07' || this.escape.endsWith('\x1b\\')) this.escape = ''; continue; }
        if (/[@-~]/.test(char)) {
          if (char === 'K') this.rows[this.rows.length - 1] = this.rows.at(-1)!.slice(0, this.column);
          if (char === 'J' && this.escape.includes('2')) { this.rows = ['']; this.column = 0; }
          this.escape = '';
        }
        if (this.escape.length > 4096) this.escape = '';
        continue;
      }
      if (char === '\x1b') { this.escape = char; continue; }
      if (char === '\n') { this.rows.push(''); this.column = 0; if (this.rows.length > this.limit) this.rows.shift(); continue; }
      if (char === '\r') { this.column = 0; continue; }
      if (char === '\b') { this.column = Math.max(0, this.column - 1); continue; }
      if (char < ' ' && char !== '\t') continue;
      const row = this.rows.at(-1)!;
      this.rows[this.rows.length - 1] = (row.slice(0, this.column).padEnd(this.column) + char + row.slice(this.column + 1)).slice(-MAX_ROW);
      this.column = Math.min(MAX_ROW, this.column + 1);
    }
  }
  text(): string { return this.rows.join('\n'); }
}
const Input = z.discriminatedUnion('op', [z.object({ op: z.literal('write'), id: z.string(), text: z.string() }), z.object({ op: z.literal('snapshot'), id: z.string() }), z.object({ op: z.literal('close'), id: z.string() })]);
export function startTerminalOutputWorker(): void {
  if (!parentPort) throw new Error('Terminal output entry requires a worker message port');
  const port = parentPort;
  const views = new Map<string, TerminalProjection>();
  port.on('message', (raw: unknown) => {
    const message = Input.parse(raw);
    if (message.op === 'close') { views.delete(message.id); return; }
    let view = views.get(message.id);
    if (!view) { view = new TerminalProjection(); views.set(message.id, view); }
    if (message.op === 'write') view.push(message.text);
    else port.postMessage({ id: message.id, text: view.text() });
  });
}
