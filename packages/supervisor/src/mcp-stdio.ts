import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { Client, ReadBuffer, serializeMessage, type JSONRPCMessage, type Transport } from '@modelcontextprotocol/client';
import { descendants, sameProcess, signalIdentity } from './process-identity.js';
import type { ProcessIdentity } from './protocol.js';

export interface McpStdioOperation {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  operation: 'discover' | 'invoke';
  name?: string;
  arguments?: Record<string, unknown>;
  authorize(): Promise<void>;
}

/** Private duplex pipes, never a terminal or a shared supervisor output log. */
class McpPipe implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private child?: ChildProcessWithoutNullStreams;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 16 * 1024 * 1024 });
  private identities = new Map<number, ProcessIdentity>();
  private monitoring?: NodeJS.Timeout;
  private scan: Promise<void> = Promise.resolve();
  private closing?: Promise<void>;
  constructor(private readonly options: McpStdioOperation) {}
  async start(): Promise<void> {
    if (this.child) throw new Error('MCP pipe is already started');
    const child = spawn(this.options.command, this.options.args, { cwd: this.options.cwd, env: this.options.env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, detached: true });
    this.child = child;
    child.stderr.resume();
    child.stdout.on('data', chunk => {
      try {
        this.buffer.append(chunk);
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
      } catch (error) { this.onerror?.(error instanceof Error ? error : new Error(String(error))); }
    });
    child.stdout.on('error', error => this.onerror?.(error));
    child.stdin.on('error', error => this.onerror?.(error));
    child.on('close', () => this.onclose?.());
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    const collect = async () => {
      if (!child.pid) return;
      for (const identity of await descendants(child.pid)) this.identities.set(identity.pid, identity);
    };
    await collect();
    this.monitoring = setInterval(() => { this.scan = this.scan.then(collect).catch(error => this.onerror?.(error)); }, 100);
    this.monitoring.unref();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const child = this.child;
    if (!child || this.closing) throw new Error('MCP pipe is closed');
    await new Promise<void>((resolve, reject) => child.stdin.write(serializeMessage(message), error => error ? reject(error) : resolve()));
  }
  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closing = this.stop();
    return this.closing;
  }
  private async stop(): Promise<void> {
    clearInterval(this.monitoring);
    await this.scan;
    const child = this.child;
    if (!child) return;
    if (child.pid) for (const identity of await descendants(child.pid)) this.identities.set(identity.pid, identity);
    child.stdin.end();
    for (const signal of ['SIGTERM', 'SIGKILL'] as const) {
      for (const identity of [...this.identities.values()].reverse()) await signalIdentity(identity, signal);
      const until = Date.now() + 2000;
      do {
        const alive = await Promise.all([...this.identities.values()].map(sameProcess));
        if (!alive.some(Boolean)) { this.buffer.clear(); this.child = undefined; return; }
        await delay(20);
      } while (Date.now() < until);
    }
    throw new Error('MCP process cleanup could not be confirmed');
  }
}

/** What one stdio run answered: the tool list or the tool's result, and the server's identity and protocol version as
 * the connection status records them. */
export interface McpStdioResult { value: unknown; serverVersion: string }

export async function executeMcpStdio(options: McpStdioOperation): Promise<McpStdioResult> {
  options.signal?.throwIfAborted();
  await options.authorize();
  options.signal?.throwIfAborted();
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(options.timeoutMs)]) : AbortSignal.timeout(options.timeoutMs);
  const transport = new McpPipe(options);
  // The 2025 `initialize` handshake, without a `server/discover` probe: every operation spawns its own server process,
  // and the SDK's sibling-process probe is only for its own `StdioClientTransport`. Probing in place here would spend the
  // one child on a request some servers (rmcp's) exit on, and stall servers that never answer it for the probe timeout.
  // A server on a machine may ask for input; nobody is asked yet: each request is declined, and the result says so.
  const client = new Client({ name: 'gitspace-machine', version: '1.0.0' }, { capabilities: { elicitation: { form: {}, url: {} } } });
  const declined: string[] = [];
  client.setRequestHandler('elicitation/create', async request => {
    declined.push(request.params.message);
    return { action: 'decline' };
  });
  try {
    await client.connect(transport, { timeout: options.timeoutMs, signal });
    const server = client.getServerVersion();
    const serverVersion = `${server ? `${server.name} ${server.version}` : 'unnamed server'} · MCP ${client.getNegotiatedProtocolVersion() ?? 'unknown'} (legacy era)`;
    const tools = [];
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : {}, { signal, timeout: options.timeoutMs });
      tools.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor);
    if (options.operation === 'discover') return { value: tools, serverVersion };
    if (!options.name || !tools.some(tool => tool.name === options.name)) throw new Error('MCP tool is unavailable');
    await options.authorize();
    signal.throwIfAborted();
    const result = await client.callTool({ name: options.name, arguments: options.arguments ?? {} }, { signal, timeout: options.timeoutMs });
    const note = `GitSpace declined this server's request${declined.length === 1 ? '' : 's'} for input (${declined.map(message => `"${message.slice(0, 200)}"`).join(', ')}): requests for input from MCP servers on a machine are not shown to people yet. A network (cloud) connection to the server asks the person.`;
    return { value: declined.length ? { ...result, content: [...result.content, { type: 'text', text: note }] } : result, serverVersion };
  } finally {
    try { await client.close(); } finally { await transport.close(); }
  }
}
