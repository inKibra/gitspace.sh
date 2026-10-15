// @vitest-environment happy-dom
import { ARTIFACT_UPLOAD_CHUNK_BYTES } from '@gitspace/protocol/rpc-contract';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { verticalSliceFixture } from './App.js';
import { Composer } from './Composer.js';
import type { GitSpaceShellProps } from './GitSpaceShell.js';
import type { ArtifactUploadClient } from './inspector/artifact-upload.js';

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function client(commit: ArtifactUploadClient['commit']) {
  return {
    begin: vi.fn<ArtifactUploadClient['begin']>(async ({ fileName }) => ({ uploadId: fileName, url: `drive://workspace/uploads/${fileName}`, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES })),
    chunk: vi.fn<ArtifactUploadClient['chunk']>(async ({ offset, data }) => ({ received: offset + atob(data).length })),
    commit: vi.fn<ArtifactUploadClient['commit']>(commit),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
}

async function draftWithAttachment(text: string, file: File) {
  const textarea = container.querySelector('textarea')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, text);
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await act(async () => { container.querySelector<HTMLButtonElement>('button[aria-label="Send"]')!.click(); });
  for (let turn = 0; turn < 20; turn += 1) await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  return textarea;
}

it('uploads attachments that are not sent inline and links them in the prompt', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client(async (uploadId) => ({ kind: 'artifact', url: `drive://workspace/uploads/${encodeURIComponent(uploadId)}`, hash: 'hash', label: `uploads/${uploadId}`, mediaType: 'application/pdf', generation: 1 }));
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report (1).pdf', { type: 'application/pdf' }));

  expect(uploads.begin).toHaveBeenCalledWith({ fileName: 'report (1).pdf', size: 10, mediaType: 'application/pdf' });
  expect(uploads.commit).toHaveBeenCalledWith('report (1).pdf');
  expect(onSend.mock.calls.map(([text]) => text)).toEqual(['Summarize this\n\n<attachment name="report (1).pdf" url="drive://workspace/uploads/report%20(1).pdf" type="application/pdf" size="10" />']);
  expect(textarea.value).toBe('');
});

it('keeps the draft and its attachment when the upload fails', async () => {
  const onSend = vi.fn<NonNullable<GitSpaceShellProps['onSend']>>(async () => undefined);
  const uploads = client(async () => { throw new Error('The workspace is no longer open on a machine.'); });
  await act(() => root.render(<Composer workspace={verticalSliceFixture.workspace} artifactUpload={uploads} running={false} pending={false} onSend={onSend} />));

  const textarea = await draftWithAttachment('Summarize this', new File([new Uint8Array(10)], 'report.pdf', { type: 'application/pdf' }));

  expect(onSend).not.toHaveBeenCalled();
  expect(container.querySelector('[role=alert]')?.textContent).toBe('The workspace is no longer open on a machine.');
  expect(textarea.value).toBe('Summarize this');
  expect(container.querySelector('[aria-label="Remove report.pdf"]')).not.toBeNull();
});
