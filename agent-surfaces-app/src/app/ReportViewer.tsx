import type { ReportItem } from '../data/mock';

const KIND_TONE: Record<string, string> = { praise: 'blue', 'good-pattern': 'green', frustration: 'red', 'workflow-quirk': 'amber', 'gitspace-quirk': 'violet' };
const ATT_ICON: Record<string, string> = { conversation: '❝', prompt: '⌜', skill: '✦', tool: '⛭', 'workflow-snapshot': '⟜', 'goal-doc-snapshot': '◇' };

export function ReportViewer({ report }: { report: ReportItem | null }) {
  if (!report) return <div className="rpt"><div className="dim" style={{ padding: 16 }}>No report selected.</div></div>;
  return (
    <div className="rpt">
      <div className="rpt-head">
        <span className={`rep-kind ${KIND_TONE[report.kind]}`}>{report.kind}</span>
        <span className="rpt-surface">{report.surface}</span>
      </div>
      <div className="rpt-body">
        <div className="rpt-sec-l">agent feedback</div>
        <div className="rpt-feedback">{report.note}</div>
        <div className="rpt-sec-l" style={{ marginTop: 16 }}>attachments — what was reported</div>
        <div className="rpt-atts">
          {report.attachments && report.attachments.length > 0 ? report.attachments.map((a, i) => (
            <button key={i} className="rpt-att" title={`open ${a.type}`}>
              <span className="rpt-att-ic">{ATT_ICON[a.type] ?? '•'}</span>
              <span className="rpt-att-type">{a.type}</span>
              <span className="rpt-att-label">{a.label}</span>
              <span className="rpt-att-open">open ↗</span>
            </button>
          )) : <span className="dim" style={{ fontSize: 12 }}>no attachments</span>}
        </div>
      </div>
    </div>
  );
}
