import { getCurrentSystemPrompt, getCurrentTools, type Api, type Model, type SimpleStreamOptions, type ToolCall, type ToolResultMessage, type TranscriptContext, type UserMessage } from '@earendil-works/pi-ai';
import { cursorCatalog } from './cursor-models';
import { bytes, concat, decodeBase64, jsonValue, message, storeBlob, text, uint } from './cursor-wire';

const encoder = new TextEncoder();

function userMessage(user: UserMessage): Uint8Array {
  const content = typeof user.content === 'string' ? [{ type: 'text' as const, text: user.content }] : user.content;
  return concat([
    text(1, content.filter(part => part.type === 'text').map(part => part.text).join('\n')),
    text(2, crypto.randomUUID()),
    message(3, ...content.filter(part => part.type === 'image').map(image => message(1,
      text(2, crypto.randomUUID()), text(7, image.mimeType), bytes(8, decodeBase64(image.data))))),
  ]);
}

function mcpHistoryStep(call: ToolCall, id: string, result: ToolResultMessage | undefined): Uint8Array {
  const args = concat([
    text(1, call.name), text(3, id), text(4, 'pi-agent'), text(5, call.name),
    ...Object.entries(call.arguments).map(([name, value]) => message(2, text(1, name), bytes(2, jsonValue(value)))),
  ]);
  const resultBytes = result === undefined ? new Uint8Array() : result.isError
    ? message(2, message(2, text(1, result.content.map(part => part.type === 'text' ? part.text : `[${part.mimeType} image]`).join('\n'))))
    : message(2, message(1, ...result.content.map(part => part.type === 'text'
      ? message(1, message(1, text(1, part.text)))
      : message(1, message(2, bytes(1, decodeBase64(part.data)), text(2, part.mimeType))))));
  return message(2, text(57, id), message(15, bytes(1, args), resultBytes));
}

/** A new, account-local Run reconstructs both Cursor history representations. */
export async function buildCursorRequest(model: Model<Api>, context: TranscriptContext, reasoning?: SimpleStreamOptions['reasoning']) {
  const blobs = new Map<string, Uint8Array>();
  const tools = getCurrentTools(context.messages);
  const system = getCurrentSystemPrompt(context.messages);
  const toolDefinitions = tools.map(tool => message(7,
    text(1, tool.name), text(2, tool.description), bytes(3, jsonValue(tool.parameters)),
    text(4, 'pi-agent'), text(5, tool.name)));
  const requestContext = concat([
    ...toolDefinitions,
    ...(system ? [message(2, text(1, '/gitspace/system-prompt.mdc'), text(2, system), message(3, message(1)), uint(4, 2))] : []),
  ]);
  const messages = context.messages.filter(item => item.role !== 'system');
  const active = messages.at(-1);
  const activeUser = active?.role === 'user' ? active : undefined;
  const history = activeUser ? messages.slice(0, -1) : messages;
  const ids = new Map<string, string>();
  for (const item of history) {
    if (item.role !== 'assistant') continue;
    for (const part of item.content) {
      if (part.type !== 'toolCall' || ids.has(part.id)) continue;
      // Hash rather than replacing characters: foreign composite ids cannot collide.
      const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(part.id)));
      ids.set(part.id, Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join(''));
    }
  }
  const results = new Map(history.filter(item => item.role === 'toolResult').map(item => [item.toolCallId, item]));
  const root: Uint8Array[] = [];
  const putJson = async (value: unknown) => root.push(await storeBlob(blobs, encoder.encode(JSON.stringify(value))));
  await putJson({ role: 'system', content: system || 'You are a helpful assistant.' });
  const turns: Uint8Array[] = [];
  let turn: { user: Uint8Array; steps: Uint8Array[] } | undefined;
  const finishTurn = async () => {
    if (!turn) return;
    turns.push(await storeBlob(blobs, message(1, bytes(1, turn.user), ...turn.steps.map(step => bytes(2, step)))));
  };
  const catalog = cursorCatalog.find(entry => entry.model.id === model.id);
  for (const item of history) {
    if (item.role === 'user') {
      await finishTurn();
      turn = { user: await storeBlob(blobs, userMessage(item)), steps: [] };
      const content = typeof item.content === 'string' ? [{ type: 'text', text: item.content }] : item.content.map(part =>
        part.type === 'text' ? { type: 'text', text: part.text } : { type: 'image', image: `data:${part.mimeType};base64,${part.data}`, mediaType: part.mimeType });
      await putJson({ role: 'user', content });
    } else if (item.role === 'assistant') {
      const content: unknown[] = [];
      for (const part of item.content) {
        let step: Uint8Array | undefined;
        if (part.type === 'text') {
          content.push({ type: 'text', text: part.text });
          step = message(1, text(1, part.text));
        } else if (part.type === 'thinking' && catalog?.family === 'k3' && item.provider === 'cursor' && item.api === 'cursor-agent' && item.model === model.id) {
          content.push({ type: 'reasoning', text: part.thinking, providerOptions: { cursor: { modelName: model.id } }, ...(part.thinkingSignature ? { signature: part.thinkingSignature } : {}) });
          step = message(3, text(1, part.thinking));
        } else if (part.type === 'toolCall') {
          const id = ids.get(part.id);
          if (!id) throw new Error('Cursor history call has no normalized id');
          content.push({ type: 'tool-call', toolCallId: id, toolName: part.name, args: part.arguments });
          step = mcpHistoryStep(part, id, results.get(part.id));
        }
        if (step && turn) turn.steps.push(await storeBlob(blobs, step));
      }
      if (content.length) await putJson({ role: 'assistant', content });
    } else if (item.role === 'toolResult') {
      const id = ids.get(item.toolCallId);
      const resultText = item.content.map(part => part.type === 'text' ? part.text : `[${part.mimeType} image]`).join('\n');
      if (id) {
        await putJson({ role: 'tool', id, content: [{ type: 'tool-result', toolName: item.toolName, toolCallId: id, result: resultText, ...(item.isError ? { isError: true } : {}) }] });
      } else {
        const orphan = `${item.isError ? '[Tool Error]' : '[Tool Result]'}\n${resultText || '(empty result)'}`;
        await putJson({ role: 'assistant', content: [{ type: 'text', text: orphan }] });
        if (turn) turn.steps.push(await storeBlob(blobs, message(1, text(1, orphan))));
      }
    }
  }
  await finishTurn();
  const selectedLevel = reasoning ?? 'off';
  const wireId = model.thinkingLevelMap?.[selectedLevel] ?? catalog?.requestModelId ?? model.id;
  const maxMode = catalog?.maxModeRoutes[wireId] ?? catalog?.maxMode ?? /-(?:fast|1m)$/.test(wireId);
  const effort = catalog?.modelClass === 'openai' ? /-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/.exec(wireId) : null;
  const wireModelId = effort ? wireId.replace(/-(none|minimal|low|medium|high|xhigh|max)(-fast)?$/, '$2') : wireId;
  const parameters: Uint8Array[] = [];
  if (effort?.[1] && effort[1] !== 'none') parameters.push(message(3, text(1, 'reasoning'), text(2, effort[1])));
  if (wireId === 'composer-2.5') parameters.push(message(3, text(1, 'fast'), text(2, 'false')));
  const run = concat([
    message(1, ...root.map(id => bytes(1, id)), ...turns.map(id => bytes(8, id))),
    message(2, activeUser ? message(1, bytes(1, userMessage(activeUser))) : message(2)),
    message(3, text(1, wireModelId), text(3, model.id), text(4, model.name), uint(7, maxMode ? 1 : 0)),
    message(9, text(1, wireModelId), uint(2, maxMode ? 1 : 0), ...parameters),
    // No process-global conversation cache: another account can never inherit its blobs or pending execs.
    text(5, crypto.randomUUID()),
  ]);
  return { run, blobs, tools, requestContext };
}
