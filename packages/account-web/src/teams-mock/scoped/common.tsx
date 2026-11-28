// Pieces the settings pages share: where a person's or bot's own things apply (projects they're in whose settings or
// profile allow them).
import { visibleProjects } from '../data.js';
import { ACTIVE_PROJECTS, personalKindOf, PROFILES, projectName, projectSettings, type ModelCredential } from '../settings/data.js';

/** "Crumb and Ledger". */
export function listNames(ids: readonly string[]): string {
  const names = ids.map(projectName);
  return names.length <= 2 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** Where a person's own plugins apply: projects they're in whose settings allow holders' own plugins, and the ones
 * that don't. */
export function pluginReach(userId: string): { on: readonly string[]; off: readonly string[] } {
  const mine = ACTIVE_PROJECTS.filter((project) => visibleProjects(userId).has(project.id)).map((project) => project.id);
  return { on: mine.filter((id) => projectSettings.get()[id]?.holdersPlugins), off: mine.filter((id) => !projectSettings.get()[id]?.holdersPlugins) };
}

/** Where a person's provider may pay: projects they're in whose profile lets holders pay with its kind (e.g. an
 * Anthropic subscription); the rest with why not. The profile alone decides. */
export function providerReach(userId: string, credential: ModelCredential): { on: readonly string[]; off: ReadonlyArray<{ id: string; why: string }> } {
  const mine = ACTIVE_PROJECTS.filter((project) => visibleProjects(userId).has(project.id)).map((project) => project.id);
  const kind = personalKindOf(credential);
  const off: { id: string; why: string }[] = [];
  const on = mine.filter((id) => {
    const profile = PROFILES.find((entry) => entry.id === projectSettings.get()[id]?.profile);
    if (!profile) return false;
    if (!profile.personal.length) { off.push({ id, why: `its profile, ${profile.name}, pays with team providers only` }); return false; }
    if (!profile.personal.includes(kind)) { off.push({ id, why: `its profile, ${profile.name}, doesn’t allow ${kind}s` }); return false; }
    return true;
  });
  return { on, off };
}
