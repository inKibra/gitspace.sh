import { expect, test } from 'bun:test';
import { PassThrough } from 'node:stream';
import { BrowserConnection } from './browser-cdp.js';
import { ExecutorEffectUncertain } from './commands.js';

test('private CDP pipe decodes fragmented UTF-8 and multiple null-delimited messages', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const connection = new BrowserConnection({ input, output });
  const events: unknown[] = [];
  connection.subscribe(event => events.push(event));
  const result = connection.send('Browser.getVersion');
  const wire = Buffer.from('{"method":"Page.loadEventFired"}\0{"id":1,"result":{"product":"Chromium-é"}}\0');
  const split = wire.indexOf(Buffer.from('é')) + 1;
  output.write(wire.subarray(0, split)); output.write(wire.subarray(split));
  expect(await result).toEqual({ product: 'Chromium-é' });
  expect(events).toEqual([{ method: 'Page.loadEventFired' }]);
  await connection.close(); input.destroy(); output.destroy();
});

test('private CDP disconnect fences an in-flight effect rather than reporting a retryable failure', async () => {
  const input = new PassThrough(), output = new PassThrough();
  const connection = new BrowserConnection({ input, output });
  const effect = connection.send('Input.dispatchMouseEvent', { type: 'mousePressed' });
  const rejected = effect.catch(error => error);
  output.emit('end');
  expect(await rejected).toBeInstanceOf(ExecutorEffectUncertain);
  await expect(connection.send('Input.dispatchMouseEvent')).rejects.toThrow('stale');
  await connection.close(); input.destroy(); output.destroy();
});
