import { FileDiff } from '@pierre/diffs/react';
import { parsePatchFiles, type AnnotationSide, type DiffLineAnnotation, type FileDiffOptions, type SelectedLineRange } from '@pierre/diffs';
import { FileTree, useFileTree } from '@pierre/trees/react';
import type { GitStatusEntry } from '@pierre/trees';
import { Background, Controls, MarkerType, Position, ReactFlow, type Edge, type Node } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Archive, Boxes, Bot, Check, ChevronDown, File, FileCode2, FileJson2, FileText, Folder, GitBranch, HardDrive, Image, Inbox, KanbanSquare, LayoutDashboard, MessageSquare, MoreHorizontal, PanelRightClose, Plug, Plus, Search, Settings, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../src/styles.css';
import { WorkspaceTerminals, type WorkspaceTerminalOutput, type WorkspaceTerminalView } from '../src/WorkspaceTerminals.js';
import './workbench-preview.css';

type View = 'subagents' | 'files' | 'artifacts' | 'goal' | 'services' | 'terminals' | 'guide' | 'journal' | 'document';
type ArtifactId = 'report' | 'screenshot' | 'architecture';
type DocumentKind = 'diff' | 'file' | 'artifact' | 'goal' | 'workflow' | 'rubric';
type FileMode = 'current' | 'working' | 'staged' | 'base';
interface OpenDocument { id: string; kind: DocumentKind; label: string; target: string }
interface ThreadMessage { author: string; initials: string; at: string; body: string }
const sourceLines = ["import { Tabs } from '@base-ui/react/tabs';", "import { useSpaceJournal } from '../hooks/useSpaceJournal';", "import { useFactEvents } from '../hooks/useFactEvents';", '', 'export function WorkspaceInspector({ space }: Props) {', '  const journal = useSpaceJournal(space.id);', '  const activity = useFactEvents(space.id);', '  const [open, setOpen] = useState(true);', '', '  return <aside className="context-panel">', '    <Tabs.Root defaultValue="changes">', '      <Tabs.List>', '        <Tabs.Tab value="changes">Changes</Tabs.Tab>', '        <Tabs.Tab value="files">Files</Tabs.Tab>', '        <Tabs.Tab value="artifacts">Artifacts</Tabs.Tab>', '      </Tabs.List>', '      <ReviewThreadProvider spaceId={space.id}>', '        <InspectorViewer journal={journal} activity={activity} />', '      </ReviewThreadProvider>', '    </Tabs.Root>', '  </aside>;', '}'];
const diffLines = [
  { mark: ' ', text: "import { Tabs } from '@base-ui/react/tabs';" },
  { mark: '+', text: "import { useSpaceJournal } from '../hooks/useSpaceJournal';" },
  { mark: '+', text: "import { useFactEvents } from '../hooks/useFactEvents';" },
  { mark: ' ', text: '' },
  { mark: ' ', text: 'export function WorkspaceInspector({ space }: Props) {' },
  { mark: '+', text: '  const journal = useSpaceJournal(space.id);' },
  { mark: '+', text: '  const activity = useFactEvents(space.id);' },
  { mark: '-', text: '  return <EmptyInspector />;' },
  { mark: '+', text: '  return <InspectorViewer journal={journal} activity={activity} />;' },
  { mark: ' ', text: '}' },
];
const changes = [{ path: 'src/components/WorkspaceInspector.tsx', status: 'M', add: 84, remove: 12 }, { path: 'src/machine/portable-space.ts', status: 'M', add: 63, remove: 8 }, { path: 'src/events/fact-stream.ts', status: 'A', add: 41, remove: 0 }, { path: 'src/styles/inspector.css', status: 'M', add: 92, remove: 20 }];
const files = [{ path: 'src/components', name: 'components', kind: 'folder' }, { path: 'src/components/WorkspaceInspector.tsx', name: 'WorkspaceInspector.tsx', kind: 'file' }, { path: 'src/components/ReviewThread.tsx', name: 'ReviewThread.tsx', kind: 'file' }, { path: 'src/machine', name: 'machine', kind: 'folder' }, { path: 'src/machine/portable-space.ts', name: 'portable-space.ts', kind: 'file' }, { path: 'src/events/fact-stream.ts', name: 'fact-stream.ts', kind: 'file' }, { path: 'docs/FLEET.md', name: 'FLEET.md', kind: 'file' }];
const artifacts = [{ id: 'report' as const, name: 'portable-move.report.json', url: 'local://workspace/reports/portable-move.report.json', type: 'JSON', size: '2.4 KB' }, { id: 'screenshot' as const, name: 'browser-relay.jpg', url: 'local://workspace/screens/browser-relay.jpg', type: 'Image', size: '32.3 KB' }, { id: 'architecture' as const, name: 'space-model.svg', url: 'local://base/architecture/space-model.svg', type: 'SVG', size: '8.1 KB' }];
function LeftPanel({ projectCronsActive, onOpenProjectCrons, onOpenWorkspace }: { projectCronsActive: boolean; onOpenProjectCrons: () => void; onOpenWorkspace: () => void }) {
  return <aside className="app-left-panel"><header className="app-left-header"><span className="app-brand"><Boxes size={18} /></span><strong>GitSpace</strong><button className="app-icon-button" aria-label="Collapse app panel">‹</button></header><nav className="app-primary-nav"><button className="app-nav-button" data-active={!projectCronsActive || undefined} onClick={onOpenWorkspace}><Bot size={17} /><span>Agent</span></button><><button className="app-nav-button" onClick={() => { window.location.href = '/test/skills-preview.html?page=skills'; }}><Sparkles size={17} /><span>Skills</span></button><button className="app-nav-button" onClick={() => { window.location.href = '/test/skills-preview.html?page=plugins'; }}><Plug size={17} /><span>Plugins</span></button></><button className="app-nav-button"><KanbanSquare size={17} /><span>Kanban</span></button><button className="app-nav-button"><LayoutDashboard size={17} /><span>Projects</span></button><button className="app-nav-button"><Inbox size={17} /><span>Inbox</span></button></nav><div className="app-left-scroll"><section className="app-panel-section app-project-tree"><header><span>Projects</span></header><section className="project-tree-project"><div className="project-tree-header"><button className="project-tree-open"><span className="workspace-status-dot" style={{ background: 'var(--status-blue)' }} /><Folder size={14} /><span><strong>GitSpace</strong><small>Base · Waiting</small></span></button><span className="workspace-actions"><button className="workspace-actions-trigger" aria-label="Project actions"><MoreHorizontal size={14} /></button></span><button className="app-icon-button" aria-label="Collapse GitSpace"><ChevronDown size={14} /></button></div><div className="project-tree-children"><div className="app-workspace-row-shell" data-active={!projectCronsActive || undefined}><button className="app-workspace-row" onClick={onOpenWorkspace}><span className="workspace-status-dot" style={{ background: 'var(--status-green)' }} /><span className="app-workspace-copy"><strong>agent-blame</strong><small>feature/agent-blame</small></span><em>Code</em></button><span className="workspace-actions"><button className="workspace-actions-trigger" aria-label="Space actions"><MoreHorizontal size={14} /></button></span></div><div className="app-workspace-row-shell"><button className="app-workspace-row"><span className="workspace-status-dot" style={{ background: 'var(--status-blue)' }} /><span className="app-workspace-copy"><strong>inspector-shell</strong><small>feature/inspector</small></span><em>Review</em></button><span className="workspace-actions"><button className="workspace-actions-trigger" aria-label="Space actions"><MoreHorizontal size={14} /></button></span></div><button className="project-cron-nav" data-active={projectCronsActive || undefined} onClick={onOpenProjectCrons}><span>◷</span><strong>Crons &amp; triggers</strong><em>3</em></button></div></section></section></div><footer className="app-left-footer"><button className="app-icon-button" aria-label="Search"><Search size={16} /></button><button className="app-icon-button" aria-label="Settings"><Settings size={16} /></button><span className="machine-presence"><HardDrive size={13} /><span>local-machine</span></span></footer></aside>;
}
function Conversation({ onOpenTerminal }: { onOpenTerminal: (id: string) => void }) {
  const [moveOpen, setMoveOpen] = useState(false);
  const [destination, setDestination] = useState('build-machine');
  const [moving, setMoving] = useState(false);
  return <div className="conversation-stage"><main className="agent-canvas" data-lifecycle={moving || undefined}><header className="agent-canvas-header"><div><span><GitBranch size={13} />GitSpace / feature/agent-blame</span><div className="agent-title-row"><h1>agent-blame</h1><button className="agent-machine-button" onClick={() => setMoveOpen((open) => !open)}><HardDrive size={11} />{moving ? destination : 'local-machine'}<ChevronDown size={10} /></button></div>{moveOpen ? <div className="move-popover"><header><strong>Move workspace</strong><span>Durable state moves; running processes restart through the destination Hub.</span></header><label><span>Destination machine</span><select value={destination} onChange={(event) => setDestination(event.currentTarget.value)}><option value="build-machine">build-machine · Ready</option><option value="local-machine">local-machine · Current</option><option value="cloud-dev-03">cloud-dev-03 · Sleeping</option></select></label><div><span><b>1</b> Transfer workspace generation</span><span><b>2</b> Run setup → select in destination Hub</span><span><b>3</b> Commit placement, then clean source</span></div><footer><button onClick={() => setMoveOpen(false)}>Cancel</button><button onClick={() => { setMoving(true); setMoveOpen(false); }}>Move to {destination}</button></footer></div> : null}</div><div className="agent-header-state"><span className="workspace-status-dot workspace-status-pulse" style={{ background: moving ? 'var(--status-orange)' : 'var(--status-green)' }} /><span>{moving ? 'Moving' : 'Running'}</span><em>Code</em></div></header><div className="mock-transcript"><article className="mock-turn"><div className="mock-user"><span className="mock-avatar">Y</span><div><strong>You</strong><p>Unify file, diff, artifact, and review commenting in the workspace Inspector.</p></div></div><div className="mock-agent"><header><strong>GitSpace</strong><span>working · 2m</span></header><p>I’m updating the shared viewer and review-thread backing model. The Files, Artifacts, and Guide surfaces resolve the same durable thread IDs.</p></div></article></div><div className="agent-composer"><textarea aria-label="Message" rows={2} placeholder="Ask the workspace agent…" /><footer><span>GitSpace / feature/agent-blame</span><button>Send</button></footer></div>{moving ? <button className="workspace-lifecycle-bar" onClick={() => onOpenTerminal('life-move-7')}><span className="workspace-status-dot workspace-status-pulse" style={{ background: 'var(--status-orange)' }} /><strong>Moving to {destination}</strong><span className="lifecycle-steps"><i data-done>Transfer</i><i data-active>Setup</i><i>Select</i><i>Remove</i></span><em>0:42</em><small>Open terminal ›</small></button> : null}</main></div>;
}
const diffPatch = `diff --git a/src/components/WorkspaceInspector.tsx b/src/components/WorkspaceInspector.tsx
index 90210..41b7c 100644
--- a/src/components/WorkspaceInspector.tsx
+++ b/src/components/WorkspaceInspector.tsx
@@ -1,6 +1,9 @@
 import { Tabs } from '@base-ui/react/tabs';
+import { useSpaceJournal } from '../hooks/useSpaceJournal';
+import { useFactEvents } from '../hooks/useFactEvents';
 
 export function WorkspaceInspector({ space }: Props) {
-  return <EmptyInspector />;
+  const journal = useSpaceJournal(space.id);
+  const activity = useFactEvents(space.id);
+  return <InspectorViewer journal={journal} activity={activity} />;
 }`;
function currentFilePatch(filePath: string, text = sourceLines.join('\n')): string {
  const lines = text.split('\n');
  return `diff --git a/${filePath} b/${filePath}\n--- a/${filePath}\n+++ b/${filePath}\n@@ -1,${lines.length} +1,${lines.length} @@\n${lines.map((line) => ` ${line}`).join('\n')}\n`;
}
function PierreRepoTree({ changedOnly, onOpen }: { changedOnly: boolean; onOpen: (path: string) => void }) {
  const paths = useMemo(() => files.filter((entry) => entry.kind === 'file').map((entry) => entry.path), []);
  const changedPaths = useMemo(() => new Set(changes.map((entry) => entry.path)), []);
  const shownPaths = useMemo(() => changedOnly ? paths.filter((path) => changedPaths.has(path)) : paths, [changedOnly, changedPaths, paths]);
  const gitStatus = useMemo<GitStatusEntry[]>(() => changes.map((entry) => ({ path: entry.path, status: entry.status === 'A' ? 'added' : 'modified' })), []);
  const fileSetRef = useRef(new Set(shownPaths));
  fileSetRef.current = new Set(shownPaths);
  const openRef = useRef(onOpen);
  openRef.current = onOpen;
  const { model } = useFileTree({ paths: shownPaths, gitStatus, initialExpandedPaths: ['src', 'src/components', 'src/machine', 'src/events'], density: 'compact', onSelectionChange: (selected) => { const path = selected.find((candidate) => fileSetRef.current.has(candidate)); if (path) openRef.current(path); } });
  useEffect(() => { model.resetPaths(shownPaths, { initialExpandedPaths: ['src', 'src/components', 'src/machine', 'src/events'] }); }, [model, shownPaths]);
  useEffect(() => { model.setGitStatus(gitStatus); }, [gitStatus, model]);
  return <FileTree model={model} className="gs-pierre-tree" />;
}
interface MockAnnotation { label: string }
function PierreViewer({ patch, filePath, plain, onThread }: { patch: string; filePath: string; plain: boolean; onThread: (line: number) => void }) {
  const fileDiff = useMemo(() => parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0] ?? null, [patch]);
  const threadLine = plain ? 7 : 6;
  const annotations = useMemo<DiffLineAnnotation<MockAnnotation>[]>(() => [{ side: 'additions', lineNumber: threadLine, metadata: { label: '2 comments' } }], [threadLine]);
  const options = useMemo<FileDiffOptions<MockAnnotation>>(() => ({ diffStyle: 'unified', theme: 'github-light', disableFileHeader: true, hunkSeparators: 'line-info', enableHoverUtility: true, enableLineSelection: true, onLineSelectionEnd: (range: SelectedLineRange | null) => { if (range) onThread(Math.min(range.start, range.end)); } }), [onThread]);
  if (!fileDiff) return <div className="viewer-empty"><strong>No parseable file content for {filePath}</strong></div>;
  return <div className="pierre-diff-host"><FileDiff fileDiff={fileDiff} options={options} lineAnnotations={annotations} renderAnnotation={(annotation) => <button className="pierre-inline-thread" onClick={() => onThread(annotation.lineNumber)}><MessageSquare size={12} /><span><strong>{annotation.metadata.label}</strong><small>Reviewer · Workspace agent</small></span></button>} renderHoverUtility={(getHoveredLine: () => { lineNumber: number; side: AnnotationSide } | undefined) => <button className="pierre-comment-plus" aria-label="Add line comment" onMouseDown={(event) => { event.preventDefault(); const hovered = getHoveredLine(); if (hovered) onThread(hovered.lineNumber); }}>+</button>} /></div>;
}
function SourceRows({ kind, selected, onSelect }: { kind: 'changes' | 'files'; selected: string; onSelect: (path: string) => void }) { const rows = kind === 'changes' ? changes : files; return <div className="source-list">{rows.map((row) => { const path = row.path; const folder = 'kind' in row && row.kind === 'folder'; return <button className="source-row" data-active={selected === path || undefined} onClick={() => !folder && onSelect(path)} key={path}>{folder ? <Folder size={14} /> : <FileCode2 size={14} />}<span><strong>{'name' in row ? row.name : path.split('/').at(-1)}</strong><small>{path}</small></span>{'add' in row ? <em className="change-stat"><b>+{row.add}</b><i>−{row.remove}</i></em> : null}</button>; })}</div>; }
function CodeViewer({ diff, threadOpen, onThread }: { diff: boolean; threadOpen: boolean; onThread: (line: number) => void }) { const rows = diff ? diffLines : sourceLines.map((text) => ({ mark: ' ', text })); return <div className="code-scroll"><table className="code-table"><tbody>{rows.map((line, index) => { const number = index + 1; const hasThread = number === (diff ? 6 : 7); return <tr key={number} data-add={line.mark === '+' || undefined} data-remove={line.mark === '-' || undefined} data-thread={hasThread || undefined}><td className="line-no">{number}</td><td className="line-mark">{hasThread ? <button className="thread-dot" aria-label={`Open thread on line ${number}`} onClick={() => onThread(number)}>2</button> : <button className="comment-gutter" aria-label={`Comment on line ${number}`} onClick={() => onThread(number)}>+</button>}</td><td>{line.mark !== ' ' ? `${line.mark} ` : '  '}{line.text}</td></tr>; })}</tbody></table>{threadOpen ? null : null}</div>; }
function WorkflowDocument() {
  const [selected, setSelected] = useState('design');
  const nodes = useMemo<Node[]>(() => [
    { id: 'discover', position: { x: 20, y: 110 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-node"><span>Phase 1 · Done</span><strong>Discover</strong><small>scout · default role</small><em>Reads: 0.x surfaces</em><em>Writes: evidence board ◇</em></div> }, style: { width: 210 } },
    { id: 'evidence', position: { x: 270, y: 125 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-artifact"><span>◇ artifact</span><strong>Evidence board</strong></div> }, style: { width: 150 } },
    { id: 'design', position: { x: 465, y: 85 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-node"><span>Phase 2 · Running</span><strong>Design</strong><small>designer · vision role</small><em>Reads: evidence board ◇</em><em>Writes: Inspector spec ◇</em></div> }, style: { width: 220, background: '#ebe8fb', borderColor: '#6858cb' } },
    { id: 'gate', position: { x: 475, y: 250 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-gate"><span>◆ human gate</span><strong>Approve placement</strong><small>1 owed · unmet</small></div> }, style: { width: 190 } },
    { id: 'spec', position: { x: 735, y: 125 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-artifact"><span>◇ artifact</span><strong>Inspector spec</strong></div> }, style: { width: 145 } },
    { id: 'verify', position: { x: 930, y: 100 }, sourcePosition: Position.Right, targetPosition: Position.Left, data: { label: <div className="flow-node"><span>Phase 3 · Pending</span><strong>Verify</strong><small>reviewer · slow role</small><em>Reads: Inspector spec ◇</em><em>Writes: move demo ◇</em></div> }, style: { width: 210 } },
  ], []);
  const edges = useMemo<Edge[]>(() => [
    { id: 'd-e', source: 'discover', target: 'evidence', animated: false, markerEnd: { type: MarkerType.ArrowClosed } },
    { id: 'e-design', source: 'evidence', target: 'design', markerEnd: { type: MarkerType.ArrowClosed } },
    { id: 'design-gate', source: 'design', target: 'gate', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
    { id: 'design-spec', source: 'design', target: 'spec', markerEnd: { type: MarkerType.ArrowClosed } },
    { id: 'gate-spec', source: 'gate', target: 'spec', type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed } },
    { id: 'spec-verify', source: 'spec', target: 'verify', markerEnd: { type: MarkerType.ArrowClosed } },
  ], []);
  return <div className="workflow-document"><header><span>Optional workflow</span><h2>Review-gated product archaeology</h2><p><code>.gitspace/workflows/product-archaeology</code> · 3 phases · typed source/artifact dataflow · human gate</p></header><div className="workflow-canvas"><ReactFlow nodes={nodes} edges={edges} fitView minZoom={0.45} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false} elementsSelectable onNodeClick={(_, node) => setSelected(node.id)}><Background gap={18} size={1} color="#dedbd4" /><Controls showInteractive={false} /></ReactFlow></div><section className="gate-ledger"><header><strong>Gate ledger</strong><span>1 satisfied · 1 owed · 1 blocked</span></header><div><article data-state="satisfied"><i>✓</i><span><strong>Discover · source readiness</strong><small>Trivial gate · required 0 · satisfied</small></span><em>Satisfied</em></article><article data-state="owed"><i>◆</i><span><strong>Design · approve placement</strong><small>Human gate · required 1 · owed 1</small></span><em>Unmet</em></article><article data-state="blocked"><i>×</i><span><strong>Verify · review contract</strong><small>Rubric gate · waiting on Design approval</small></span><em>Blocked</em></article></div></section><div className="workflow-selection"><strong>{selected === 'gate' ? 'Human gate · Approve placement' : selected === 'verify' ? 'Phase 3 · Verify' : selected === 'discover' ? 'Phase 1 · Discover' : 'Phase 2 · Design'}</strong><span>{selected === 'gate' ? 'Reviewer approval is required before Inspector spec becomes an accepted input to Verify.' : selected === 'verify' ? 'Reviewer reads the accepted Inspector spec and produces the required move-demo artifact.' : selected === 'discover' ? 'Scout reads 0.x source surfaces and produces the evidence-board artifact.' : 'Designer reads the evidence board and writes the Inspector spec; failure loops back from the human gate.'}</span></div></div>;
}
function RubricDocument() {
  const [criterion, setCriterion] = useState<'viewer' | 'artifact' | 'move'>('viewer');
  const [humanDecision, setHumanDecision] = useState<'pending' | 'pass' | 'changes'>('pending');
  const selected = criterion === 'viewer'
    ? { status: humanDecision === 'pass' ? 'Pass' : humanDecision === 'changes' ? 'Needs changes' : 'Review', tone: humanDecision === 'pass' ? 'pass' : 'review', title: 'File and diff modes share one comment system', phase: 'DESIGN', rubric: 'Current and every Git diff mode use Pierre annotations and the same durable review threads.', judge: 'Human' as const }
    : criterion === 'artifact'
      ? { status: 'Pass', tone: 'pass', title: 'Artifacts render inline for review', phase: 'VERIFY', rubric: 'Matched evidence renders inside the rubric before the reviewer decides whether to open or download the artifact.', judge: 'LLM' as const }
      : { status: 'Fail', tone: 'missing', title: 'Threads restore after a machine move', phase: 'REVIEW', rubric: 'A thread anchored before movement resolves against the restored blob identity without silently drifting.', judge: 'Command' as const };
  return <div className="rubric-document"><header><span>Optional review rubric</span><h2>Inspector review contract</h2><p>Top-level criteria · phase joins · Human, LLM, and Command judges · inline evidence</p></header><div className="rubric-workbench"><nav>{([['viewer','File and diff comments','Human'],['artifact','Inline artifact review','LLM'],['move','Thread movement','Command']] as const).map(([id, label, judge]) => <button data-active={criterion === id || undefined} onClick={() => setCriterion(id)} key={id}><span data-tone={id === 'artifact' ? 'pass' : id === 'move' ? 'missing' : 'review'}>{id === 'artifact' ? 'Pass' : id === 'move' ? 'Fail' : humanDecision === 'pass' ? 'Pass' : 'Review'}</span><strong>{label}</strong><small>⧗ {id === 'viewer' ? 'Design' : id === 'artifact' ? 'Verify' : 'Review'} · {judge} judge</small></button>)}</nav><main><div className="rubric-detail-head"><span data-tone={selected.tone}>{selected.status}</span><em>⧗ {selected.phase} · {selected.judge} judge</em><strong>{selected.title}</strong><p>{selected.rubric}</p></div><section><h3>Evidence — review inline</h3>{criterion === 'viewer' ? <div className="inline-evidence"><img src="http://127.0.0.1:4317/gitspace-worksheet-refs/gooey-browser.jpg" alt="Browser Relay evidence" /><footer><span><strong>browser-relay.jpg</strong><small>local://workspace/screens/browser-relay.jpg · screenshot</small></span><em>Human evidence</em></footer></div> : criterion === 'artifact' ? <div className="inline-evidence report-evidence"><header><strong>Portable move verification</strong><em>Passed</em></header><p>Generation fence ✓ · Git state restored ✓ · Main agent continued ✓</p><pre>{`{\n  \"status\": \"passed\",\n  \"checks\": 3\n}`}</pre><footer><span><strong>portable-move.report.json</strong><small>local://workspace/reports/portable-move.report.json · report</small></span><em>LLM evidence</em></footer></div> : <div className="command-evidence"><header><span>Command evidence</span><code>bun run test:move</code><em>exit 1</em></header><pre>{`restore generation 7 ... ok\nthread anchor 41b7c2 ... missing\nexpected thread count 1, received 0`}</pre></div>}</section><section><h3>{selected.judge} judgment</h3>{criterion === 'viewer' ? <div className="human-judgment"><textarea aria-label="Human review note" placeholder="Write the review rationale…" defaultValue={humanDecision === 'pending' ? '' : 'The inline Pierre thread and Current/Diff modes preserve one comment path.'} /><div><button onClick={() => setHumanDecision('changes')}>Needs changes</button><button className="pass" onClick={() => setHumanDecision('pass')}>Pass criterion</button></div></div> : criterion === 'artifact' ? <div className="judge-result"><header><span>Reviewer role · gpt-5.6</span><strong>Pass · 0.94 confidence</strong></header><p>Evidence is directly reviewable in context, preserves the stable `local://` identity, and does not require opening a separate tab.</p><small>Cites: portable-move.report.json lines 2–8</small></div> : <div className="judge-result failed"><header><span>Command · deterministic</span><strong>Fail · exit 1</strong></header><p>The restored workspace lost one thread anchor. This criterion blocks review completion until the move/reopen contract passes.</p><small>Command: bun run test:move</small></div>}</section></main></div></div>;
}
function ProductDocument({ kind, onOpenEvidence }: { kind: 'goal' | 'workflow' | 'rubric'; onOpenEvidence: (artifact: ArtifactId) => void }) {
  if (kind === 'workflow') return <WorkflowDocument />;
  if (kind === 'rubric') return <RubricDocument />;
  return <div className="product-document"><header><span>Goal</span><h2>Workspace Inspector and portable context</h2><p>Keep durable space context beside the canonical agent without making workflow or rubric mandatory.</p></header><section><h3>Requirements</h3><div className="goal-requirements"><article><span data-tone="pass">Passed</span><strong>Inspector communicates space state clearly</strong><small>Evidence: browser-relay.jpg</small></article><article><span data-tone="review">Review</span><strong>Space moves without recovering hub processes</strong><small>Evidence: portable-move.report.json</small></article><article><span data-tone="missing">Missing</span><strong>Review comments survive placement changes</strong><small>No accepted evidence yet</small></article></div></section></div>;
}
function GoalSurface({ onOpen, openTabs }: { onOpen: (document: OpenDocument) => void; openTabs: number }) {
  return <div className="goal-surface"><header className="goal-overview-head"><div><span>Workspace goal</span><h2>Workspace Inspector and portable context</h2><p>agent-blame · Code on local-machine · generation 7</p></div><dl><div><dt>Status</dt><dd><b className="workspace-status-dot" style={{ background: 'var(--status-green)' }} />Running</dd></div><div><dt>Branch</dt><dd>feature/agent-blame</dd></div><div><dt>Open tabs</dt><dd>{openTabs}</dd></div><div><dt>Review threads</dt><dd>1</dd></div></dl></header><div className="goal-progress"><span><b>1</b> passed</span><span><b>1</b> in review</span><span><b>1</b> missing</span><i /></div><div className="goal-surface-grid"><button onClick={() => onOpen({ id: 'goal:main', kind: 'goal', label: 'Goal', target: 'goal:main' })}><FileText size={18} /><span><strong>Goal document</strong><small>3 requirements · revision 8</small></span><em>Open</em></button><button onClick={() => onOpen({ id: 'workflow:main', kind: 'workflow', label: 'Workflow', target: 'workflow:main' })}><GitBranch size={18} /><span><strong>Workflow</strong><small>Optional · Design phase active</small></span><em>Open</em></button><button onClick={() => onOpen({ id: 'rubric:main', kind: 'rubric', label: 'Review rubric', target: 'rubric:main' })}><MessageSquare size={18} /><span><strong>Review rubric</strong><small>Optional · 1 pass · 1 review · 1 missing</small></span><em>Open</em></button></div><section><h3>Matched evidence</h3><div className="goal-evidence"><button onClick={() => onOpen({ id: 'artifact:screenshot', kind: 'artifact', label: 'browser-relay.jpg', target: 'screenshot' })}><Image size={14} /><span><strong>browser-relay.jpg</strong><small>Inspector communicates space state clearly</small></span><em>Pass</em></button><button onClick={() => onOpen({ id: 'artifact:report', kind: 'artifact', label: 'portable-move.report.json', target: 'report' })}><FileJson2 size={14} /><span><strong>portable-move.report.json</strong><small>Artifacts open as persistent tabs</small></span><em>Review</em></button></div></section></div>;
}
function ServicesSurface() {
  const [service, setService] = useState('web');
  const services = [
    { id: 'web', name: 'web', command: 'bun run dev', state: 'running', port: '5173', url: 'http://127.0.0.1:5173', session: 'svc-web-1', uptime: '42m' },
    { id: 'docs', name: 'docs', command: 'bun run docs', state: 'running', port: '4321', url: 'https://docs.agent-blame.local', session: 'svc-docs-1', uptime: '18m' },
    { id: 'worker', name: 'queue-worker', command: 'bun run worker', state: 'failed', port: '—', url: 'No HTTP endpoint', session: 'svc-worker-1', uptime: 'exited 2m ago' },
  ];
  const selectedService = services.find((item) => item.id === service) ?? services[0]!;
  return <div className="services-surface"><header><div><span>Workspace services</span><h2>Services</h2><p>Processes hosted by the agent-blame workspace Hub.</p></div></header><div className="service-layout"><aside><div className="operations-kicker"><strong>Processes</strong><span>2 running · 1 failed</span></div>{services.map((item) => <button data-active={service === item.id || undefined} onClick={() => setService(item.id)} key={item.id}><i data-state={item.state} /><span><strong>{item.name}</strong><small>{item.state === 'running' ? `:${item.port} · ${item.uptime}` : item.uptime}</small></span><em>{item.state}</em></button>)}</aside><main><header><span><i data-state={selectedService.state} />{selectedService.state}</span><h3>{selectedService.name}</h3><code>{selectedService.command}</code><div><button>{selectedService.state === 'running' ? 'Open' : 'Restart'}</button><button>Attach terminal</button><button>{selectedService.state === 'running' ? 'Stop' : 'Disable'}</button></div></header><dl><div><dt>Endpoint</dt><dd>{selectedService.url}</dd></div><div><dt>Hub terminal</dt><dd>{selectedService.session}</dd></div><div><dt>Placement</dt><dd>agent-blame · local-machine</dd></div><div><dt>Policy</dt><dd>restart on failure · 3 attempts</dd></div></dl><section><h4>Recent output</h4><pre>{selectedService.state === 'failed' ? `21:08:14 connecting to queue\n21:08:15 error ECONNREFUSED 127.0.0.1:6379\n21:08:15 exited with code 1` : `21:12:03 ready on ${selectedService.url}\n21:18:44 GET /health 200\n21:20:11 client connected`}</pre></section></main></div></div>;
}
let mockHubTerminals: WorkspaceTerminalView[] = [
  { spaceId: 'workspace-a', name: 'life-move-7', id: 'hub-1', kind: 'lifecycle', state: 'running', machineId: 'build-machine', owner: 'gitspace:workspace-a:lifecycle', command: '.gitspace/scripts/setup/01-dependencies.sh', cwd: '/workspace/agent-blame', createdAt: new Date(), exitCode: null },
  { spaceId: 'workspace-a', name: 'agent-test', id: 'hub-2', kind: 'agent', state: 'running', machineId: 'local-machine', owner: 'omp-session-a', command: 'bun test --watch', cwd: '/workspace/agent-blame', createdAt: new Date(), exitCode: null },
  { spaceId: 'workspace-a', name: 'shell-main', id: 'hub-3', kind: 'user', state: 'running', machineId: 'local-machine', owner: 'gitspace:workspace-a:user', command: '/bin/bash', cwd: '/workspace/agent-blame', createdAt: new Date(), exitCode: null },
];
const mockHubOutput = new Map<string,string>([
  ['life-move-7', 'Resolving bundle inputs…\r\nInstalling dependencies…\r\nRunning 20-configure.sh…'],
  ['agent-test', 'watching packages/account-web\r\n✓ 5 tests passed\r\nwaiting for changes…'],
  ['shell-main', 'agent-blame feature/agent-blame\r\n$ '],
]);
const workbenchTerminalApi = {
  list: async () => mockHubTerminals,
  create: async () => {
    const terminal: WorkspaceTerminalView = { spaceId: 'workspace-a', name: `shell-${mockHubTerminals.length + 1}`, id: crypto.randomUUID(), kind: 'user', state: 'running', machineId: 'local-machine', owner: 'gitspace:workspace-a:user', command: '/bin/bash', cwd: '/workspace/agent-blame', createdAt: new Date(), exitCode: null };
    mockHubTerminals = [terminal, ...mockHubTerminals];
    mockHubOutput.set(terminal.name, 'agent-blame feature/agent-blame\r\n$ ');
    return terminal;
  },
  read: async (name: string): Promise<WorkspaceTerminalOutput> => ({ spaceId: 'workspace-a', name, state: mockHubTerminals.find((terminal) => terminal.name === name)?.state ?? 'exited', cursor: (mockHubOutput.get(name) ?? '').length, data: mockHubOutput.get(name) ?? '' }),
  send: async (name: string, data: string) => { mockHubOutput.set(name, `${mockHubOutput.get(name) ?? ''}${data}`); },
  stop: async (name: string) => { mockHubTerminals = mockHubTerminals.map((terminal) => terminal.name === name ? { ...terminal, state: 'exited', exitCode: 0 } : terminal); },
};
function TerminalsSurface({ requestedId }: { requestedId: string | null }) {
  return <div className="workbench-production-terminals"><WorkspaceTerminals key={requestedId ?? 'default'} {...workbenchTerminalApi} /></div>;
}
function ProjectCronsPage() {
  const [targets, setTargets] = useState<Record<string,string>>({ health: 'project', triage: 'agent-blame', digest: 'inspector-shell' });
  const crons = [
    { id: 'health', name: 'project-health', when: 'every 6h', description: 'Review repository health, summarize blockers, and notify the project agent when intervention is needed.', next: 'in 4h 12m' },
    { id: 'triage', name: 'nightly-triage', when: 'every 1d', description: 'Ask the agent-blame workspace agent to triage open failures and update the project report.', next: 'tomorrow 00:14' },
    { id: 'digest', name: 'inspector-digest', when: 'every 12h', description: 'Have the Inspector workspace agent narrate material changes since the previous digest.', next: 'in 8h 02m' },
  ];
  return <main className="project-crons-page"><header><div><span>GitSpace project</span><h1>Crons &amp; triggers</h1><p>Project-owned schedules can talk to the project agent or any workspace’s canonical agent.</p></div><button><Plus size={12} />New cron</button></header><section className="project-cron-summary"><div><strong>3</strong><span>Armed</span></div><div><strong>3</strong><span>Agent targets</span></div><div><strong>0</strong><span>Failures</span></div><p>Fires from local-machine · registry scope <code>GitSpace:@base</code></p></section><section className="project-cron-list">{crons.map((cron) => <article key={cron.id}><header><span><strong>{cron.name}</strong><small>project cron</small></span><code>{cron.when}</code><em>armed</em><button>Run now</button></header><div><label><span>Talk to</span><select value={targets[cron.id]} onChange={(event) => { const value = event.currentTarget.value; setTargets((current) => ({ ...current, [cron.id]: value })); }}><option value="project">Project agent · GitSpace</option><option value="agent-blame">Workspace agent · agent-blame</option><option value="inspector-shell">Workspace agent · inspector-shell</option><option value="base">Workspace agent · GitSpaceBase</option></select></label><span className="cron-description"><b>Description</b>{cron.description}</span><span><b>Next run</b>{cron.next}</span></div></article>)}</section></main>;
}
function ChangeGuideSurface({ onOpenFile }: { onOpenFile: (path: string) => void }) {
  const steps = useMemo(() => [
    { id: 'placement', n: 1, title: 'Unify the Inspector placement', kind: 'decision', what: 'Move durable workspace context into one Inspector without turning every surface into a document tab.', why: 'The user needs one stable place to orient, then independent tabs only for things they intentionally open.', file: 'src/components/WorkspaceInspector.tsx' },
    { id: 'review', n: 2, title: 'Share the review surface', kind: 'behavior', what: 'Current files and every Git diff mode render through Pierre with the same annotations.', why: 'A comment cannot change identity because the reviewer switched from Working diff to Current.', file: 'src/components/ReviewThread.tsx' },
    { id: 'movement', n: 3, title: 'Fence portable state', kind: 'risk', what: 'Resolve tabs, threads, and artifacts against the current workspace generation after a move.', why: 'Restoring hub processes would revive stale authority; stable data identities can move safely without process recovery.', file: 'src/machine/portable-space.ts' },
  ], []);
  const [active, setActive] = useState(0);
  const [done, setDone] = useState<Set<number>>(() => new Set([0]));
  const scrollRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Array<HTMLElement | null>>([]);
  const holdRef = useRef(0);
  useEffect(() => {
    const root = scrollRef.current;
    if (!root) return;
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting).sort((a, b) => Math.abs(a.boundingClientRect.top - root.getBoundingClientRect().top) - Math.abs(b.boundingClientRect.top - root.getBoundingClientRect().top))[0];
      if (visible) setActive(Number((visible.target as HTMLElement).dataset.guideIndex));
    }, { root, rootMargin: '-8% 0px -72% 0px' });
    sectionRefs.current.forEach((section) => section && observer.observe(section));
    const cancel = () => { holdRef.current += 1; };
    root.addEventListener('wheel', cancel, { passive: true });
    root.addEventListener('touchstart', cancel, { passive: true });
    root.addEventListener('pointerdown', cancel);
    return () => { observer.disconnect(); root.removeEventListener('wheel', cancel); root.removeEventListener('touchstart', cancel); root.removeEventListener('pointerdown', cancel); };
  }, [steps]);
  const go = (index: number): void => {
    setActive(index);
    const token = ++holdRef.current;
    let settledFrames = 0;
    let frames = 0;
    const converge = (): void => {
      if (holdRef.current !== token) return;
      const root = scrollRef.current;
      const section = sectionRefs.current[index];
      if (!root || !section) return;
      const delta = section.getBoundingClientRect().top - root.getBoundingClientRect().top - 6;
      frames += 1;
      if (Math.abs(delta) > 1) { root.scrollTop += delta; settledFrames = 0; } else settledFrames += 1;
      if (settledFrames < 12 && frames < 300) requestAnimationFrame(converge);
    };
    requestAnimationFrame(converge);
  };
  const toggleDone = (index: number): void => setDone((current) => { const next = new Set(current); if (next.has(index)) next.delete(index); else next.add(index); return next; });
  return <div className="change-guide"><aside><header><strong>Change Guide</strong><span>The PR as a story</span></header><nav><i />{steps.map((step, index) => <button data-active={active === index || undefined} data-done={done.has(index) || undefined} onClick={() => go(index)} key={step.id}><b>{done.has(index) ? '✓' : step.n}</b><span>{step.title}</span></button>)}</nav><div className="guide-progress">{done.size} / {steps.length} sections reviewed</div><section><span>{steps[active]!.kind}</span><strong>{steps[active]!.what}</strong><p><b>Why</b>{steps[active]!.why}</p></section><footer><button>Review rubric</button><button disabled={done.size !== steps.length}>{done.size === steps.length ? 'Approve' : `Approve · ${done.size}/${steps.length}`}</button></footer></aside><main ref={scrollRef}>{steps.map((step, index) => <article data-guide-index={index} ref={(node) => { sectionRefs.current[index] = node; }} key={step.id}><div className="guide-sticky"><header><b>{done.has(index) ? '✓' : step.n}</b><strong>{step.title}</strong><span>{step.kind}</span><button onClick={() => toggleDone(index)}>{done.has(index) ? '✓ Complete' : 'Mark complete'}</button></header><section><p>{step.what}</p><aside><b>{step.kind === 'risk' ? 'Risk' : 'Decision'}</b>{step.why}</aside></section></div><div className="guide-file-head"><button onClick={() => onOpenFile(step.file)}><FileCode2 size={13} /><span>{step.file}</span></button><em>+{index === 0 ? 84 : index === 1 ? 42 : 63} −{index === 0 ? 12 : 8}</em></div><div className="guide-diff"><PierreViewer patch={diffPatch} filePath={step.file} plain={false} onThread={() => undefined} /></div></article>)}</main></div>;
}
type JournalEntryId = 'verify' | 'evidence' | 'design' | 'placement' | 'discover';
function JournalSurface() {
  const entries = useMemo(() => [
    { id: 'verify' as const, kind: 'narrative', phase: 'Verify', at: 'Today · 14:10', title: 'Verification opened', body: 'Prove the unified Inspector survives movement and keeps comments anchored.', outcome: 'In progress. Pierre integration is complete; movement proof is still owed.', decisions: ['Use one file tab with Current and Git diff modes', 'Review evidence inline before opening artifact tabs'], advanced: ['artifact-viewer', 'review-threads'], artifacts: ['portable-move.report.json'] },
    { id: 'evidence' as const, kind: 'artifact', phase: 'Verify', at: 'Today · 14:04', title: 'Move report attached', body: 'portable-move.report.json matched to the portability requirement.', outcome: 'Generation fence and Git restoration passed; the thread-anchor command remains red.', decisions: ['Keep the failed command visible beside accepted checks'], advanced: ['portable-state'], artifacts: ['portable-move.report.json'] },
    { id: 'design' as const, kind: 'narrative', phase: 'Design', at: 'Today · 13:42', title: 'Design phase ended', body: 'Place files, artifacts, Goal, Workflow, Rubric, Guide, and Journal in one understandable Inspector.', outcome: 'Approved permanent source surfaces plus independent document tabs.', decisions: ['Remove Browser from this Inspector', 'Use React Flow for typed workflow dataflow'], advanced: ['inspector-hierarchy', 'workflow-clarity'], artifacts: ['inspector-spec.json', 'browser-relay.jpg'] },
    { id: 'placement' as const, kind: 'decision', phase: 'Design', at: 'Today · 12:56', title: 'Inspector placement accepted', body: 'Summary joins Goal; Changes joins Files behind an All / Changed filter.', outcome: 'The permanent tab row is smaller without hiding either source model.', decisions: ['Goal owns workspace orientation', 'Files owns repository and changed-file browsing'], advanced: ['inspector-hierarchy'], artifacts: ['inspector-spec.json'] },
    { id: 'discover' as const, kind: 'narrative', phase: 'Discover', at: 'Today · 11:18', title: 'Discovery phase ended', body: 'Recover useful 0.x product flows and inspect Gooey Pi and Codex references.', outcome: 'Mapped Pierre review surfaces, local artifacts, workflow gates, guide scrolling, and journal joins.', decisions: ['Port proven backing models instead of partial rewrites'], advanced: ['product-archaeology'], artifacts: ['evidence-board.json'] },
  ], []);
  const [filter, setFilter] = useState<'all' | 'narrative' | 'decision' | 'artifact'>('all');
  const visible = entries.filter((entry) => filter === 'all' || entry.kind === filter);
  const [entry, setEntry] = useState<JournalEntryId>('verify');
  const selected = visible.find((item) => item.id === entry) ?? visible[0] ?? entries[0]!;
  let lastPhase = '';
  return <div className="journal-surface"><header><span>Space Journal</span><h2>Phase narrative and system state</h2><p>Newest first. The event list scrolls with the page while the selected entry stays pinned beside it.</p></header><div className="journal-filters">{([['all','All'],['narrative','Narrative'],['decision','Decisions'],['artifact','Artifacts']] as const).map(([id,label]) => <button data-active={filter === id || undefined} onClick={() => setFilter(id)} key={id}>{label}</button>)}<span>{visible.length} of {entries.length} entries</span></div><div className="journal-scroll"><div className="journal-timeline-grid"><nav>{visible.map((item) => { const divider = item.phase !== lastPhase; lastPhase = item.phase; return <div className="journal-event-wrap" key={item.id}>{divider ? <div className="journal-phase-divider"><i /><span>⧗ {item.phase}</span><i /></div> : null}<button data-active={selected.id === item.id || undefined} data-kind={item.kind} onClick={() => setEntry(item.id)}><small>{item.at} · {item.kind}</small><strong>{item.title}</strong><span>{item.body}</span></button></div>; })}</nav><main><header><span>⧗ {selected.phase}</span><em>{selected.at}</em><h3>{selected.title}</h3><p>{selected.outcome}</p></header><section><h4>Decisions</h4>{selected.decisions.map((decision) => <div className="journal-decision" key={decision}><Check size={13} /><span>{decision}</span></div>)}</section><section><h4>State delta</h4><div className="journal-delta"><div><span>Requirements advanced</span>{selected.advanced.map((item) => <code key={item}>+ {item}</code>)}</div><div><span>Artifacts attached</span>{selected.artifacts.map((item) => <code key={item}>◇ {item}</code>)}</div></div></section><footer><span>Snapshot generation 7 · code 41b7c2 · agent session retained</span><button>Open snapshot</button></footer></main></div></div></div>;
}
function ArtifactDocument({ artifact, view, onThread }: { artifact: (typeof artifacts)[number]; view: 'preview' | 'source'; onThread: (line: number) => void }) {
  const report = { version: 1, title: 'Portable move verification', status: 'passed', checks: [{ name: 'Generation fence', status: 'passed' }, { name: 'Git state restored', status: 'passed' }, { name: 'Main agent continued', status: 'passed' }] };
  const source = artifact.id === 'report' ? JSON.stringify(report, null, 2) : '<svg viewBox="0 0 800 420">\n  <title>Portable space model</title>\n  <g id="space-authority">…</g>\n</svg>';
  if (artifact.id === 'screenshot') return <div className="artifact-image artifact-image-full"><img src="http://127.0.0.1:4317/gitspace-worksheet-refs/gooey-browser.jpg" alt="Browser Relay artifact preview" /></div>;
  if (view === 'source') return <PierreViewer patch={currentFilePatch(artifact.url, source)} filePath={artifact.url} plain onThread={onThread} />;
  return artifact.id === 'report' ? <div className="artifact-preview"><div className="report-preview"><header><span>Verification report</span><h2>{report.title}</h2><em>Passed</em></header>{report.checks.map((check) => <div key={check.name}><Check size={14} /><strong>{check.name}</strong><span>{check.status}</span></div>)}</div></div> : <div className="artifact-preview"><div className="diagram-preview"><div><strong>Space authority</strong><small>generation 7</small></div><i>→</i><div><strong>Artifact scope</strong><small>local://base</small></div><i>→</i><div><strong>Viewer tab</strong><small>Preview / Source</small></div></div></div>;
}
function ThreadPanel({ target, messages, onSend, onClose }: { target: string; messages: ThreadMessage[]; onSend: (body: string) => void; onClose: () => void }) { const [draft, setDraft] = useState(''); return <section className="thread-panel"><header><strong>Review thread</strong><span>{target}</span><button className="mini-button" onClick={onClose}>Close</button></header>{messages.map((message, index) => <div className="thread-message" key={`${message.author}-${index}`}><span className="thread-avatar">{message.initials}</span><div><strong>{message.author}</strong><small>{message.at}</small><p>{message.body}</p></div></div>)}<div className="thread-compose"><input aria-label="Reply to review thread" value={draft} onChange={(event) => setDraft(event.currentTarget.value)} placeholder="Reply—the workspace agent sees this thread" /><button className="mini-button" data-active onClick={() => { if (!draft.trim()) return; onSend(draft.trim()); setDraft(''); }}>Reply</button></div></section>; }
function Workbench({ terminalRequest }: { terminalRequest: { id: string; nonce: number } | null }) {
  const firstFile: OpenDocument = { id: `file:${changes[0]!.path}`, kind: 'file', label: 'WorkspaceInspector.tsx', target: changes[0]!.path };
  const [view, setView] = useState<View>('goal');
  const [documents, setDocuments] = useState<OpenDocument[]>([firstFile]);
  const [formattedFiles, setFormattedFiles] = useState<Set<string>>(() => new Set());
  const [activeDocumentId, setActiveDocumentId] = useState<string | null>(null);
  const [fileModes, setFileModes] = useState<Record<string, FileMode>>({ [firstFile.id]: 'working' });
  const [fileFilter, setFileFilter] = useState<'all' | 'changed'>('all');
  const [threadOpen, setThreadOpen] = useState(false);
  const [artifactViews, setArtifactViews] = useState<Record<ArtifactId, 'preview' | 'source'>>({ report: 'preview', screenshot: 'preview', architecture: 'preview' });
  const [threadTarget, setThreadTarget] = useState('WorkspaceInspector.tsx · lines 47–49');
  const [messages, setMessages] = useState<ThreadMessage[]>([{ author: 'Reviewer', initials: 'BR', at: '10:42', body: 'Should this viewer preserve open tabs and comments after a placement change?' }, { author: 'Workspace agent', initials: 'A', at: '10:44', body: 'Yes. Tabs retain stable target IDs; file bytes re-read against the new generation, and threads stay anchored to blob identity.' }]);
  useEffect(() => { if (terminalRequest) { setView('terminals'); setActiveDocumentId(null); setThreadOpen(false); } }, [terminalRequest]);
  const activeDocument = documents.find((document) => document.id === activeDocumentId) ?? null;
  const activeFileMode = activeDocument?.kind === 'file' ? fileModes[activeDocument.id] ?? 'current' : null;
  const activeArtifact = activeDocument?.kind === 'artifact' ? artifacts.find((item) => item.id === activeDocument.target) ?? artifacts[0]! : artifacts[0]!;
  const activeArtifactView = artifactViews[activeArtifact.id];
  const openDocument = (document: OpenDocument): void => {
    setDocuments((current) => current.some((item) => item.id === document.id) ? current : [...current, document]);
    setActiveDocumentId(document.id);
    setView('document');
    setThreadOpen(false);
  };
  const openFileDocument = (path: string, mode: FileMode): void => {
    const id = `file:${path}`;
    setFileModes((current) => ({ ...current, [id]: mode }));
    openDocument({ id, kind: 'file', label: path.split('/').at(-1) ?? path, target: path });
  };
  const closeDocument = (id: string): void => {
    setDocuments((current) => {
      const next = current.filter((document) => document.id !== id);
      if (activeDocumentId === id) setActiveDocumentId(next.at(-1)?.id ?? null);
      return next;
    });
    setThreadOpen(false);
  };
  const openFileThread = (line: number): void => {
    const path = activeDocument?.target ?? changes[0]!.path;
    setThreadTarget(`${path.split('/').at(-1)} · line ${line}`);
    setThreadOpen(true);
  };
  const addReply = (body: string): void => setMessages((current) => [...current, { author: 'You', initials: 'Y', at: 'now', body }]);
  const selectSurface = (next: View): void => { setView(next); setActiveDocumentId(null); setThreadOpen(false); };
  const openEvidence = (id: ArtifactId): void => { const item = artifacts.find((artifact) => artifact.id === id)!; openDocument({ id: `artifact:${item.id}`, kind: 'artifact', label: item.name, target: item.id }); };
  const documentViewer = activeDocument ? <main className="viewer-main">
    <header className="document-header"><div><strong>{activeDocument.kind === 'artifact' ? activeArtifact.url : activeDocument.kind === 'diff' || activeDocument.kind === 'file' ? activeDocument.target : activeDocument.label}</strong><small>{activeDocument.kind === 'diff' ? 'Git diff · working tree against develop' : activeDocument.kind === 'file' ? 'Repository file · current content · blob 41b7c2' : activeDocument.kind === 'artifact' ? 'Artifact generation 4 · sha256:91ad…' : activeDocument.kind === 'goal' ? 'Goal document · revision 8' : activeDocument.kind === 'workflow' ? 'Optional workflow · run 07' : 'Optional rubric · 3 criteria'}</small></div><div className="document-actions"><button className="mini-button" onClick={() => { if (activeDocument.kind === 'artifact') setThreadTarget(activeArtifact.url); else if (activeDocument.kind === 'diff' || activeDocument.kind === 'file') { openFileThread(activeDocument.kind === 'diff' ? 6 : 7); return; } else setThreadTarget(`${activeDocument.label} · document`); setThreadOpen(true); }}><MessageSquare size={12} />Comment</button>{activeDocument.kind === 'diff' ? <button className="mini-button" onClick={() => openFileDocument(activeDocument.target, 'current')}>Open current</button> : activeDocument.kind === 'artifact' ? <button className="mini-button">Download</button> : null}</div></header>
    {activeDocument.kind === 'file' ? <div className="file-mode-bar"><span>View</span>{([['current','Current'],['working','Working diff'],['staged','Staged diff'],['base','vs base']] as const).map(([mode,label]) => <button data-active={activeFileMode === mode || undefined} onClick={() => setFileModes((current) => ({ ...current, [activeDocument.id]: mode }))} key={mode}>{label}</button>)}<i /><button className="format-button" onClick={() => setFormattedFiles((current) => new Set(current).add(activeDocument.id))}>{formattedFiles.has(activeDocument.id) ? <><Check size={12} />Formatted</> : 'Format'}</button></div> : null}
    {activeDocument.kind === 'artifact' && activeArtifact.id !== 'screenshot' ? <div className="file-mode-bar"><span>View</span>{(['preview','source'] as const).map((mode) => <button data-active={activeArtifactView === mode || undefined} onClick={() => setArtifactViews((current) => ({ ...current, [activeArtifact.id]: mode }))} key={mode}>{mode === 'preview' ? 'Preview' : 'Source'}</button>)}</div> : null}
    {activeDocument.kind === 'diff' ? <PierreViewer patch={diffPatch} filePath={activeDocument.target} plain={false} onThread={openFileThread} /> : activeDocument.kind === 'file' ? <PierreViewer patch={activeFileMode === 'current' ? currentFilePatch(activeDocument.target) : diffPatch} filePath={activeDocument.target} plain={activeFileMode === 'current'} onThread={openFileThread} /> : activeDocument.kind === 'artifact' ? <ArtifactDocument artifact={activeArtifact} view={activeArtifactView} onThread={openFileThread} /> : <ProductDocument kind={activeDocument.kind} onOpenEvidence={openEvidence} />}
    {threadOpen ? <ThreadPanel target={threadTarget} messages={messages} onClose={() => setThreadOpen(false)} onSend={addReply} /> : null}
  </main> : <div className="viewer-empty"><FileText size={22} /><strong>{view === 'files' ? 'Open a repository file' : 'Open an artifact'}</strong><span>Items open as tabs and stay attached to this Inspector.</span></div>;
  return <aside className="workbench-panel">
    <nav className="workbench-tabs">{([['goal','Goal'],['subagents','Subagents'],['files','Files'],['artifacts','Artifacts'],['services','Services'],['terminals','Terminals'],['guide','Change Guide'],['journal','Journal']] as const).map(([id,label]) => <button className="workbench-tab" data-active={view === id || undefined} onClick={() => selectSurface(id)} key={id}>{label}{id === 'subagents' ? <span>2</span> : id === 'files' ? <span>4</span> : id === 'artifacts' ? <span>3</span> : id === 'services' ? <span>3</span> : id === 'terminals' ? <span>4</span> : null}</button>)}<span className="workbench-spacer" /><button className="workbench-close" aria-label="Close Inspector"><PanelRightClose size={16} /></button></nav>
    {documents.length ? <div className="open-document-strip"><span>Open</span>{documents.map((document) => <button className="open-document-tab" data-active={activeDocumentId === document.id || undefined} key={document.id} onClick={() => { setActiveDocumentId(document.id); setView('document'); setThreadOpen(false); }}>{document.kind === 'artifact' ? <FileJson2 size={11} /> : <FileCode2 size={11} />}<strong>{document.label}</strong><i onClick={(event) => { event.stopPropagation(); closeDocument(document.id); }}>×</i></button>)}</div> : null}
    <div className="workbench-body">{view === 'document' ? documentViewer : view === 'subagents' ? <div className="surface-list"><header><strong>Subagents</strong><span>2</span></header><article><span className="thread-avatar">SC</span><div><strong>Source audit</strong><small>scout · completed</small><p>Mapped file, artifact, and diff call sites.</p></div><em>Done</em></article><article><span className="thread-avatar">RV</span><div><strong>Review backing</strong><small>reviewer · running</small><p>Checking shared thread anchors and movement behavior.</p></div><em>Running</em></article></div> : view === 'goal' ? <GoalSurface onOpen={openDocument} openTabs={documents.length} /> : view === 'services' ? <ServicesSurface /> : view === 'terminals' ? <TerminalsSurface requestedId={terminalRequest?.id ?? null} /> : view === 'guide' ? <ChangeGuideSurface onOpenFile={(path) => openFileDocument(path, 'working')} /> : view === 'journal' ? <JournalSurface /> : view === 'files' ? <><header className="workbench-toolbar"><div><strong>Files</strong><small>Workspace repository · generation 7</small></div><label className="viewer-search"><Search size={12} /><input placeholder="Filter paths" /></label></header><div className="viewer-layout"><aside className="viewer-sidebar"><div className="file-tree-filter"><button data-active={fileFilter === 'all' || undefined} onClick={() => setFileFilter('all')}>All</button><button data-active={fileFilter === 'changed' || undefined} onClick={() => setFileFilter('changed')}>Changed <span>4</span></button></div><div className="viewer-sidebar-header"><span>{fileFilter === 'changed' ? 'Changed files' : 'Repository'}</span><em>{fileFilter === 'changed' ? '+280 −40' : 'develop'}</em></div><PierreRepoTree changedOnly={fileFilter === 'changed'} onOpen={(path) => openFileDocument(path, fileFilter === 'changed' ? 'working' : 'current')} /></aside>{documentViewer}</div></> : <><header className="workbench-toolbar"><div><strong>Artifacts</strong><small>Resolved through local://</small></div><button className="mini-button"><Plus size={12} />Publish</button></header><div className="viewer-layout"><aside className="viewer-sidebar"><div className="viewer-sidebar-header"><span>Durable outputs</span><em>3</em></div><div className="source-list">{artifacts.map((item) => <button className="source-row" data-active={activeDocument?.target === item.id || undefined} onClick={() => openDocument({ id: `artifact:${item.id}`, kind: 'artifact', label: item.name, target: item.id })} key={item.id}>{item.type === 'Image' ? <Image size={14} /> : item.type === 'JSON' ? <FileJson2 size={14} /> : <File size={14} />}<span><strong>{item.name}</strong><small>{item.url}</small></span><em>{item.size}</em></button>)}</div></aside>{documentViewer}</div></>}</div>
  </aside>;
}
function Preview() {
  const [projectCrons, setProjectCrons] = useState(false);
  const [terminalRequest, setTerminalRequest] = useState<{ id: string; nonce: number } | null>(null);
  const openTerminal = (id: string): void => setTerminalRequest((current) => ({ id, nonce: (current?.nonce ?? 0) + 1 }));
  return <div className="gitspace-shell workbench-shell" data-context-open={!projectCrons || undefined}><LeftPanel projectCronsActive={projectCrons} onOpenProjectCrons={() => setProjectCrons(true)} onOpenWorkspace={() => setProjectCrons(false)} /><div className="app-main-region">{projectCrons ? <ProjectCronsPage /> : <div className="workspace-workbench"><div className="workspace-content"><Conversation onOpenTerminal={openTerminal} /><Workbench terminalRequest={terminalRequest} /></div></div>}</div></div>;
}
const root = document.getElementById('root'); if (!root) throw new Error('Missing root'); createRoot(root).render(<Preview />);