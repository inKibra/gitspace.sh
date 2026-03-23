import { SpacesError } from '../types/errors.js';

export async function readTextFromStdin(): Promise<string> {
  const reader = process.stdin;
  const chunks: Buffer[] = [];

  const readAvailableChunks = () => {
    let chunk = reader.read();
    while (chunk !== null) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      chunk = reader.read();
    }
  };

  readAvailableChunks();

  try {
    if (!reader.readableEnded) {
      await new Promise<void>((resolve, reject) => {
        const cleanup = () => {
          reader.removeListener('readable', onReadable);
          reader.removeListener('end', onEnd);
          reader.removeListener('error', onError);
        };

        const onReadable = () => {
          readAvailableChunks();
          if (reader.readableEnded) {
            cleanup();
            resolve();
          }
        };

        const onEnd = () => {
          readAvailableChunks();
          cleanup();
          resolve();
        };

        const onError = (error: Error) => {
          cleanup();
          reject(new SpacesError(`Failed to read stdin: ${error.message}`, 'USER_ERROR', 1));
        };

        reader.on('readable', onReadable);
        reader.once('end', onEnd);
        reader.once('error', onError);
        readAvailableChunks();
        if (reader.readableEnded) {
          cleanup();
          resolve();
        }
      });
    }
  } finally {
    reader.pause();
  }

  const text = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
  if (!text.trim()) {
    throw new SpacesError('No note text provided via stdin.', 'USER_ERROR', 1);
  }
  return text;
}
