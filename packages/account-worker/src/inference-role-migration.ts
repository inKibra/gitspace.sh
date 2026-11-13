import { imagesSelectorSchema, inferenceSettingSection, parseModelRoleSelector } from '@gitspace/protocol/inference';
import type { RuntimeSettingValue } from '@gitspace/protocol';

const RENAMED_MODEL_ROLES: Readonly<Record<string, string>> = { slow: 'deep', smol: 'fast' };
function renamedRoleAlias(value: RuntimeSettingValue): RuntimeSettingValue {
  if (typeof value === 'string') return value.replace(/^(pi\/|@)(slow|smol)(?=$|:)/u, (_match, prefix: string, role: string) => `${prefix}${RENAMED_MODEL_ROLES[role]}`);
  return Array.isArray(value) ? value.map(renamedRoleAlias) : value;
}
/** Drops settings no profile owns any more, renames Thinking/Fast roles (an explicitly set new name wins), moves the
 * OMP `vision` role to the Vision fallback setting and the custom `image` role to the Images service. */
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
  const vision = movedRole(migrated, 'vision');
  if (typeof vision === 'string') migrated.visionFallback ??= vision;
  const image = movedRole(migrated, 'image');
  // The Images service takes `provider/model` with no thinking level; a role naming a pattern or role is dropped.
  const images = image === undefined ? undefined : parseModelRoleSelector(image).selector;
  if (images !== undefined && imagesSelectorSchema.safeParse(images).success) migrated.images ??= images;
  return migrated;
}

/** Removes `role` from `migrated`'s model roles and returns its first model selector, not a `pi/` alias. */
function movedRole(migrated: Record<string, RuntimeSettingValue>, role: string): string | undefined {
  const roles = migrated.modelRoles;
  const value = migrated[`modelRoles.${role}`] ?? (roles !== null && typeof roles === 'object' && !Array.isArray(roles) ? roles[role] : undefined);
  if (value === undefined) return undefined;
  delete migrated[`modelRoles.${role}`];
  if (roles !== null && typeof roles === 'object' && !Array.isArray(roles)) { const { [role]: _moved, ...others } = roles; migrated.modelRoles = others; }
  const selector = Array.isArray(value) ? value.find(item => typeof item === 'string' && !item.startsWith('pi/')) : value;
  return typeof selector === 'string' && selector && !selector.startsWith('pi/') ? selector : undefined;
}
