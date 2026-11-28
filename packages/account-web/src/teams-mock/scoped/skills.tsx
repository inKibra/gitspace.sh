// Skills settings, by placement: Crumb & Co › Skills lists the team's (switched on per project), You › Skills yours
// (they travel with you into workspaces you hold), Bot › Skills a bot's (managed by its sponsor, Owners and Admins).
// Someone else's (People › person) shows theirs; skills aren't among what an Owner or Admin revokes, so it's view only.
// New skill and Edit open their dialogs from `flows/resources.tsx`.
import { glyph } from '../../glyph.js';
import { BookOpen01, Plus } from '@untitledui/icons';
import { useState } from 'react';
import { EditSkillFlow, SkillFlow } from '../flows/resources.js';
import { skills } from '../flows/resources-data.js';
import type { Skill } from '../settings/data.js';
import { Act, Note, Pill, Section, SettingRow, SettingRows } from '../settings/parts.js';
import { revokeOnly, type ScopeInfo } from '../scope.js';
import { useViewer } from '../viewer.js';
import { listNames, pluginReach } from './common.js';

export function SkillsSettings({ info }: { info: ScopeInfo }) {
  const viewer = useViewer();
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<Skill | null>(null);
  const team = info.access === 'team-edit' || info.access === 'team-read';
  const edit = info.access === 'team-read' ? info.teamReason : null;
  const person = info.target;
  const bot = person?.kind === 'bot' ? person : null;
  const list = skills.use().filter((skill) => team ? skill.owner.scope === 'account' : skill.owner.scope === 'user' && skill.owner.userId === person?.id);
  const reach = person ? pluginReach(person.id) : null;
  const viewOnly = info.access === 'revoke' ? `Skills aren’t something an Owner or Admin revokes: view only` : null;
  return <Section title={team ? 'Team skills' : info.access === 'own' ? 'My skills' : `${person?.first}’s skills`} scope={team ? 'Team' : 'You'} readOnly={edit ?? viewOnly}
    description={team ? 'Each is on in the projects listed; a project’s settings can turn more on.' : bot ? `${bot.name}’s own: its agents load them in workspaces it holds${reach?.on.length ? `, in ${listNames(reach.on)}` : ''}. The team’s skills apply to it as to anyone.` : `${info.access === 'own' ? 'Yours' : 'Theirs'}: used in workspaces ${info.access === 'own' ? 'you hold' : `${person?.first} holds`}${reach?.on.length ? `, in ${listNames(reach.on)}` : ''}.`}
    actions={<Act reason={team ? edit : revokeOnly(info, viewer)} variant="secondary" leadingIcon={glyph(Plus)} onClick={() => setAdding(true)}>New skill</Act>}>
    {list.length ? <SettingRows label="Skills">{list.map((skill) => <SettingRow key={skill.id} media={glyph(BookOpen01)} title={<span className="font-mono" data-skill={skill.id}>{skill.name}</span>}
      description={<>{skill.description} · updated {skill.updated}</>} extra={skill.projects ? <span className="mt-1 text-caption text-foreground">On in {listNames(skill.projects) || 'no project'}</span> : undefined}>
      {skill.projects ? <Pill tone="teal">Team</Pill> : <Pill tone="violet">Personal</Pill>}
      <Act reason={team ? edit : info.access === 'own' || bot ? null : viewOnly} variant="ghost" aria-label={`Edit ${skill.name}`} onClick={() => setEditing(skill)}>Edit</Act>
    </SettingRow>)}</SettingRows> : <Note>{bot ? `${bot.name} has no skills of its own.` : 'No skills here.'}</Note>}
    {adding ? <SkillFlow team={team} principal={bot ?? undefined} onClose={() => setAdding(false)} /> : null}
    {editing ? <EditSkillFlow skill={editing} onClose={() => setEditing(null)} /> : null}
  </Section>;
}
