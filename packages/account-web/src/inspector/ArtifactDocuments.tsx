import { RESOURCE_TEXT_PREVIEW_BYTES } from '@gitspace/protocol/resource-uri';
import { Button, ScrollArea, Select, SelectTrigger, ThinkingIndicator, useShape } from '@gitspace/ui';
import { AlertCircle, Archive, File02 } from '@untitledui/icons';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { rpcErrorMessage } from '../rpc-error-message.js';
import { GitSpaceMarkdown } from '../GitSpaceMarkdown.js';
import { EmptyState } from '../GitSpaceShell.js';
import { type InspectorArtifactContent, selectOptions, type ArtifactReference, type LoadStatus, ic, artifactId, Padded } from './inspector-shared.js';
import type { InspectorProps } from './Inspector.js';
import { PdfPreview } from './FilesSurface.js';

/** A Markdown drive or repository file: links and images relative to it name the files beside it. */
function MarkdownArtifact({ source, documentUrl }: { source: string; documentUrl: string }) {
  return <ScrollArea className="min-h-0 flex-1" viewportClassName="h-full"><article className="mx-auto w-full max-w-3xl px-6 py-6"><GitSpaceMarkdown documentUri={documentUrl}>{source}</GitSpaceMarkdown></article></ScrollArea>;
}
function SourceArtifact({ source }: { source: string }) {
  // FLUID-GAP: code viewer — the registry has no read-only code block; plain <pre> on Fluid tokens.
  return <pre className="min-h-0 flex-1 overflow-auto bg-surface-1 p-4 font-mono text-caption text-foreground">{source}</pre>;
}
export function PreviewFrame({ children }: { children: ReactNode }) {
  return <div className="grid min-h-0 flex-1 place-items-center overflow-auto bg-surface-1 p-4">{children}</div>;
}

function MiniAppArtifact({ source, dataReferences, content, onLoad }: {
  source: string;
  dataReferences: readonly ArtifactReference[];
  content: Readonly<Record<string, InspectorArtifactContent>>;
  onLoad(reference: ArtifactReference): Promise<void>;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [dataUrl, setDataUrl] = useState(dataReferences[0]?.url ?? '');
  const selected = dataReferences.find((reference) => reference.url === dataUrl) ?? null;
  const dataSource = selected ? content[artifactId(selected)]?.source ?? null : null;
  useEffect(() => { if (selected && !content[artifactId(selected)]) void onLoad(selected); }, [selected ? artifactId(selected) : '', content]);
  let payload: unknown = null;
  if (dataSource) {
    try { payload = JSON.parse(dataSource); } catch { payload = null; }
  }
  const send = (): void => { frameRef.current?.contentWindow?.postMessage({ type: 'gssh:data', data: payload }, '*'); };
  useEffect(send, [source, dataSource]);
  return <div className="flex min-h-0 flex-1 flex-col bg-surface-1">
    {dataReferences.length ? <label className="flex items-center gap-2 border-b border-border px-3 py-2 text-caption text-muted-foreground"><span>Data</span><Select value={dataUrl} size="compact" onValueChange={setDataUrl}><SelectTrigger aria-label="Artifact data" />{selectOptions(dataReferences.map((reference) => ({ value: reference.url, label: reference.label })))}</Select></label> : null}
    <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={source} title="GitSpace mini-app" onLoad={send} className="min-h-0 w-full flex-1 bg-surface-3" />
  </div>;
}

export function ArtifactDocument({ reference, content, status, error, mode, artifactReferences, artifactContent, onRequest }: {
  reference: ArtifactReference;
  content: InspectorArtifactContent | null;
  status: LoadStatus;
  error: string | undefined;
  mode: 'preview' | 'source';
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequest(reference: ArtifactReference): Promise<void>;
}) {
  // Pinned evidence and transcript resources share the same preview renderers below.
  if (status === 'loading' || status === undefined) return <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label={`Loading ${reference.label}…`} /></div>;
  if (status === 'error') return <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Artifact could not load" description={error ?? 'The artifact read failed.'} action={<Button variant="secondary" size="compact" type="button" onClick={() => void onRequest(reference)}>Retry</Button>} /></Padded>;
  if (!content) return <Padded><EmptyState icon={ic(Archive, 22)} title="Artifact bytes are unavailable" description="The authority returned no readable content." /></Padded>;
  return <ArtifactPreview reference={reference} content={content} mode={mode} artifactReferences={artifactReferences} artifactContent={artifactContent} onRequest={onRequest} />;
}

function ArtifactPreview({ reference, content, mode, artifactReferences, artifactContent, onRequest }: {
  reference: Pick<ArtifactReference, 'url' | 'label' | 'mediaType'>;
  content: InspectorArtifactContent;
  mode: 'preview' | 'source';
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequest(reference: ArtifactReference): Promise<void>;
}) {
  const shape = useShape();
  const download = content.downloadUrl ? <a href={content.downloadUrl} download={reference.label} className="text-body text-primary underline">Download {reference.label}</a> : undefined;
  if (content.oversized) return <Padded><EmptyState icon={ic(File02, 22)} title="Too large to preview" description={`Files over ${RESOURCE_TEXT_PREVIEW_BYTES / 1024 / 1024} MiB open as a download.`} action={download} /></Padded>;
  if (mode === 'source') return content.source !== null ? <SourceArtifact source={content.source} /> : <Padded><EmptyState icon={ic(File02, 22)} title="Source is unavailable" description="This binary artifact has no text source." action={download} /></Padded>;
  const mediaType = content.mediaType ?? reference.mediaType;
  if (mediaType?.startsWith('image/')) return <PreviewFrame><img src={content.previewUrl} alt={reference.label} className={`${shape.container} max-h-full max-w-full bg-surface-3 object-contain shadow-surface-1`} /></PreviewFrame>;
  if ((reference.url.endsWith('.gssh.html') || mediaType === 'text/html') && content.source !== null) return <MiniAppArtifact source={content.source} dataReferences={artifactReferences.filter((candidate) => candidate.url.endsWith('.data.json'))} content={artifactContent} onLoad={onRequest} />;
  if (mediaType === 'application/pdf') return <PdfPreview url={content.previewUrl} name={reference.label} />;
  if (mediaType?.startsWith('audio/')) return <PreviewFrame><audio controls src={content.previewUrl} /></PreviewFrame>;
  if (mediaType?.startsWith('video/')) return <PreviewFrame><video controls src={content.previewUrl} className="max-h-full max-w-full" /></PreviewFrame>;
  if ((mediaType === 'application/json' || reference.url.endsWith('.json')) && content.source !== null) {
    let pretty = content.source;
    try { pretty = JSON.stringify(JSON.parse(content.source), null, 2); } catch { /* Render original text. */ }
    return <SourceArtifact source={pretty} />;
  }
  if ((mediaType === 'text/markdown' || reference.url.endsWith('.md')) && content.source !== null) return <MarkdownArtifact source={content.source} documentUrl={reference.url} />;
  return content.source !== null ? <SourceArtifact source={content.source} /> : <Padded><EmptyState icon={ic(Archive, 22)} title="Preview is unavailable" description="This artifact type has no inline renderer." action={download} /></Padded>;
}

export function ResourceDocument({ uri, mode, onRequest, artifactReferences, artifactContent, onRequestArtifact }: {
  uri: string;
  mode: 'preview' | 'source';
  onRequest: InspectorProps['onRequestResource'];
  artifactReferences: readonly ArtifactReference[];
  artifactContent: Readonly<Record<string, InspectorArtifactContent>>;
  onRequestArtifact(reference: ArtifactReference): Promise<void>;
}) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<{ content: InspectorArtifactContent } | { error: string } | null>(null);
  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    let loaded: InspectorArtifactContent | undefined;
    setResult(null);
    void (async () => {
      try {
        if (!onRequest) throw new Error('Resource reads are unavailable for this workspace.');
        const content = await onRequest(uri, controller.signal);
        if (cancelled) content.dispose?.();
        else { loaded = content; setResult({ content }); }
      } catch (error) {
        if (!cancelled) setResult({ error: rpcErrorMessage(error, 'Read workspace resource') });
      }
    })();
    return () => { cancelled = true; controller.abort(); loaded?.dispose?.(); };
  }, [uri, attempt]);
  if (!result) return <div className="flex flex-1 items-center justify-center p-6"><ThinkingIndicator aria-label={`Loading ${uri}…`} /></div>;
  if ('error' in result) return <Padded><EmptyState icon={ic(AlertCircle, 22)} title="Resource could not load" description={`${uri}: ${result.error}`} action={<Button variant="secondary" size="compact" type="button" onClick={() => setAttempt((value) => value + 1)}>Retry</Button>} /></Padded>;
  return <ArtifactPreview reference={{ url: uri, label: uri, mediaType: result.content.mediaType }} content={result.content} mode={mode} artifactReferences={artifactReferences} artifactContent={artifactContent} onRequest={onRequestArtifact} />;
}
