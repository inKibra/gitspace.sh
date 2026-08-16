import { EVIDENCE } from '../data/mock';
import { ArtifactPreview } from './ArtifactPreview';

const EV_TONE: Record<string, string> = { command: 'green', screenshot: 'blue', video: 'violet', review: 'amber', note: 'dim', file: 'dim' };

// Standalone evidence viewer — opens an evidence artifact in its own tab.
export function EvidenceViewer({ evidenceId }: { evidenceId: string }) {
  const ev = EVIDENCE[evidenceId];
  if (!ev) return <div className="ev-view"><div className="dim" style={{ padding: 18 }}>Evidence not found: {evidenceId}</div></div>;
  return (
    <div className="ev-view">
      <div className="ev-view-h">
        <span className={`chip ${EV_TONE[ev.kind] ?? 'dim'}`}>{ev.kind}</span>
        <span className="ev-view-name mono">{ev.name}</span>
        {ev.meta && <span className="muted">— {ev.meta}</span>}
        <span className="ev-view-ref mono dim">{ev.id}</span>
        <span className={`chip ${ev.source === 'captured' ? 'green' : 'amber'}`}>{ev.source}</span>
      </div>
      <div className="ev-view-b"><ArtifactPreview refData={ev.ref} /></div>
    </div>
  );
}
