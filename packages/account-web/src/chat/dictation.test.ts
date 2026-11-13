import { expect, test } from 'vitest';
import { DICTATION_WORKLET } from './dictation.js';

/** A worklet port as the browser has it: a posted buffer listed for transfer is moved, leaving the sender's array empty. */
class TransferringPort {
  readonly sent: ArrayBuffer[] = [];
  onmessage: (() => void) | null = null;
  postMessage(data: unknown, transfer?: ArrayBuffer[]) {
    if (data instanceof ArrayBuffer) this.sent.push(transfer ? structuredClone(data, { transfer }) : data);
  }
}
type Processor = { port: TransferringPort; process(inputs: Float32Array[][]): boolean };

test('the dictation worklet keeps sending whole frames after it transfers the first one', () => {
  const registered: Array<new (options: { processorOptions: { rate: number; frame: number } }) => Processor> = [];
  class AudioWorkletProcessor { readonly port = new TransferringPort(); }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', DICTATION_WORKLET)(
    AudioWorkletProcessor, (_name: string, processor: new (options: { processorOptions: { rate: number; frame: number } }) => Processor) => { registered.push(processor); }, 48_000);
  const [Pcm16] = registered;
  if (!Pcm16) throw new Error('The worklet registered no processor');
  // 48 kHz to 16 kHz is every third sample; frames of 4 samples need 12 input samples each.
  const processor = new Pcm16({ processorOptions: { rate: 16_000, frame: 4 } });
  for (let block = 0; block < 3; block++) processor.process([[new Float32Array(12).fill(0.5)]]);
  expect(processor.port.sent.map(buffer => new Int16Array(buffer).length)).toEqual([4, 4, 4]);
  expect([...new Int16Array(processor.port.sent[2] ?? new ArrayBuffer(0))]).toEqual([16383, 16383, 16383, 16383]);
});
