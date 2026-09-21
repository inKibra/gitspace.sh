import { Button, Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';

export interface ProjectAssignmentValue {
  projectId: string;
  projectSpaceEnabled: boolean;
  workspacesEnabled: boolean;
}

export interface ProjectAssignmentMatrixProps {
  projects: readonly { id: string; name: string }[];
  assignments: readonly ProjectAssignmentValue[];
  defaultProjectSpaceEnabled: boolean;
  defaultWorkspacesEnabled: boolean;
  disabled?: boolean;
  unassignedLabel?: string;
  resetLabel?: string;
  onReset?(projectId: string): void;
  onChange(assignment: ProjectAssignmentValue): void;
}

export function ProjectAssignmentMatrix({ projects, assignments, defaultProjectSpaceEnabled, defaultWorkspacesEnabled, disabled = false, unassignedLabel = 'Inherited default', resetLabel = 'Use default', onReset, onChange }: ProjectAssignmentMatrixProps) {
  return <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Project</TableHead>
        <TableHead className="w-36">Project space</TableHead>
        <TableHead className="w-36">Workspaces</TableHead>
        {onReset ? <TableHead><span className="sr-only">Assignment actions</span></TableHead> : null}
      </TableRow>
    </TableHeader>
    <TableBody>
      {projects.map((project, index) => {
        const assignment = assignments.find((candidate) => candidate.projectId === project.id);
        const value: ProjectAssignmentValue = assignment ?? { projectId: project.id, projectSpaceEnabled: defaultProjectSpaceEnabled, workspacesEnabled: defaultWorkspacesEnabled };
        return <TableRow index={index} key={project.id}>
          <TableCell>
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-foreground">{project.name}</span>
              <span className="text-caption text-muted-foreground">{assignment ? 'Custom assignment' : unassignedLabel}</span>
            </div>
          </TableCell>
          <TableCell>
            <Switch checked={value.projectSpaceEnabled} disabled={disabled} label={value.projectSpaceEnabled ? 'On' : 'Off'} onToggle={() => onChange({ ...value, projectSpaceEnabled: !value.projectSpaceEnabled })} />
          </TableCell>
          <TableCell>
            <Switch checked={value.workspacesEnabled} disabled={disabled} label={value.workspacesEnabled ? 'On' : 'Off'} onToggle={() => onChange({ ...value, workspacesEnabled: !value.workspacesEnabled })} />
          </TableCell>
          {onReset ? <TableCell>{assignment ? <Button variant="ghost" disabled={disabled} onClick={() => onReset(project.id)}>{resetLabel}</Button> : null}</TableCell> : null}
        </TableRow>;
      })}
    </TableBody>
  </Table>;
}
