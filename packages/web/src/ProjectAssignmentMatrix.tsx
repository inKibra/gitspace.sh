import { Switch, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@gitspace/ui';

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
  onChange(assignment: ProjectAssignmentValue): void;
}

export function ProjectAssignmentMatrix({ projects, assignments, defaultProjectSpaceEnabled, defaultWorkspacesEnabled, disabled = false, onChange }: ProjectAssignmentMatrixProps) {
  return <Table>
    <TableHeader>
      <TableRow>
        <TableHead>Project</TableHead>
        <TableHead className="w-36">Project space</TableHead>
        <TableHead className="w-36">Workspaces</TableHead>
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
              <span className="text-caption text-muted-foreground">{assignment ? 'Custom assignment' : 'Inherited default'}</span>
            </div>
          </TableCell>
          <TableCell>
            <Switch checked={value.projectSpaceEnabled} disabled={disabled} label={value.projectSpaceEnabled ? 'On' : 'Off'} onToggle={() => onChange({ ...value, projectSpaceEnabled: !value.projectSpaceEnabled })} />
          </TableCell>
          <TableCell>
            <Switch checked={value.workspacesEnabled} disabled={disabled} label={value.workspacesEnabled ? 'On' : 'Off'} onToggle={() => onChange({ ...value, workspacesEnabled: !value.workspacesEnabled })} />
          </TableCell>
        </TableRow>;
      })}
    </TableBody>
  </Table>;
}
