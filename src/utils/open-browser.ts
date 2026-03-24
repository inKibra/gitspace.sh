import open from 'open';

export type OpenBrowserResult =
  | { ok: true }
  | { ok: false; message: string };

export async function openBrowserUrl(url: string): Promise<OpenBrowserResult> {
  try {
    await open(url, { wait: false });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}
