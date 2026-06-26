export function ArtifactViewer({ name }: { name: string }) {
  return (
    <div style={{ height: '100%', overflow: 'auto', padding: 16 }}>
      <div className="rv-head">
        <span className="rt">◇ {name}</span>
        <span className="rs">artifact · opened from the workflow</span>
      </div>
      <div className="callout" style={{ marginTop: 12 }}>
        <div className="ct">artifact</div>
        <b>{name}</b> renders here — a goal-doc slice opens the goal doc at its range, a rubric opens the rubric table, a snapshot renders read-only. Arbitrary artifacts show their stored content.
      </div>
    </div>
  );
}
