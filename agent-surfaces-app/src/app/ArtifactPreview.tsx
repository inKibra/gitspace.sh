import type { ArtifactRef } from '../blocks/types';

// ArtifactRef → inline preview. Shared by the Review rubric and the standalone
// EvidenceViewer so evidence renders identically wherever it's opened.
export function ArtifactPreview({ refData }: { refData: ArtifactRef }) {
  if (refData.kind === 'inline') return <pre className="rc-pre">{refData.text}</pre>;
  if (refData.kind === 'image') return (
    <div>
      <img className="rc-shot" src={refData.dataUrl} alt="" />
      <div className="dim mono rc-shot-meta">{refData.width}×{refData.height}{refData.bytes ? ` · ${(refData.bytes / 1024).toFixed(1)} KB` : ''}</div>
    </div>
  );
  if (refData.kind === 'path' && refData.mime?.startsWith('video/')) return (
    <div className="rc-poster"><span className="rc-play">▶</span><span className="mono dim">{refData.path}</span></div>
  );
  if (refData.kind === 'path') return <div className="rc-file mono"><span className="dim">file</span> {refData.path}</div>;
  return <a className="rc-file mono" href={refData.url}>{refData.url}</a>;
}
