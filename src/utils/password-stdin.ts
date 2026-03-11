import { SpacesError } from '../types/errors.js';

export async function readPasswordFromStdin(): Promise<string> {
  const reader = process.stdin;
  const chunks: Buffer[] = [];

  const onData = (chunk: Buffer) => chunks.push(chunk);
  reader.on('data', onData);

  try {
    await new Promise<void>((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        reject(new SpacesError('Timeout reading password from stdin.', 'USER_ERROR', 1));
      }, 10000);

      const onEnd = () => {
        clearTimeout(timeoutId);
        resolve();
      };

      const onError = (error: Error) => {
        clearTimeout(timeoutId);
        reject(new SpacesError(
          `Failed to read password from stdin: ${error.message}`,
          'USER_ERROR',
          1,
        ));
      };

      reader.once('end', onEnd);
      reader.once('error', onError);
    });
  } finally {
    reader.removeListener('data', onData);
    reader.pause();
  }

  const password = Buffer.concat(chunks).toString('utf-8').replace(/\r?\n$/, '');
  if (!password) {
    throw new SpacesError('No password provided via stdin.', 'USER_ERROR', 1);
  }

  return password;
}
