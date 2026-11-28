// The approved-script libraries: Crumb & Co › Approved scripts (the team's, with the project and personal ones the
// viewer can see behind a filter), a project's own list (its settings' Approved scripts section) and a principal's
// approved scripts (You › My approved scripts, or a bot's own page): their "For me" scripts and what waits on them.
// Edits are new versions; editing while a version waits replaces it. Each row opens the script's detail.
import { useState } from 'react';
import { PROJECTS, principalOf, visibleProjects } from '../data.js';
import { approvedScripts } from '../flows/env-model.js';
import { ChipPicker } from '../flows/kit.js';
import { ScriptRows } from '../flows/scripts.js';
import { canSee, pendingRecipients, projectLabel, scriptProject } from '../flows/scripts-rules.js';
import { holdersOf } from '../model.js';
import { useMock, useViewer } from '../viewer.js';
import { ACCOUNT_NAME } from './data.js';
import { Note, Section } from './parts.js';
import { whyAccount } from './roles.js';

const HOW = 'An agent submits a script with its content, the secrets it needs by name, typed inputs, what it asks people while it runs, allowed network destinations and the machine profile it needs; the approval covers the content’s hash. Agents run it by name in their working copy; secrets go only into that process, answers to its prompts go straight into its input, and output is redacted. An edit is a new version that needs approval; editing while one waits replaces it. Approving a new version offers to revoke the old one.';

export function TeamScriptsPage() {
  const viewer = useViewer();
  const live = approvedScripts.use();
  const seen = visibleProjects(viewer.id);
  const filters = [...PROJECTS.filter((project) => seen.has(project.id) && !project.archived).map((project) => ({ id: project.id, label: projectLabel(project.id) })), { id: 'mine', label: 'Mine (For me)' }];
  const [also, setAlso] = useState<ReadonlySet<string>>(new Set());
  const visible = live.filter((script) => canSee(viewer.id, script));
  const team = visible.filter((script) => script.scope.kind === 'team');
  const more = visible.filter((script) => (script.scope.kind === 'project' && also.has(script.scope.projectId)) || (script.scope.kind === 'me' && also.has('mine')));
  return <>
    <Section title="Team scripts" scope="Team" readOnly={whyAccount(viewer.id, 'account.credentials')} description={`Approved for every project in ${ACCOUNT_NAME} by an Owner or Admin. ${HOW}`}>
      {team.length ? <ScriptRows scripts={team} label="Team scripts" /> : <Note>No team scripts yet.</Note>}
    </Section>
    <Section title="Also show" description="Project scripts in the projects you’re in, and your own. Each project’s list is also in its settings.">
      <ChipPicker label="Also show" options={filters} picked={also} onChange={setAlso} />
      {more.length ? <ScriptRows scripts={more} label="Project and personal scripts" /> : <Note>Pick a project or Mine to list its scripts here.</Note>}
    </Section>
  </>;
}

export function ProjectScriptsSection({ project }: { project: string }) {
  const live = approvedScripts.use();
  const list = live.filter((script) => script.scope.kind === 'project' && script.scope.projectId === project);
  return <Section title="Approved scripts" scope="Project" description={`Approved for ${projectLabel(project)} by its Leads. A Lead can approve only a script whose secrets they may use themselves. ${HOW}`}>
    {list.length ? <ScriptRows scripts={list} label={`${projectLabel(project)} scripts`} /> : <Note>No scripts approved for {projectLabel(project)} yet.</Note>}
  </Section>;
}

/** A principal's approved scripts: a person's (You › My approved scripts), or "<Bot>'s approved scripts" for a bot:
 * the ones approved For me while it held the workspace, and the ones its agents submitted. */
export function PrincipalScriptsPage({ principalId }: { principalId: string }) {
  const { state } = useMock();
  const live = approvedScripts.use();
  const who = principalOf(principalId);
  const bot = who.kind === 'bot';
  const submitted = (workspaceId: string): boolean => holdersOf(state, workspaceId).includes(who.id);
  const mine = live.filter((script) => (script.scope.kind === 'me' && script.scope.userId === who.id) || (bot && script.versions.some((version) => version.state === 'approved' && submitted(version.submittedIn))));
  const waiting = bot
    ? live.filter((script) => script.versions.some((version) => version.state === 'pending' && submitted(version.submittedIn)))
    : live.filter((script) => pendingRecipients(script.id, (id) => holdersOf(state, id)).includes(who.id));
  const seen = visibleProjects(who.id);
  const usable = live.filter((script) => !mine.includes(script) && (script.scope.kind === 'team' || (script.scope.kind === 'project' && seen.has(scriptProject(script)))));
  const scope = bot ? undefined : 'You';
  return <>
    <Section title={bot ? `${who.first}’s approved scripts` : 'Approved for me'} scope={scope} description={bot ? `Scripts approved For me while ${who.first} held the workspace, and the ones its agents submitted that were approved. Bots never approve; its sponsor answers the holder’s prompts.` : 'Scripts you approved “For me”: only your agents run them, in while you hold the handle.'}>
      {mine.length ? <ScriptRows scripts={mine} label={bot ? `${who.first}’s scripts` : 'My scripts'} /> : <Note>{bot ? `None yet. When ${who.first}’s agent submits a script, it waits in its approvers’ Needs you.` : 'None yet. When an agent in a workspace you hold submits a script, its card offers For me.'}</Note>}
    </Section>
    <Section title={bot ? 'Waiting for approval' : 'Waiting on you'} scope={scope} description={bot ? `Versions ${who.first}’s agents submitted that no one has decided yet.` : 'Pending versions you may approve: for yourself as holder, as a project’s Lead, or as an Owner or Admin. They’re in Needs you too.'}>
      {waiting.length ? <ScriptRows scripts={waiting} label={bot ? 'Waiting for approval' : 'Waiting on you'} /> : <Note>{bot ? 'Nothing waiting.' : 'Nothing waits on you.'}</Note>}
    </Section>
    <Section title={bot ? `${who.first}’s agents may also run` : 'Your agents may also run'} description={`The team’s scripts and those of the projects ${bot ? `${who.first} is` : 'you’re'} in.`}>
      {usable.length ? <ScriptRows scripts={usable} label="Team and project scripts" /> : <Note>None.</Note>}
    </Section>
  </>;
}
