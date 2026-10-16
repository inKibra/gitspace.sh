import { inferenceSettingSection } from '@gitspace/protocol/inference';
import type { RuntimeSettingValue } from '@gitspace/protocol';

const RENAMED_MODEL_ROLES: Readonly<Record<string, string>> = { slow: 'deep', smol: 'fast' };
function renamedRoleAlias(value: RuntimeSettingValue): RuntimeSettingValue {
  if (typeof value === 'string') return value.replace(/^(pi\/|@)(slow|smol)(?=$|:)/u, (_match, prefix: string, role: string) => `${prefix}${RENAMED_MODEL_ROLES[role]}`);
  return Array.isArray(value) ? value.map(renamedRoleAlias) : value;
}
/** Drops settings no profile owns any more and renames Thinking/Fast roles; an explicitly set new name wins. */
export function migratedRoleSettings(settings: Record<string, RuntimeSettingValue>): Record<string, RuntimeSettingValue> {
  const migrated: Record<string, RuntimeSettingValue> = {};
  const renamed: Array<[string, RuntimeSettingValue]> = [];
  for (const [path, value] of Object.entries(settings)) {
    if (!inferenceSettingSection(path)) continue;
    const role = /^modelRoles\.(.+)$/u.exec(path)?.[1];
    if (role !== undefined && RENAMED_MODEL_ROLES[role]) { renamed.push([`modelRoles.${RENAMED_MODEL_ROLES[role]}`, renamedRoleAlias(value)]); continue; }
    if (path === 'modelRoles' && value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const roles: Record<string, RuntimeSettingValue> = {};
      for (const [name, model] of Object.entries(value)) if (!RENAMED_MODEL_ROLES[name] && model !== undefined) roles[name] = renamedRoleAlias(model);
      for (const [name, model] of Object.entries(value)) if (RENAMED_MODEL_ROLES[name] && model !== undefined) roles[RENAMED_MODEL_ROLES[name]] ??= renamedRoleAlias(model);
      migrated[path] = roles;
      continue;
    }
    migrated[path] = renamedRoleAlias(value);
  }
  for (const [path, value] of renamed) migrated[path] ??= value;
  return migrated;
}
