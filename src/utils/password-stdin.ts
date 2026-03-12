import { SpacesError } from '../types/errors.js';

export async function readPasswordFromStdin(): Promise<string> {
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
          clearTimeout(timeoutId);
          reader.removeListener('readable', onReadable);
          reader.removeListener('end', onEnd);
          reader.removeListener('error', onError);
        };

        const timeoutId = setTimeout(() => {
          cleanup();
          reject(new SpacesError('Timeout reading password from stdin.', 'USER_ERROR', 1));
        }, 10000);

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
          reject(new SpacesError(
            `Failed to read password from stdin: ${error.message}`,
            'USER_ERROR',
            1,
          ));
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

  const password = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
  if (!password) {
    throw new SpacesError('No password provided via stdin.', 'USER_ERROR', 1);
  }

  return password;
}
