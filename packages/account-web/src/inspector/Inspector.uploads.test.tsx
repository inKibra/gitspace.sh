// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_UPLOAD_CHUNK_BYTES, ARTIFACT_UPLOAD_MAX_BYTES, rpcErrors } from '@gitspace/protocol/rpc-contract';
import { Inspector, type InspectorProps } from './Inspector.js';
import type { ArtifactUploadClient } from './artifact-upload.js';

vi.mock('@pierre/diffs/react', () => ({ FileDiff: () => null }));
vi.mock('@pierre/trees/react', () => ({ useFileTree: () => ({ model: { resetPaths() {}, setGitStatus() {} } }), FileTree: () => null }));

const url = 'local://workspace/uploads/data.zip';
let root: Root;
let container: HTMLDivElement;
let props: InspectorProps;
let animationDescriptor: PropertyDescriptor | undefined;
const unavailable = async (): Promise<never> => { throw new Error('Unexpected action'); };
async function render() { await act(async () => root.render(<Inspector {...props} />)); }
async function settle() {
  for (let turn = 0; turn < 20; turn += 1) {
    await act(async () => {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
    });
  }
}
async function choose(...files: File[]) {
  const input = container.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, 'files', { configurable: true, value: files });
  await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
  await settle();
}
async function click(label: string) {
  const button = [...container.querySelectorAll('button')].find((node) => node.textContent === label);
  expect(button, label).toBeDefined();
  await act(async () => button!.click());
  await settle();
}
function client(chunk: ArtifactUploadClient['chunk']) {
  let begun = 0;
  return {
    begin: vi.fn<ArtifactUploadClient['begin']>(async ({ fileName }) => ({ uploadId: `${fileName}#${begun += 1}`, url: `local://workspace/uploads/${fileName}`, chunkBytes: ARTIFACT_UPLOAD_CHUNK_BYTES })),
    chunk: vi.fn<ArtifactUploadClient['chunk']>(chunk),
    commit: vi.fn<ArtifactUploadClient['commit']>(async (uploadId) => {
      const name = uploadId.split('#')[0]!;
      return { kind: 'artifact', url: `local://workspace/uploads/${name}`, hash: 'hash', label: `uploads/${name}`, mediaType: null, generation: 1 };
    }),
    abort: vi.fn<ArtifactUploadClient['abort']>(async () => undefined),
  };
}
const acknowledge: ArtifactUploadClient['chunk'] = async ({ offset, data }) => ({ received: offset + atob(data).length });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('IntersectionObserver', class { observe() {} disconnect() {} });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  animationDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'getAnimations');
  if (!animationDescriptor) Object.defineProperty(Element.prototype, 'getAnimations', { configurable: true, value: () => [] });
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  props = {
    overview: { projectId: 'project', spaceId: 'space', revision: 1, goal: null, workflow: null, rubric: null, journal: { entries: 0, openPhaseRunId: null, recent: [] }, review: { total: 0, unresolved: 0 }, changeGuide: null },
    initialView: 'artifacts', artifactReferences: [], workspaces: [], onSelectWorkspace() {}, repositoryEntries: [], repositoryMode: 'current', onRepositoryModeChange() {}, repositoryFile: null, repositoryDiff: null, journalEntries: [], threads: [], services: [], subagents: [],
    usage: { sessionId: null, report: null, status: 'idle', load() {}, refresh() {} }, agentSetup: { sessionId: null, report: null, status: 'idle', load: unavailable, refresh: unavailable, save: unavailable }, reviewerId: 'reviewer', onRequestArtifact: unavailable, onRequestRepositoryFile() {}, onRequestRepositoryDiff() {}, onLoadRepositoryDiff: unavailable, onCreateThread: unavailable, onReplyThread: unavailable, onResolveThread: unavailable, onMarkGuideSectionRead: unavailable, onSetGuideApproval: unavailable,
  };
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); if (!animationDescriptor) Reflect.deleteProperty(Element.prototype, 'getAnimations'); vi.unstubAllGlobals(); });

describe('Inspector artifact uploads', () => {
  it('shows acknowledged progress and releases the server upload when cancelled mid-transfer', async () => {
    const uploads = client(async (input, signal) => {
      if (input.offset === 0) return acknowledge(input, signal);
      const { promise, reject } = Promise.withResolvers<never>();
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      return promise;
    });
    props.artifactUpload = uploads;
    await render();
    await choose(new File([new Uint8Array(ARTIFACT_UPLOAD_CHUNK_BYTES * 2)], 'data.zip'));

    expect(container.querySelector('[role="progressbar"]')?.getAttribute('aria-valuenow')).toBe(String(ARTIFACT_UPLOAD_CHUNK_BYTES));
    expect(container.textContent).toContain('256 KiB of 512 KiB · 50%');
    const uploadId = (await uploads.begin.mock.results[0]!.value).uploadId;

    await click('Cancel data.zip');

    expect(uploads.chunk.mock.calls[1]?.[1].aborted).toBe(true);
    expect(uploads.abort).toHaveBeenCalledExactlyOnceWith(uploadId);
    expect(uploads.commit).not.toHaveBeenCalled();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
  });

  it('offers Retry after a rejected chunk, restarts the upload, and highlights the committed artifact', async () => {
    let fail = true;
    const uploads = client(async (input, signal) => {
      if (fail) { fail = false; throw rpcErrors.inspectorState({ resource: 'upload', message: 'Chunk hash mismatch.' }); }
      return acknowledge(input, signal);
    });
    props.artifactUpload = uploads;
    await render();
    await choose(new File([new Uint8Array(10)], 'data.zip'));

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Chunk hash mismatch.');
    const firstUpload = (await uploads.begin.mock.results[0]!.value).uploadId;

    await click('Retry data.zip');

    expect(uploads.abort).toHaveBeenCalledExactlyOnceWith(firstUpload);
    expect(uploads.begin).toHaveBeenCalledTimes(2);
    expect(uploads.commit).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();
    expect(container.querySelector(`[data-artifact-url="${url}"]`)?.hasAttribute('data-selected')).toBe(true);
    props.artifactReferences = [{ kind: 'artifact', url, hash: 'hash', label: 'uploads/data.zip', mediaType: null, generation: 1 }];
    await render();
    expect(container.querySelectorAll(`[data-artifact-url="${url}"]`)).toHaveLength(1);
    expect(container.querySelector(`[data-artifact-url="${url}"]`)?.hasAttribute('data-selected')).toBe(true);
  });

  it('sends one chunk request at a time across concurrent files and lists both before the catalog publishes them', async () => {
    let inFlight = 0;
    let peak = 0;
    const uploads = client(async (input, signal) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, 0);
      await promise;
      inFlight -= 1;
      return acknowledge(input, signal);
    });
    props.artifactUpload = uploads;
    await render();

    await choose(new File([new Uint8Array(ARTIFACT_UPLOAD_CHUNK_BYTES + 1)], 'a.zip'), new File([new Uint8Array(ARTIFACT_UPLOAD_CHUNK_BYTES + 1)], 'b.zip'));

    expect(uploads.chunk).toHaveBeenCalledTimes(4);
    expect(peak).toBe(1);
    expect(container.querySelector('[data-artifact-url="local://workspace/uploads/a.zip"]')?.hasAttribute('data-selected')).toBe(true);
    expect(container.querySelector('[data-artifact-url="local://workspace/uploads/b.zip"]')?.hasAttribute('data-selected')).toBe(true);
  });

  it('rejects files over 1 GiB without beginning an upload', async () => {
    const uploads = client(acknowledge);
    props.artifactUpload = uploads;
    await render();
    const file = new File([], 'huge.zip');
    Object.defineProperty(file, 'size', { value: ARTIFACT_UPLOAD_MAX_BYTES + 1 });

    await choose(file);

    expect(container.querySelector('[role="alert"]')?.textContent).toContain('uploads are limited to 1 GiB');
    expect(uploads.begin).not.toHaveBeenCalled();
    await click('Dismiss huge.zip');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
