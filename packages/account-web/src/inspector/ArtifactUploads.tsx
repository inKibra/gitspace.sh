import type { EvidenceReference } from '@gitspace/protocol';
import { Button, Card, CardContent, CardDescription, CardFooter, CardGroup, CardHeader, CardTitle, Tooltip, useShape } from '@gitspace/ui';
import { useEffect, useRef, useState } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { ArtifactUploadRejected, formatBytes, isTransientUploadError, uploadArtifactFile, uploadRejection, type ArtifactUploadClient, type ArtifactUploadSession } from './artifact-upload.js';

type ArtifactReference = Extract<EvidenceReference, { kind: 'artifact' }>;

export interface ArtifactUploadRow {
  id: string;
  name: string;
  size: number;
  received: number;
  status: 'uploading' | 'committing' | 'failed';
  error: string | null;
  retryable: boolean;
}

interface PendingUpload {
  file: File;
  client: ArtifactUploadClient;
  /** Present while a run is in flight. */
  controller: AbortController | null;
  session: ArtifactUploadSession | null;
  /** The last failure left the server session intact, so Retry continues at its acknowledged offset. */
  resumable: boolean;
}

export interface ArtifactUploads {
  rows: readonly ArtifactUploadRow[];
  /** Every artifact committed here; the published catalog may list them only after background publication. */
  uploaded: readonly ArtifactReference[];
  /** Artifact URLs committed since the latest batch began. */
  highlighted: readonly string[];
  add(files: Iterable<File>): void;
  retry(id: string): void;
  cancel(id: string): void;
}

function settle(promise: Promise<void>): void { void promise.catch(() => undefined); }

/** Upload state outlives the Artifacts tab so switching Inspector views never orphans a transfer. */
export function useArtifactUploads(client: ArtifactUploadClient | undefined): ArtifactUploads {
  const [rows, setRows] = useState<ArtifactUploadRow[]>([]);
  const [uploaded, setUploaded] = useState<readonly ArtifactReference[]>([]);
  const [highlighted, setHighlighted] = useState<readonly string[]>([]);
  const pending = useRef(new Map<string, PendingUpload>());
  const chunkQueue = useRef<Promise<unknown>>(Promise.resolve());
  const update = (id: string, patch: Partial<ArtifactUploadRow>): void => setRows((current) => current.map((row) => row.id === id ? { ...row, ...patch } : row));

  useEffect(() => () => {
    for (const entry of pending.current.values()) {
      if (entry.controller) entry.controller.abort();
      else if (entry.session) settle(entry.client.abort(entry.session.uploadId));
    }
    pending.current.clear();
  }, []);

  const run = async (id: string, entry: PendingUpload): Promise<void> => {
    const controller = new AbortController();
    entry.controller = controller;
    const resume = entry.resumable && entry.session ? entry.session : undefined;
    if (!resume && entry.session) settle(entry.client.abort(entry.session.uploadId));
    if (!resume) entry.session = null;
    update(id, { status: resume?.received === entry.file.size ? 'committing' : 'uploading', error: null, received: resume?.received ?? 0 });
    try {
      const artifact = await uploadArtifactFile(entry.client, entry.file, {
        signal: controller.signal,
        resume,
        onSession: (session) => {
          entry.session = session;
          update(id, { received: session.received, status: session.received === entry.file.size ? 'committing' : 'uploading' });
        },
      });
      pending.current.delete(id);
      setRows((current) => current.filter((row) => row.id !== id));
      setUploaded((current) => [...current.filter((reference) => reference.url !== artifact.url), artifact]);
      setHighlighted((current) => [...current, artifact.url]);
    } catch (error) {
      if (controller.signal.aborted) {
        if (entry.session) settle(entry.client.abort(entry.session.uploadId));
        return;
      }
      entry.controller = null;
      entry.resumable = isTransientUploadError(error);
      update(id, { status: 'failed', error: error instanceof ArtifactUploadRejected ? error.message : rpcErrorMessage(error, `Upload ${entry.file.name}`), retryable: !(error instanceof ArtifactUploadRejected) });
    }
  };

  return {
    rows,
    uploaded,
    highlighted,
    add: (files) => {
      if (!client) return;
      setHighlighted([]);
      // The routed transport batches same-tick calls into one request body, so concurrent files
      // send one chunk at a time to keep every body under the Worker's size cap.
      const serialized: ArtifactUploadClient = {
        ...client,
        chunk: (input, signal) => {
          const request = chunkQueue.current.then(() => {
            signal.throwIfAborted();
            return client.chunk(input, signal);
          });
          chunkQueue.current = request.catch(() => undefined);
          return request;
        },
      };
      for (const file of files) {
        const id = crypto.randomUUID();
        const rejection = uploadRejection(file);
        setRows((current) => [...current, { id, name: file.name, size: file.size, received: 0, status: rejection ? 'failed' : 'uploading', error: rejection, retryable: false }]);
        if (rejection) continue;
        const entry: PendingUpload = { file, client: serialized, controller: null, session: null, resumable: false };
        pending.current.set(id, entry);
        void run(id, entry);
      }
    },
    retry: (id) => {
      const entry = pending.current.get(id);
      if (entry && !entry.controller) void run(id, entry);
    },
    cancel: (id) => {
      const entry = pending.current.get(id);
      pending.current.delete(id);
      setRows((current) => current.filter((row) => row.id !== id));
      if (!entry) return;
      // A running upload releases its server session once its in-flight request settles.
      if (entry.controller) entry.controller.abort();
      else if (entry.session) settle(entry.client.abort(entry.session.uploadId));
    },
  };
}

export function ArtifactUploadButton({ onFiles, disabledReason }: { onFiles(files: File[]): void; disabledReason: string | null }) {
  const input = useRef<HTMLInputElement>(null);
  const button = <Button variant="secondary" size="compact" className="min-h-10" type="button" disabled={disabledReason !== null} onClick={() => input.current?.click()}>Upload files</Button>;
  return <>
    <input ref={input} type="file" multiple hidden aria-label="Upload files to workspace uploads" onChange={(event) => {
      const files = [...(event.currentTarget.files ?? [])];
      event.currentTarget.value = '';
      if (files.length) onFiles(files);
    }} />
    {disabledReason ? <Tooltip content={disabledReason}><span>{button}</span></Tooltip> : button}
  </>;
}

export function ArtifactUploadList({ uploads }: { uploads: ArtifactUploads }) {
  const shape = useShape();
  if (!uploads.rows.length) return null;
  return <CardGroup border="outlined" aria-label="Uploads">{uploads.rows.map((row) => {
    const percent = Math.floor(row.received / Math.max(row.size, 1) * 100);
    return <Card key={row.id} size="compact">
      <CardHeader>
        <CardTitle className="truncate">{row.name}</CardTitle>
        <CardDescription className="tabular-nums">{`${formatBytes(row.received)} of ${formatBytes(row.size)} · ${percent}%${row.status === 'committing' ? ' · finishing' : ''}`}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {/* FLUID-GAP: progress meter — the registry has no read-only progress bar; the fill width is the acknowledged byte ratio. */}
        <span role="progressbar" aria-label={`Uploading ${row.name}`} aria-valuemin={0} aria-valuemax={row.size} aria-valuenow={row.received} className={`${shape.bg} block h-1 overflow-hidden bg-muted`}><span className="block h-full bg-foreground" style={{ width: `${percent}%` }} /></span>
        {row.error ? <p role="alert" className="text-caption text-destructive">{row.error}</p> : null}
      </CardContent>
      <CardFooter className="flex-wrap gap-2">
        {row.status === 'failed' && row.retryable ? <Button variant="secondary" size="compact" className="min-h-10" type="button" onClick={() => uploads.retry(row.id)}>Retry<span className="sr-only"> {row.name}</span></Button> : null}
        {row.status !== 'committing' ? <Button variant="ghost" size="compact" className="min-h-10" type="button" onClick={() => uploads.cancel(row.id)}>{row.status === 'failed' && !row.retryable ? 'Dismiss' : 'Cancel'}<span className="sr-only"> {row.name}</span></Button> : null}
      </CardFooter>
    </Card>;
  })}</CardGroup>;
}
