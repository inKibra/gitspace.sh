const decoder = new TextDecoder();
let pending = '';

async function respond(message: Record<string, unknown>): Promise<void> {
  const method = message.method;
  const id = message.id;
  if (id === undefined) return;
  let result: unknown;
  if (method === 'initialize') {
    result = {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'gitspace-fake-stdio', version: '1.0.0' },
    };
  } else if (method === 'tools/list') {
    result = {
      tools: [
        {
          name: 'echo',
          description: 'Echo a value',
          inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
          outputSchema: { type: 'object', properties: { echoed: { type: 'string' } }, required: ['echoed'] },
          annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
        },
        {
          name: 'wait',
          description: 'Wait until canceled',
          inputSchema: { type: 'object', properties: {} },
          annotations: { readOnlyHint: true, destructiveHint: false },
        },
      ],
    };
  } else if (method === 'tools/call') {
    const params = message.params as { name?: string; arguments?: Record<string, unknown> } | undefined;
    if (params?.name === 'wait') await Bun.sleep(60_000);
    const value = String(params?.arguments?.value ?? '');
    result = {
      content: [{ type: 'text', text: value }],
      structuredContent: { echoed: value },
    };
  } else {
    process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
}

for await (const chunk of Bun.stdin.stream()) {
  pending += decoder.decode(chunk, { stream: true });
  while (true) {
    const newline = pending.indexOf('\n');
    if (newline < 0) break;
    const line = pending.slice(0, newline).trim();
    pending = pending.slice(newline + 1);
    if (!line) continue;
    await respond(JSON.parse(line) as Record<string, unknown>);
  }
}

