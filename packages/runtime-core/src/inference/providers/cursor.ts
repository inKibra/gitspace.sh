import { createAssistantMessageEventStream, parseStreamingJson, type Api, type AssistantMessage, type AssistantMessageEventStream, type Model, type Provider, type SimpleStreamOptions, type StreamOptions, type TextContent, type ThinkingContent, type ToolCall, type TranscriptContext } from '@earendil-works/pi-ai';
import { z } from 'zod';
import { cursorCatalog } from './cursor-models';
import { buildCursorRequest } from './cursor-request';
import { blobKey, bytes, connectFrame, connectFrames, CursorWire, decodeJsonValue, message, text, uint } from './cursor-wire';

const BASE_URL = 'https://api2.cursor.sh';
const CLIENT_VERSION = 'cli-2026.07.23-e383d2b';
const HANDOFF = 'Tool call received and handed off to the external client for execution. Do not retry or call it again; end the turn. The result will be provided in the next request.';
const argsSchema = z.record(z.string(), z.json());
const reasoningSchema = z.enum(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']).optional() satisfies z.ZodType<SimpleStreamOptions['reasoning']>;
const requestOptionsSchema = z.object({ reasoning: reasoningSchema });
const endSchema = z.object({ error: z.object({ code: z.string().optional(), message: z.string().optional(), details: z.array(z.unknown()).optional() }).optional() });
const decoder = new TextDecoder('utf-8', { fatal: true });
const reservedHeaders: Record<string, true> = {
  authorization: true, host: true, 'content-type': true, 'content-length': true,
  'connect-protocol-version': true, 'connect-accept-encoding': true, 'accept-encoding': true,
  'x-ghost-mode': true, 'x-cursor-client-version': true, 'x-cursor-client-type': true,
  'x-request-id': true, connection: true, 'keep-alive': true, 'proxy-connection': true,
  'transfer-encoding': true, upgrade: true, 'http2-settings': true, te: true,
};

type PendingTool = { block: ToolCall; index: number; json: string; parsedLength: number; ended: boolean; invoked: boolean };

function mcpArguments(args: CursorWire): ToolCall['arguments'] {
  return argsSchema.parse(Object.fromEntries(args.all(2).map(entry => {
    const encoded = entry.data(2);
    let value: unknown;
    try { value = decodeJsonValue(encoded); }
    catch { value = decoder.decode(encoded); }
    if (typeof value === 'string' && /^[\s]*[\[{\"]/.test(value)) {
      try { value = JSON.parse(value); } catch { /* Plain strings remain strings. */ }
    }
    return [entry.string(1), value];
  })));
}

class CursorEvents {
  private text: { block: TextContent; index: number } | undefined;
  private thinking: { block: ThinkingContent; index: number } | undefined;
  private readonly tools = new Map<string, PendingTool>();
  private readonly envelopes = new Map<string, PendingTool>();
  sawTurnEnd = false;
  handoff = false;

  constructor(readonly output: AssistantMessage, private readonly stream: AssistantMessageEventStream) {}

  closeText(): void {
    if (!this.text) return;
    this.stream.push({ type: 'text_end', contentIndex: this.text.index, content: this.text.block.text, partial: this.output });
    this.text = undefined;
  }

  closeThinking(): void {
    if (!this.thinking) return;
    this.stream.push({ type: 'thinking_end', contentIndex: this.thinking.index, content: this.thinking.block.thinking, partial: this.output });
    this.thinking = undefined;
  }

  tool(id: string, name: string, args: ToolCall['arguments'], envelope = '', invoked = false): PendingTool {
    let pending = this.tools.get(id) ?? (envelope ? this.envelopes.get(envelope) : undefined);
    if (!pending) {
      this.closeText();
      this.closeThinking();
      const block: ToolCall = { type: 'toolCall', id, name, arguments: args };
      pending = { block, index: this.output.content.length, json: '', parsedLength: 0, ended: false, invoked };
      this.output.content.push(block);
      this.tools.set(id, pending);
      this.stream.push({ type: 'toolcall_start', contentIndex: pending.index, partial: this.output });
    } else {
      if (pending.json) pending.block.arguments = argsSchema.parse(parseStreamingJson<unknown>(pending.json));
      // Oversized structured arguments may be downgraded to strings in completion frames.
      for (const [key, value] of Object.entries(args)) {
        const prior = pending.block.arguments[key];
        if (typeof value === 'string' && prior !== null && typeof prior === 'object') continue;
        pending.block.arguments[key] = value;
      }
      pending.invoked ||= invoked;
    }
    if (envelope) this.envelopes.set(envelope, pending);
    if (invoked) this.handoff = true;
    return pending;
  }

  private closeTool(pending: PendingTool): void {
    if (pending.ended) return;
    this.stream.push({ type: 'toolcall_end', contentIndex: pending.index, toolCall: pending.block, partial: this.output });
    pending.ended = true;
  }

  update(update: CursorWire): void {
    if (update.has(1)) {
      this.closeThinking();
      if (!this.text) {
        const block: TextContent = { type: 'text', text: '' };
        this.text = { block, index: this.output.content.length };
        this.output.content.push(block);
        this.stream.push({ type: 'text_start', contentIndex: this.text.index, partial: this.output });
      }
      const delta = update.child(1).string(1);
      this.text.block.text += delta;
      this.stream.push({ type: 'text_delta', contentIndex: this.text.index, delta, partial: this.output });
    } else if (update.has(4)) {
      this.closeText();
      if (!this.thinking) {
        const block: ThinkingContent = { type: 'thinking', thinking: '' };
        this.thinking = { block, index: this.output.content.length };
        this.output.content.push(block);
        this.stream.push({ type: 'thinking_start', contentIndex: this.thinking.index, partial: this.output });
      }
      const delta = update.child(4).string(1);
      this.thinking.block.thinking += delta;
      this.stream.push({ type: 'thinking_delta', contentIndex: this.thinking.index, delta, partial: this.output });
    } else if (update.has(5)) {
      this.closeThinking();
    } else if (update.has(2) || update.has(3) || update.has(7)) {
      const kind = update.has(2) ? 2 : update.has(3) ? 3 : 7;
      const event = update.child(kind);
      const envelope = event.string(1);
      const tool = event.child(2);
      // Server-owned tools have no Pi invocation: never enqueue them for a second execution.
      if (tool.has(15)) {
        const args = tool.child(15).child(1);
        const id = args.string(3) || tool.string(57) || envelope;
        const name = args.string(5) || args.string(1);
        if (!id || !name) throw new Error('Cursor MCP announcement omitted tool identity');
        this.tool(id, name, mcpArguments(args), envelope);
      }
      const pending = this.envelopes.get(envelope);
      if (!pending) return;
      if (kind === 7) {
        const snapshot = event.string(3);
        const delta = snapshot.startsWith(pending.json) ? snapshot.slice(pending.json.length) : snapshot;
        if (!delta) return;
        pending.json += delta;
        if (pending.json.length >= Math.max(256, pending.parsedLength * 2)) {
          pending.block.arguments = argsSchema.parse(parseStreamingJson<unknown>(pending.json));
          pending.parsedLength = pending.json.length;
        }
        this.stream.push({ type: 'toolcall_delta', contentIndex: pending.index, delta, partial: this.output });
      } else if (kind === 3) {
        this.closeTool(pending);
      }
    } else if (update.has(8)) {
      this.output.usage.output += update.child(8).number(1);
      this.output.usage.totalTokens = this.output.usage.input + this.output.usage.output;
    } else if (update.has(14)) {
      this.sawTurnEnd = true;
    }
  }

  finish(): void {
    this.closeText();
    this.closeThinking();
    for (const pending of this.tools.values()) {
      if (!pending.invoked) throw new Error(`Cursor ended before invoking announced tool ${pending.block.name}`);
      this.closeTool(pending);
    }
  }
}

/** Native filesystem/process requests become ordinary Pi tool calls, never machine RPCs. */
function nativeCall(exec: CursorWire): ToolCall | undefined {
  const modern = [45, 46, 47, 48, 49, 50, 51].find(field => exec.has(field));
  const kind = modern ?? [2, 3, 5, 7, 8, 14, 52].find(field => exec.has(field));
  if (!kind) return undefined;
  const args = exec.child(kind);
  let name: string;
  let id: string = crypto.randomUUID();
  let values: ToolCall['arguments'];
  if (kind === 7 || kind === 45) {
    name = 'read';
    if (kind === 7) id = args.string(2) || id;
    const offsetField = kind === 7 ? 4 : 2;
    const limitField = kind === 7 ? 5 : 3;
    const offset = args.has(offsetField) ? args.number(offsetField) : undefined;
    const limit = args.has(limitField) ? args.number(limitField) : undefined;
    const selector = offset !== undefined || limit !== undefined ? `:${offset ?? 1}${limit !== undefined ? `+${limit}` : '-'}` : '';
    values = { path: `${args.string(1)}${selector}` };
  } else if (kind === 2 || kind === 14 || kind === 52 || kind === 46) {
    name = 'bash';
    if (kind !== 46) id = args.string(4) || id;
    values = { command: args.string(1) };
    if (kind === 46 && args.has(2)) values.timeout = args.double(2);
    if (kind !== 46) {
      if (args.string(2)) values.cwd = args.string(2);
      if (args.number(3) > 0) values.timeout = args.number(3);
      if (args.number(11) !== 0) values.async = true;
    }
  } else if (kind === 3 || kind === 48) {
    name = 'write';
    if (kind === 3) id = args.string(3) || id;
    values = { path: args.string(1), content: args.has(2) ? args.string(2) : decoder.decode(args.data(5)) };
  } else if (kind === 8 || kind === 51) {
    name = 'read';
    if (kind === 8) id = args.string(3) || id;
    values = { path: args.string(1) || '.' };
  } else if (kind === 50) {
    name = 'glob';
    const root = args.string(2);
    values = { path: root ? `${root.replace(/\/$/, '')}/${args.string(1)}` : args.string(1) };
    if (args.has(3)) values.limit = args.number(3);
  } else if (kind === 47) {
    // Native replacements are not hashline edits. Let Cursor use the advertised MCP schema.
    return undefined;
  } else {
    name = 'grep';
    if (kind === 5) id = args.string(14) || id;
    let pattern = args.string(1);
    if (kind === 49 && args.number(5)) pattern = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const root = args.string(2) || '.';
    const glob = args.string(3);
    values = { pattern, path: glob ? `${root.replace(/\/$/, '')}/${glob}` : root };
    if (args.number(kind === 5 ? 8 : 4)) values.case = false;
    if (kind === 5 && args.has(16)) values.skip = args.number(16);
    const contextField = kind === 5 ? 7 : 6;
    const limitField = kind === 5 ? 10 : 7;
    if (args.has(contextField)) values.context = args.number(contextField);
    if (args.has(limitField)) values.limit = args.number(limitField);
  }
  return { type: 'toolCall', id, name, arguments: values };
}

function streamCursor(model: Model<Api>, context: TranscriptContext, options: StreamOptions = {}): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();
  const output: AssistantMessage = {
    role: 'assistant', api: 'cursor-agent', provider: 'cursor', model: model.id,
    content: [], timestamp: Date.now(), stopReason: 'stop',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  void (async () => {
    const controller = new AbortController();
    const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let requestController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const events = new CursorEvents(output, stream);
    try {
      if (!options.apiKey) throw new Error('Cursor access token is required');
      signal.throwIfAborted();
      const { reasoning } = requestOptionsSchema.parse(options);
      const built = await buildCursorRequest(model, context, reasoning);
      const replacement = await options.onPayload?.(built.run, model);
      if (replacement !== undefined && !(replacement instanceof Uint8Array)) throw new Error('Cursor onPayload must return protobuf Uint8Array');
      const run = replacement === undefined ? built.run : replacement;
      const body = new ReadableStream<Uint8Array>({
        start(controller) { requestController = controller; controller.enqueue(connectFrame(bytes(1, run))); },
        cancel() { requestController = undefined; },
      });
      const send = (data: Uint8Array) => {
        if (!requestController) throw new Error('Cursor request stream is closed');
        requestController.enqueue(connectFrame(data));
      };
      const replyExec = (exec: CursorWire, field: number, result: Uint8Array) => send(message(2,
        uint(1, exec.number(1)), text(15, exec.string(15)), bytes(field, result)));
      const rejectExec = (exec: CursorWire, reason: string) => {
        send(message(5, message(2, uint(1, exec.number(1)), text(2, reason), text(4, 'unsupported_exec'))));
        send(message(5, message(1, uint(1, exec.number(1)))));
      };
      const headers = new Headers();
      for (const [key, value] of Object.entries({ ...model.headers, ...options.headers })) {
        if (value !== null && !reservedHeaders[key.toLowerCase()] && !key.startsWith(':')) headers.set(key, value);
      }
      headers.set('content-type', 'application/connect+proto');
      headers.set('connect-protocol-version', '1');
      headers.set('connect-accept-encoding', 'identity');
      headers.set('authorization', `Bearer ${options.apiKey}`);
      headers.set('x-ghost-mode', 'true');
      headers.set('x-cursor-client-version', CLIENT_VERSION);
      headers.set('x-cursor-client-type', 'cli');
      headers.set('x-request-id', crypto.randomUUID());
      heartbeat = setInterval(() => {
        try { send(message(7)); } catch (error) { controller.abort(error); }
      }, 5_000);
      if (options.timeoutMs !== undefined) timeout = setTimeout(() => controller.abort(new Error('Cursor request timed out')), options.timeoutMs);
      // Workers fetch is bidirectional: KV and exec replies continue on the request body while reading responses.
      const response = await (options.fetch ?? fetch)(new URL('/agent.v1.AgentService/Run', model.baseUrl || BASE_URL), {
        method: 'POST', headers, body, signal, redirect: 'manual',
      });
      await options.onResponse?.({ status: response.status, headers: Object.fromEntries(response.headers.entries()) }, model);
      if (!response.ok) throw new Error(`Cursor HTTP ${response.status}: ${await response.text()}`);
      if (!response.body) throw new Error('Cursor response has no body');
      stream.push({ type: 'start', partial: output });
      let ended = false;
      for await (const frame of connectFrames(response.body)) {
        signal.throwIfAborted();
        if (frame.flags & 1) throw new Error('Cursor sent compressed data despite identity encoding');
        if (frame.flags & 2) {
          const end = endSchema.parse(JSON.parse(decoder.decode(frame.data)));
          if (end.error) throw new Error(`Cursor ${end.error.code ?? 'unknown'}: ${end.error.message ?? 'stream failed'}${end.error.details ? ` ${JSON.stringify(end.error.details)}` : ''}`);
          ended = true;
          break;
        }
        const server = new CursorWire(frame.data);
        await options.onProviderStreamEvent?.(server, model);
        if (server.has(1)) {
          events.update(server.child(1));
          if (events.sawTurnEnd) { ended = true; break; }
        } else if (server.has(4)) {
          const kv = server.child(4);
          if (kv.has(2)) {
            const blob = built.blobs.get(blobKey(kv.child(2).data(1)));
            send(message(3, uint(1, kv.number(1)), message(2, ...(blob ? [bytes(1, blob)] : []))));
          } else if (kv.has(3)) {
            const args = kv.child(3);
            built.blobs.set(blobKey(args.data(1)), Uint8Array.from(args.data(2)));
            send(message(3, uint(1, kv.number(1)), message(3)));
          } else throw new Error('Unknown Cursor KV request');
        } else if (server.has(2)) {
          const exec = server.child(2);
          if (exec.has(10)) {
            replyExec(exec, 10, message(1, message(1, built.requestContext)));
          } else if (exec.has(11)) {
            const args = exec.child(11);
            if (args.number(7)) {
              replyExec(exec, 11, message(3, text(1, 'Tool approval belongs to the external client.')));
              continue;
            }
            const name = args.string(5) || args.string(1);
            if (!built.tools.some(tool => tool.name === name)) {
              replyExec(exec, 11, message(5, text(1, name)));
              continue;
            }
            const id = args.string(3);
            if (!id) throw new Error('Cursor MCP invocation omitted toolCallId');
            events.tool(id, name, mcpArguments(args), '', true);
            replyExec(exec, 11, message(1, message(1, message(1, text(1, HANDOFF)))));
          } else if (exec.has(36)) {
            const requested = exec.child(36).fields.filter(field => field.number === 1).map(field => {
              if (!(field.value instanceof Uint8Array)) throw new Error('Invalid Cursor MCP server id');
              return decoder.decode(field.value);
            });
            const include = requested.length === 0 || requested.includes('pi-agent');
            const toolFields = new CursorWire(built.requestContext).fields.filter(field => field.number === 7).map(field => {
              if (!(field.value instanceof Uint8Array)) throw new Error('Invalid Cursor MCP definition');
              return bytes(5, field.value);
            });
            replyExec(exec, 36, message(1, ...(include ? [message(1, text(1, 'pi-agent'), text(2, 'pi-agent'), ...toolFields, text(7, 'connected'))] : [])));
          } else if (exec.has(27)) {
            const hook = exec.child(27).child(1).fields.find(field => field.wire === 2)?.number;
            if (hook !== undefined && [1, 2, 3, 4, 5, 6, 7, 8, 9, 11].includes(hook)) {
              replyExec(exec, 27, message(1, message(hook, ...(hook === 7 ? [uint(1, 1)] : []))));
            } else rejectExec(exec, 'Unknown Cursor hook request');
          } else if (exec.has(41) || exec.has(42) || exec.has(43)) {
            // A preflight is not authorization; the Pi tool runner owns every effect.
            replyExec(exec, exec.has(41) ? 41 : exec.has(42) ? 42 : 43, uint(1, 0));
          } else {
            const call = nativeCall(exec);
            if (call && built.tools.some(tool => tool.name === call.name)) {
              events.tool(call.id, call.name, call.arguments, '', true);
              // Native result envelopes cannot truthfully carry a handoff as a success.
              // Stop this Run and replay the real tool result in the next account-local Run.
              ended = true;
              break;
            }
            rejectExec(exec, 'This operation is not exposed natively. Use a tool from the MCP request-context catalog.');
          }
        } else if (server.has(7)) {
          const query = server.child(7);
          const kind = query.fields.find(field => field.number !== 1 && field.wire === 2)?.number;
          if (kind === 2 || kind === 5 || kind === 6 || kind === 9) {
            send(message(6, uint(1, query.number(1)), message(kind, message(1))));
          } else if (kind === 3) {
            send(message(6, uint(1, query.number(1)), message(3, message(1, message(3, text(1, 'Ask through the external client tool catalog.'))))));
          } else if (kind === 4) {
            send(message(6, uint(1, query.number(1)), message(4, message(2, text(1, 'Mode is owned by the external client.')))));
          } else if (kind === 7) {
            send(message(6, uint(1, query.number(1)), message(7, message(1, message(2, text(1, 'Create plans through the external client tool catalog.'))))));
          } else throw new Error(`Unsupported Cursor interaction query ${kind ?? 'unset'}`);
        }
      }
      if (!ended) throw new Error('Cursor connection closed before the turn completed');
      signal.throwIfAborted();
      events.finish();
      output.stopReason = events.handoff ? 'toolUse' : 'stop';
      stream.push({ type: 'done', reason: output.stopReason, message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    } finally {
      clearInterval(heartbeat);
      clearTimeout(timeout);
      try { requestController?.close(); } catch { /* fetch may already have cancelled the body. */ }
      controller.abort();
    }
  })();
  return stream;
}

export function cursorProvider(): Provider {
  const models = cursorCatalog.map(entry => entry.model);
  return {
    id: 'cursor', name: 'Cursor', baseUrl: BASE_URL,
    auth: { apiKey: { name: 'Cursor access token', async resolve({ credential }) {
      return credential?.key ? { auth: { apiKey: credential.key }, source: 'Selected account' } : undefined;
    } } },
    getModels: () => models,
    stream: streamCursor,
    streamSimple(model, context, options) {
      if (!options?.apiKey) throw new Error('Cursor access token is required');
      return streamCursor(model, context, options);
    },
  };
}
