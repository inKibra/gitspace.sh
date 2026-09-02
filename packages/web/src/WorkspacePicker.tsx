import { Badge, Card, CardContent, CardDescription, CardGroup, CardHeader, CardTitle, InputField, InputGroup } from '@gitspace/ui';
import { SearchMd } from '@untitledui/icons';
import { useState, type ReactNode } from 'react';
import { PHASE_LABEL, StatusDot, type WorkspaceView } from './GitSpaceShell.js';
import { glyph } from './glyph.js';

export interface WorkspacePickerProps {
  workspaces: readonly WorkspaceView[];
  /** Ids never offered (the workspace itself, anything already picked). */
  exclude?: readonly string[];
  /** Ids rendered as selected; used by multi-pickers that keep the picked rows in the list. */
  selected?: readonly string[];
  onPick(workspaceId: string): void;
  placeholder?: string;
  /** Accessible name of the filter input; also distinguishes several pickers on one page. */
  label?: string;
  /** Rows shown before the user narrows the list. */
  limit?: number;
  empty?: ReactNode;
}

const SearchGlyph = glyph(SearchMd);

/**
 * Searchable workspace list: a filter field over compact cards. Composed from Fluid parts because
 * the registry has no Combobox (FLUID-GAP); matches on name, branch, and phase.
 */
export function WorkspacePicker({ workspaces, exclude = [], selected = [], onPick, placeholder = 'Search workspaces', label = 'Search workspaces', limit = 8, empty = 'No workspaces match.' }: WorkspacePickerProps) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const matches = workspaces
    .filter((workspace) => !exclude.includes(workspace.id) && (!needle || `${workspace.name} ${workspace.branch} ${workspace.phase} ${PHASE_LABEL[workspace.phase]}`.toLowerCase().includes(needle)))
    .slice(0, limit);
  return <div className="flex flex-col gap-2">
    <InputGroup size="compact">
      <InputField index={0} label={label} labelHidden placeholder={placeholder} icon={SearchGlyph} value={query} onChange={setQuery} />
    </InputGroup>
    {matches.length
      ? <CardGroup orientation="inline" border="outlined" separated proximityHover={false}>
        {matches.map((workspace, index) => <Card key={workspace.id} index={index} size="compact" selected={selected.includes(workspace.id)} onClick={() => onPick(workspace.id)} label={`Pick ${workspace.name}`}>
          <CardHeader>
            <CardTitle><span className="flex items-center gap-2"><StatusDot color={workspace.status.primaryColor} pulse={workspace.status.primaryColor === 'green'} />{workspace.name}</span></CardTitle>
            <CardDescription><span className="font-mono">{workspace.branch}</span></CardDescription>
          </CardHeader>
          <CardContent><Badge variant="dot" size="compact" color="gray">{PHASE_LABEL[workspace.phase]}</Badge></CardContent>
        </Card>)}
      </CardGroup>
      : <p className="text-caption text-muted-foreground">{empty}</p>}
  </div>;
}
