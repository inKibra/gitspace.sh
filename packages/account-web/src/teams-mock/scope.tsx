// Whose things a settings page shows comes from where it sits: Crumb & Co's pages are the team's, You's pages are the
// viewer's, People › person opens someone else's, and Bots › bot opens a bot's own settings. Viewing a person's is
// revoke only for Owners and Admins: they see what's connected, its status, last use, projects and usage, and can
// disconnect, sign out, unpair, revoke or drop, but never see values, use the resources, connect anything in the
// person's name or edit their profile. Every revoke is in the audit log and tells the person; viewing isn't logged. A
// bot is managed in full by its sponsor and by Owners and Admins. Project Leads get no access.
import { badgeColors } from '@gitspace/ui';
import { Eye, Lock01 } from '@untitledui/icons';
import { actorLabel, bots, findPrincipal, notify, USERS, type Principal, type User } from './data.js';
import { recordAudit, revoked } from './settings/data.js';
import { Avatar } from './settings/parts.js';
import { accountRoleOf, whyAccount, type AccountAction } from './settings/roles.js';
import { useViewer } from './viewer.js';

/** Team (editable or read only), your own, a bot you sponsor (full), a bot you manage as an Owner or Admin (full), or
 * a person's as an Owner or Admin (revoke only). */
export type Access = 'team-edit' | 'team-read' | 'own' | 'sponsor' | 'manage' | 'revoke';
export interface ScopeInfo {
  scope: string;
  access: Access;
  /** Whose things: the viewer's own (You), the person's or bot's opened from People or Bots; null for the team's. */
  target: Principal | null;
  /** Why the Team scope is read only for this viewer. */
  teamReason: string | null;
}

/** The people and bots the viewer may open the scope of: anyone for Owners and Admins; their own bots for a sponsor. */
export function pickable(viewer: User): readonly Principal[] {
  const staff = viewer.accountRole === 'owner' || viewer.accountRole === 'admin';
  return [...USERS.filter((user) => staff && user.id !== viewer.id), ...bots.get().filter((bot) => staff || bot.sponsor === viewer.id)];
}

export function resolveScope(viewer: User, scope: string, teamAction: AccountAction): ScopeInfo | { refused: string } {
  const teamReason = whyAccount(viewer.id, teamAction);
  if (scope === 'team') return { scope, access: teamReason ? 'team-read' : 'team-edit', target: null, teamReason };
  if (scope === 'mine' || scope === viewer.id) return { scope: 'mine', access: 'own', target: viewer, teamReason };
  const target = findPrincipal(scope);
  if (!target) return { refused: 'No such person or bot' };
  if (target.kind === 'bot' && target.sponsor === viewer.id) return { scope, access: 'sponsor', target, teamReason };
  const staff = viewer.accountRole === 'owner' || viewer.accountRole === 'admin';
  if (target.kind === 'bot' && staff) return { scope, access: 'manage', target, teamReason };
  if (pickable(viewer).some((entry) => entry.id === target.id)) return { scope, access: 'revoke', target, teamReason };
  return { refused: `Only Owners and Admins open someone else’s scope, and a sponsor their own bots. Project Leads see the effect in a project’s environment popover only.` };
}

/** "Rina’s", "Deps bot’s", "your". */
export function whose(info: ScopeInfo): string {
  if (!info.target || info.access === 'own') return 'your';
  return `${info.target.first}’s`;
}

/** The reason an action that isn't a revoke is refused while viewing someone else's scope. */
export function revokeOnly(info: ScopeInfo, viewer: User): string | null {
  if (info.access !== 'revoke' || !info.target) return null;
  return `Viewing ${info.target.first}’s scope as ${accountRoleOf(viewer.id)?.name}: revoke only. Nothing is connected, used or edited in ${info.target.kind === 'bot' ? 'its' : 'their'} name.`;
}

/** Revokes one of `info.target`'s things: it leaves every list; from someone else's scope the revoke is in the audit log
 * and the person is told in their Inbox (for a bot, its sponsor, unless the sponsor revoked it). */
export function revokeIn(info: ScopeInfo, actor: User, id: string, what: string, verb: string, say: (text: string) => void): void {
  revoked.set(new Set([...revoked.get(), id]));
  const target = info.target;
  if (!target || info.access === 'own') { say(`You ${verb} your ${what}`); return; }
  const role = accountRoleOf(actor.id)?.name ?? '';
  const as = info.access === 'sponsor' ? 'as its sponsor' : `as ${role}`;
  recordAudit({ actor: actor.id, kind: target.kind === 'bot' ? 'bot' : 'resource', text: `${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${target.kind === 'bot' ? `${actorLabel(target.id)}’s ${what}` : `${target.name}’s ${what} from their scope`} (${as})` });
  const told = target.kind === 'bot' ? (target.sponsor && target.sponsor !== actor.id ? target.sponsor : null) : target.id;
  if (told) notify({ to: told, from: actor.id, text: `${actor.first} ${verb} ${target.kind === 'bot' ? `${target.name}’s` : 'your'} ${what}`, detail: target.kind === 'bot' ? `As ${role} · in the audit log` : `As ${role}, from your scope · in the audit log` });
  say(`${verb.charAt(0).toUpperCase()}${verb.slice(1)} ${target.first}’s ${what} · ${told ? `${told === target.id ? 'they’re' : `${findPrincipal(told)?.first ?? 'its sponsor'} is`} told; ` : ''}it’s in the audit log`);
}

/** The banner over someone else's pages (or a read-only team page): whose they are and what the viewer may do. Over a
 * bot's pages it says the viewer is managing its settings, as its sponsor or as an Owner or Admin. */
export function ScopeBanner({ info, noun }: { info: ScopeInfo; noun: string }) {
  const viewer = useViewer();
  if (info.access === 'team-edit' || info.access === 'own') return null;
  const target = info.target;
  const managing = (info.access === 'sponsor' || info.access === 'manage') && target?.kind === 'bot';
  const tone = info.access === 'team-read' ? badgeColors.amber : managing ? badgeColors.violet : badgeColors.blue;
  const sponsor = target?.kind === 'bot' && target.sponsor ? findPrincipal(target.sponsor)?.first ?? null : null;
  const head = info.access === 'team-read' ? `Read only · ${info.teamReason}`
    : managing ? `You’re managing ${target.name}’s settings`
    : `Viewing ${target?.first}’s ${noun} · as ${accountRoleOf(viewer.id)?.name} · revoke only`;
  const body = info.access === 'team-read' ? 'You see the team’s setup; editing takes an Owner or Admin.'
    : managing ? `${info.access === 'sponsor' ? 'As its sponsor' : `As ${accountRoleOf(viewer.id)?.name}${sponsor ? `; ${sponsor} sponsors it and is told what you change` : ''}`}. These are ${target.name}’s own: what you add here is used only in turns it starts, and its actions read “${actorLabel(target.id)}”. Changes are in the audit log. Its sponsor, Owners and Admins manage it; nobody sees a secret value again.`
    : `You see what’s connected, its status, last use, which projects use it, and usage and cost. You can disconnect, sign out, unpair, revoke or drop. You never see secret values, use ${target?.first}’s resources, connect anything in their name, or edit their profile. Each revoke is in the audit log and tells ${target?.first}; viewing isn’t logged.`;
  return <div role="note" data-scope-banner={managing ? 'managing' : info.access} className="flex items-start gap-3 rounded-xl px-3 py-2.5" style={{ background: `color-mix(in oklab, ${tone} 9%, transparent)`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tone} 35%, transparent)` }}>
    {target ? <Avatar userId={target.id} size={22} /> : <Lock01 width={18} height={18} strokeWidth={1.5} className="mt-0.5 shrink-0" style={{ color: tone }} />}
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex items-center gap-1.5 text-body font-medium text-foreground">{info.access === 'revoke' ? <Eye width={14} height={14} strokeWidth={1.75} /> : null}{head}</span>
      <span className="text-caption text-muted-foreground [text-wrap:pretty]">{body}</span>
    </div>
  </div>;
}
