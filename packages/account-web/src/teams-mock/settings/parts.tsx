// The settings pages' building blocks, drawn as the real SettingsPage draws them (outlined, separated CardGroup rows with
// the control in the trailing footer; titled groups), plus the team pieces: user avatars, scope badges, and actions a
// viewer may not take, which stay visible, dimmed, and say why on hover and on click.
import { Badge, Button, Card, CardDescription, CardFooter, CardGroup, CardHeader, CardMedia, CardTitle, Tooltip, type IconComponent } from '@gitspace/ui';
import type { ComponentProps, ReactNode } from 'react';
import { actorLabel, findPrincipal, visibleProjects, WORKSPACES } from '../data.js';
import { useMock } from '../viewer.js';

/** The open workspaces `userId` holds the handle of right now (the shell's live holders), in the projects the viewer is
 * in: a workspace in a project the viewer isn't in never shows. */
export function useHeld(): (userId: string) => readonly string[] {
  const { state } = useMock();
  const seen = visibleProjects(state.viewer);
  return (userId) => WORKSPACES.filter((workspace) => !workspace.archived && seen.has(workspace.projectId) && (state.holders[workspace.id] ?? workspace.holders).includes(userId)).map((workspace) => workspace.id);
}

export function SettingRows({ children, label }: { children: ReactNode; label?: string }) {
  return <CardGroup orientation="inline" border="outlined" separated proximityHover={false} aria-label={label}>{children}</CardGroup>;
}
/** A row: its text takes the room it needs (at least 16rem) and its controls sit at the right; when the row is too
 * narrow for both, the controls wrap under the text, right-aligned, so nothing overlaps. */
export function SettingRow({ title, description, media, extra, children, index }: { title: ReactNode; description?: ReactNode; media?: IconComponent; extra?: ReactNode; children?: ReactNode; index?: number }) {
  return <Card size="compact" index={index} className="flex-wrap gap-y-0">
    {media ? <CardMedia icon={media} /> : null}
    <CardHeader className="min-w-0 basis-64 grow break-words [overflow-wrap:anywhere]"><CardTitle>{title}</CardTitle>{description ? <CardDescription>{description}</CardDescription> : null}{extra}</CardHeader>
    {children ? <CardFooter className="flex-wrap justify-end gap-2 py-1.5">{children}</CardFooter> : null}
  </Card>;
}

/** A titled section; `scope` marks whose it is (Team, a project, Mine) and `readOnly` explains why its actions are off. */
export function Section({ title, description, scope, readOnly, actions, children }: { title: ReactNode; description?: ReactNode; scope?: 'Team' | 'Project' | 'You'; readOnly?: string | null; actions?: ReactNode; children: ReactNode }) {
  return <section className="flex flex-col gap-3">
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-1">
        <h2 className="flex items-center gap-2 text-subtitle font-semibold text-foreground">{title}{scope ? <Badge size="compact" color={scope === 'You' ? 'violet' : scope === 'Project' ? 'teal' : 'gray'}>{scope}</Badge> : null}{readOnly ? <Tooltip content={readOnly}><span><Badge size="compact" color="amber">Read only</Badge></span></Tooltip> : null}</h2>
        {description ? <p className="max-w-3xl text-caption text-muted-foreground [text-wrap:pretty]">{description}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
    {children}
  </section>;
}

/** A person's round avatar, or a bot's square one. */
export function Avatar({ userId, size = 22 }: { userId: string; size?: number }) {
  const principal = findPrincipal(userId);
  return <span aria-hidden title={principal?.name} className={`inline-flex shrink-0 items-center justify-center font-semibold text-white ${principal?.kind === 'bot' ? 'rounded-[28%]' : 'rounded-full'}`} style={{ width: size, height: size, fontSize: size * 0.42, background: principal?.color ?? '#888' }}>{principal?.initials ?? '?'}</span>;
}
/** A person's full name, or a bot's name with its sponsor ("Release bot (sponsored by Theo)"); `client` names the
 * person's MCP client that acted for them ("Maya Okafor via Claude Code"). */
export function UserName({ userId, you, client }: { userId: string; you?: string; client?: string }) {
  const principal = findPrincipal(userId);
  const label = !principal ? userId : principal.kind === 'bot' ? actorLabel(userId, client) : `${principal.name}${client ? ` via ${client}` : ''}`;
  return <span className="inline-flex items-center gap-1.5"><Avatar userId={userId} size={18} /><span>{label}{you === userId ? ' (you)' : ''}</span></span>;
}

/** A button the viewer may be refused: with a reason it stays visible but dimmed, its tooltip says why, and pressing it
 * says so too (the app's toast). */
export function Act({ reason, onClick, children, ...props }: Omit<ComponentProps<typeof Button>, 'onClick'> & { reason: string | null; onClick?(): void }) {
  const { say } = useMock();
  if (!reason) return <Button {...props} onClick={onClick}>{children}</Button>;
  return <Tooltip content={reason}><Button {...props} aria-disabled className={`${props.className ?? ''} opacity-50`} onClick={() => say(reason)}>{children}</Button></Tooltip>;
}

export function Pill({ children, tone = 'gray' }: { children: ReactNode; tone?: 'gray' | 'green' | 'amber' | 'red' | 'blue' | 'violet' | 'teal' }) {
  return <Badge size="compact" color={tone}>{children}</Badge>;
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="max-w-3xl text-caption text-muted-foreground [text-wrap:pretty]">{children}</p>;
}
