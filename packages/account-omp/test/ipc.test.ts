import { expect, it } from 'bun:test';
import { OmpRpcPeer } from '../src/ipc.js';

interface ChildApi {
  prompt(): Promise<string>;
  stop(): Promise<boolean>;
  missingTranscript(): Promise<void>;
}
interface MachineApi { lookup(): Promise<void> }

it('keeps cancellation responsive while a child turn awaits a machine callback', async () => {
  const observed = Promise.withResolvers<void>();
  const cancelled = Promise.withResolvers<void>();
  const source = `
    import { OmpRpcPeer } from ${JSON.stringify(new URL('../src/ipc.ts', import.meta.url).pathname)};
    const controller = new AbortController();
    const rpc = new OmpRpcPeer(message => process.send(message), {
      prompt: async () => {
        try { await rpc.call('lookup', [], controller.signal); return 'completed'; }
        catch (error) { if (!controller.signal.aborted) throw error; return 'cancelled'; }
      },
      stop: async () => { controller.abort(); return true; },
      missingTranscript: async () => { throw Object.assign(new Error('missing transcript'), { code: 'ENOENT' }); },
    });
    process.on('message', message => rpc.receive(message));
    process.on('disconnect', () => process.exit(0));
  `;
  let child: Bun.Subprocess;
  const rpc = new OmpRpcPeer<ChildApi, MachineApi>((message) => child.send(message), {
    lookup: async (_args, signal) => {
      const pending = Promise.withResolvers<void>();
      signal.addEventListener('abort', () => { cancelled.resolve(); pending.reject(signal.reason); }, { once: true });
      observed.resolve();
      return pending.promise;
    },
  });
  child = Bun.spawn([process.execPath, '--eval', source], {
    stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', serialization: 'advanced',
    ipc: (message) => rpc.receive(message),
  });
  try {
    const prompt = rpc.call('prompt', [], AbortSignal.timeout(5_000));
    await observed.promise;
    expect(await rpc.call('stop', [], AbortSignal.timeout(5_000))).toBe(true);
    expect(await prompt).toBe('cancelled');
    await cancelled.promise;
    await expect(rpc.call('missingTranscript', [], AbortSignal.timeout(5_000))).rejects.toMatchObject({ code: 'ENOENT', message: 'missing transcript' });
  } finally {
    rpc.close();
    child.disconnect();
    child.kill();
    await child.exited;
  }
}, 10_000);
