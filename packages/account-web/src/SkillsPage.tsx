import type { SkillScope, SkillView } from '@gitspace/protocol/skills-contract';
import {
  Badge,
  Button,
  Card,
  CardDescription,
  CardFooter,
  CardGroup,
  CardHeader,
  CardMedia,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  InputField,
  InputGroup,
  Switch,
} from '@gitspace/ui';
import { BookOpen01, SearchMd, Stars01 } from '@untitledui/icons';
import { useMemo, useState } from 'react';
import { glyph } from './glyph.js';
import { EmptyState, PageCanvas, PageHeader } from './GitSpaceShell.js';
import { ProjectAssignmentMatrix } from './ProjectAssignmentMatrix.js';

export interface SkillsPageProps {
  projectId: string;
  projectName: string;
  projects: readonly { id: string; name: string }[];
  skills: readonly SkillView[];
  loading?: boolean;
  error?: string | null;
  update(skill: SkillView, changes: { enabled: boolean; scope: SkillScope; exceptions: string[]; assignments: SkillView['assignments'] }): Promise<SkillView>;
}

const SCOPE_LABEL: Record<SkillScope, string> = { project: 'Project agent', workspaces: 'Workspace agents', all: 'All agents' };
const SearchGlyph = glyph(SearchMd);
const SkillGlyph = glyph(Stars01);

export function SkillsPage(props: SkillsPageProps) {
  const [query, setQuery] = useState('');
  const [records, setRecords] = useState<SkillView[]>([...props.skills]);
  const [saving, setSaving] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const visible = useMemo(() => records.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.trim().toLowerCase())), [query, records]);
  const expandedSkill = expanded === null ? null : records.find((skill) => skill.id === expanded) ?? null;
  const save = async (skill: SkillView, changes: Partial<Pick<SkillView, 'enabled' | 'scope' | 'exceptions' | 'assignments'>>): Promise<void> => {
    setSaving(skill.id);
    setActionError(null);
    try {
      const updated = await props.update(skill, { enabled: changes.enabled ?? skill.enabled, scope: changes.scope ?? skill.scope, exceptions: changes.exceptions ?? skill.exceptions, assignments: changes.assignments ?? skill.assignments });
      setRecords((current) => current.map((candidate) => candidate.id === updated.id ? updated : candidate));
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(null);
    }
  };
  const error = actionError ?? props.error;
  return <PageCanvas>
    <PageHeader
      kicker={`GitSpace project · ${props.projectName}`}
      title="Skills"
      description="Choose the GitSpace operating knowledge available to the project agent and its workspace agents."
    />

    <div className="flex items-center gap-3 pb-4">
      <InputGroup className="w-full max-w-sm"><InputField index={0} label="Filter skills" labelHidden icon={SearchGlyph} placeholder="Search skills" value={query} onChange={setQuery} /></InputGroup>
      <span className="ml-auto text-caption tabular-nums text-muted-foreground">{visible.length} of {records.length}</span>
    </div>

    {props.loading
      ? <EmptyState title="Loading skills…" />
      : visible.length
        ? <CardGroup orientation="inline" border="outlined" separated>
          {visible.map((skill) => <Card size="compact" key={skill.id}>
            <CardMedia icon={SkillGlyph} />
            <CardHeader>
              <CardTitle>{skill.name}</CardTitle>
              <CardDescription>{skill.description}</CardDescription>
              <span className="text-caption tabular-nums text-muted-foreground">revision {skill.revision}{skill.exceptions.length ? ` · ${skill.exceptions.length} project exceptions` : ''}</span>
            </CardHeader>
            <CardFooter className="gap-2">
              <Badge variant="dot" color="gray">{skill.source === 'gitspace' ? 'GitSpace' : 'User'}</Badge>
              <Badge color={skill.assignments.length ? 'blue' : 'gray'}>{SCOPE_LABEL[skill.scope]}{skill.assignments.length ? ` · ${skill.assignments.length} custom` : ''}</Badge>
              <Button variant="ghost" onClick={() => setExpanded(skill.id)}>Manage access</Button>
              <Switch checked={skill.enabled} label={skill.enabled ? 'Enabled' : 'Disabled'} disabled={saving === skill.id} onToggle={() => void save(skill, { enabled: !skill.enabled })} />
            </CardFooter>
          </Card>)}
        </CardGroup>
        : <EmptyState icon={<BookOpen01 width={22} height={22} strokeWidth={1.5} />} title="No matching skills" description="Change the filter to see the installed catalog." />}

    {error ? <p role="alert" className="mt-4 text-body text-destructive">{error}</p> : null}
    <p className="mt-6 text-caption text-muted-foreground">Assignments control discovery, not authorization. Tools and project secrets keep their own capability checks.</p>

    <Dialog open={expandedSkill !== null} onOpenChange={(open) => { if (!open) setExpanded(null); }}>
      {expandedSkill ? <DialogContent size="lg">
        <DialogHeader>
          <DialogTitle>{expandedSkill.name}</DialogTitle>
          <DialogDescription>Default scope: {SCOPE_LABEL[expandedSkill.scope]}. Override which agents in each project discover this skill.</DialogDescription>
        </DialogHeader>
        <ProjectAssignmentMatrix
          projects={props.projects}
          assignments={expandedSkill.assignments}
          defaultProjectSpaceEnabled={expandedSkill.scope === 'project' || expandedSkill.scope === 'all'}
          defaultWorkspacesEnabled={expandedSkill.scope === 'workspaces' || expandedSkill.scope === 'all'}
          disabled={saving === expandedSkill.id}
          onChange={(assignment) => void save(expandedSkill, { assignments: [...expandedSkill.assignments.filter((candidate) => candidate.projectId !== assignment.projectId), assignment] })}
        />
        <DialogFooter><Button variant="secondary" onClick={() => setExpanded(null)}>Done</Button></DialogFooter>
      </DialogContent> : null}
    </Dialog>
  </PageCanvas>;
}
