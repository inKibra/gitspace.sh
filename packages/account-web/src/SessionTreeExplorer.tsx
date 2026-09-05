import { Button, Elevated, InputField, InputGroup, ScrollArea, TabsSubtle, TabsSubtleItem, TabsSubtlePanel, useIcons, useShape } from '@gitspace/ui';
import { XClose } from '@untitledui/icons';
import { useState, type CSSProperties } from 'react';

export interface SessionTreeEntry {
  id: string;
  parentId: string | null;
  role: 'user' | 'assistant';
  preview: string;
  tools: number;
  sequence: number;
  current: boolean;
  onPath: boolean;
}

export interface SessionTreeExplorerProps {
  history: readonly { entryId: string; text: string }[];
  tree: readonly SessionTreeEntry[];
  onNavigate(entryId: string): void;
  onClose(): void;
}

function EntryRow({ entry, depth, onNavigate }: { entry: SessionTreeEntry; depth: number; onNavigate(entryId: string): void }) {
  const icons = useIcons();
  const Dot = entry.onPath ? icons.check : icons.circle;
  return <Button
    variant="ghost"
    size="compact"
    role="treeitem"
    aria-current={entry.current ? 'true' : undefined}
    disabled={entry.current}
    className="w-full justify-start gap-2 text-left"
    style={{ paddingLeft: `${8 + depth * 14}px` } as CSSProperties}
    onClick={() => onNavigate(entry.id)}
  >
    <Dot size={12} strokeWidth={1.5} className="shrink-0 text-muted-foreground" />
    <span className="w-8 shrink-0 tabular-nums text-caption text-muted-foreground">#{entry.sequence}</span>
    <span className="w-12 shrink-0 text-caption text-muted-foreground">{entry.role === 'user' ? 'You' : 'Agent'}</span>
    <span className="min-w-0 truncate">{entry.preview || (entry.tools ? `${entry.tools} tool calls` : '(empty)')}</span>
  </Button>;
}

export function SessionTreeExplorer({ history, tree, onNavigate, onClose }: SessionTreeExplorerProps) {
  const shape = useShape();
  const [tab, setTab] = useState(0);
  const [filter, setFilter] = useState('');
  const parentById: Record<string, string | null> = {};
  for (const entry of tree) parentById[entry.id] = entry.parentId;
  const depthOf = (entry: SessionTreeEntry): number => {
    let depth = 0;
    let parent = entry.parentId;
    while (parent && depth < 20) { depth += 1; parent = parentById[parent] ?? null; }
    return depth;
  };
  const treeRows = [...tree].sort((left, right) => left.sequence - right.sequence);
  const historyRows = history.filter((entry) => entry.text.toLowerCase().includes(filter.trim().toLowerCase()));
  return <Elevated offset={1} className={`${shape.container} flex max-h-[min(60vh,32rem)] flex-col gap-2 p-2`}>
    <div className="flex items-center gap-1">
      <TabsSubtle idPrefix="session-tree" selectedIndex={tab} onSelect={setTab} className="min-w-0 flex-1">
        <TabsSubtleItem index={0} label={`Tree · ${tree.length}`} />
        <TabsSubtleItem index={1} label={`History · ${history.length}`} />
      </TabsSubtle>
      <Button variant="ghost" size="icon-compact" aria-label="Close session history" onClick={onClose}><XClose width={16} height={16} strokeWidth={1.5} /></Button>
    </div>
    <TabsSubtlePanel idPrefix="session-tree" index={0} selectedIndex={tab}>
      <ScrollArea className="max-h-[min(50vh,26rem)]">
        <div role="tree" className="flex flex-col">{treeRows.map((entry) => <EntryRow key={entry.id} entry={entry} depth={depthOf(entry)} onNavigate={onNavigate} />)}</div>
      </ScrollArea>
    </TabsSubtlePanel>
    <TabsSubtlePanel idPrefix="session-tree" index={1} selectedIndex={tab}>
      <div className="flex flex-col gap-2">
        <InputGroup size="compact"><InputField index={0} label="Filter session history" labelHidden value={filter} onChange={setFilter} placeholder="Filter turns…" /></InputGroup>
        <ScrollArea className="max-h-[min(44vh,22rem)]">
          <div role="list" className="flex flex-col">{historyRows.map((entry, index) => <EntryRow key={entry.entryId} entry={{ id: entry.entryId, parentId: null, role: 'user', preview: entry.text, tools: 0, sequence: index + 1, current: index === history.length - 1, onPath: true }} depth={0} onNavigate={onNavigate} />)}</div>
        </ScrollArea>
      </div>
    </TabsSubtlePanel>
  </Elevated>;
}
