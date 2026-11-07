// What shows in a block's place when it cannot be drawn (the validator's issues, and the source on request) and
// while its fence is still streaming.
import type { UiBlockIssue } from '@gitspace/protocol/gitspace-ui';
import { Button, useShape } from '@gitspace/ui';
import { AlertTriangle, Code02 } from '@untitledui/icons';
import { useState } from 'react';

const SHOWN_ISSUES = 8;

export function BlockErrorCard({ issues, source, sourceLabel }: { issues: readonly UiBlockIssue[]; source: string; sourceLabel: 'JSON' | 'SVG' }) {
  const shape = useShape();
  const [showSource, setShowSource] = useState(false);
  return <div role="group" aria-label="Block that could not be drawn" className={`my-2 flex flex-col gap-1.5 border border-border bg-surface-2 px-3 py-2 ${shape.container}`}>
    <span className="flex items-center gap-1.5 text-caption font-medium"><AlertTriangle width={14} height={14} className="shrink-0 text-destructive" />This block could not be drawn</span>
    <ul className="flex flex-col gap-0.5 text-caption text-muted-foreground">
      {issues.slice(0, SHOWN_ISSUES).map((issue, index) => <li key={index} className="[overflow-wrap:anywhere]">{issue.path ? <code className="font-mono text-foreground">{issue.path}</code> : null}{issue.path ? ': ' : ''}{issue.message}</li>)}
      {issues.length > SHOWN_ISSUES ? <li>and {issues.length - SHOWN_ISSUES} more</li> : null}
    </ul>
    <div><Button variant="ghost" size="compact" active={showSource} onClick={() => setShowSource(!showSource)}><Code02 width={14} height={14} />{showSource ? `Hide the ${sourceLabel}` : `Show the ${sourceLabel}`}</Button></div>
    {showSource ? <pre className={`max-h-80 overflow-auto border border-border bg-surface-3 p-2 font-mono text-[11px] leading-[1.45] ${shape.container}`}>{source}</pre> : null}
  </div>;
}

/** A fence that is still streaming: the block draws once it closes. */
export function BlockPlaceholder() {
  const shape = useShape();
  return <div role="status" className={`my-2 border border-dashed border-border px-3 py-2 text-caption text-muted-foreground ${shape.container}`}>Drawing…</div>;
}
