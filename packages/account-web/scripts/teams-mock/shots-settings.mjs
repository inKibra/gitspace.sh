// Screenshots of the full pages (Settings and a project's settings) and the app's live pages (People, a person,
// Projects, a project, Services, Machines, Browsers, Sessions, Usage), as different users, at full width and at half
// width (760 and 900 px), into OUT (see shots-lib.mjs) with captions in s-captions.txt. Reports console errors and
// warnings.
import { chromium } from '@playwright/test';
import { MOCK_URL, OUT } from './shots-lib.mjs';

const browser = await chromium.launch();
const problems = [];
const captions = [];

async function open(query, scheme = 'light', height = 1000, width = 1440) {
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') problems.push(`${query} · ${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => problems.push(`${query} · pageerror: ${error.message}`));
  await page.goto(`${MOCK_URL}?${query}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return { page, context };
}
async function shot(page, name, caption) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  captions.push(`${name}.png — ${caption}`);
}
async function one(query, name, caption, { scheme = 'light', height = 1000, width = 1440, act } = {}) {
  const { page, context } = await open(query, scheme, height, width);
  if (act) { await act(page); await page.waitForTimeout(600); }
  await shot(page, name, caption);
  await context.close();
}
const settings = (query) => `view=settings&${query}`;
const project = (query) => `view=project-settings&${query}`;

// ── Settings: a full page; a clear “Back to work” button; You first, then Crumb & Co ──
await one(settings('page=profile&as=maya'), 's-01-settings-full-page', 'Settings is a full page with a clear “← Back to work” button at the top of its nav, then “Settings for: Maya (you)” (she manages bots), her own pages, then Crumb & Co', { height: 1100 });
await one(settings('page=profile&as=maya'), 's-01b-settings-dark', 'Settings, dark: the Back to work button stays obvious', { scheme: 'dark', height: 1100 });
await one(settings('page=profile&as=maya'), 's-01c-settings-760', 'Settings at 760 px: the nav narrows, labels truncate, Back to work stays a button', { width: 760, height: 1000 });
await one(settings('page=profile&as=maya'), 's-01d-settings-760-dark', 'Settings at 760 px, dark', { width: 760, height: 1000, scheme: 'dark' });

// You
await one(settings('page=git&as=maya'), 's-02-you-git-identity', 'You › Git identity: commit author, her own GitHub account (each member sets up their own), her SSH key for her own machines; personal machines never get the team key', { height: 1300 });
await one(settings('page=git&as=jules'), 's-02b-you-git-identity-jules', 'You › Git identity as Jules: GitHub not connected yet, “Connect GitHub”', { height: 1300 });
await one(settings('page=my-inference&as=maya'), 's-03-you-inference', 'You › Inference: her Claude Max and where it can pay', {});
await one(settings('page=my-plugins&as=maya&tab=mcp'), 's-04-you-plugins', 'You › Plugins · Custom MCP', { height: 1100 });
await one(settings('page=my-machines&as=maya'), 's-05-you-machines', 'You › Machines: her own, with her own SSH key', {});
await one(settings('page=my-secrets&as=maya'), 's-06-you-step-ups', 'You › My secrets as Maya: her own secrets (the old step-ups), each a cleared shell for N min with a passkey, NPM_TOKEN open now; then the values Crumb asks her for', { height: 1200 });
await one(settings('page=my-secrets&as=sam'), 's-07-you-secrets', 'You › My secrets as Sam: no own secrets; the values Crumb asks each holder for (STAGING_LOGIN missing, FIGMA_TOKEN set), each with Crumb’s rule', {});
await one(settings('page=mcp&as=maya'), 's-08-you-mcp-clients', 'You › MCP clients', { height: 1200 });
await one(settings('page=bots&as=maya'), 's-09-you-sponsored-bots', 'Crumb & Co › Bots (Maya, an Owner): Bots you sponsor (Deps bot) on top; pick it under “Settings for” to open its settings', { height: 1300 });
await one(settings('page=my-inference&as=maya'), 's-09b-you-inference-760', 'You › Inference at 760 px: rows wrap their controls under the text', { width: 760 });

// Crumb & Co › People & roles, rebuilt
await one(settings('page=people&as=maya'), 's-20-people-roles', 'People & roles, rebuilt in the Settings style: People, Invites, Roles; each row with presence, roles, account role, Open (their People page), Projects, Remove', { height: 1300 });
await one(settings('page=people&as=maya'), 's-20b-people-roles-760', 'People & roles at 760 px: controls wrap under each person', { width: 760, height: 1300 });
await one(settings('page=people&as=maya'), 's-20c-people-roles-900', 'People & roles at 900 px', { width: 900, height: 1300 });
await one(settings('page=people&as=rina'), 's-21-people-roles-member', 'People & roles as Rina (Member): read only; Open still goes to each People page', { height: 1100 });
await one(settings('page=people&tab=invites&as=theo'), 's-22-invites', 'People & roles · Invites as Theo (Admin)', {});
await one(settings('page=people&tab=invites&as=theo&invite=jules%40pastry-studio.example'), 's-23-invite-refused', 'Invite: an address outside the allowed domains is refused with the reason', { height: 1100, act: (page) => page.getByRole('button', { name: 'Invite', exact: true }).first().click() });
await one(settings('page=people&tab=roles&as=maya'), 's-24-roles', 'People & roles · Roles', { height: 2300 });
const demote = async (page) => {
  await page.getByRole('combobox', { name: 'Account role for Theo Park' }).click();
  await page.getByRole('option', { name: 'Member' }).click();
  await page.waitForTimeout(400);
};
await one(settings('page=people&as=maya'), 's-26-demote-admin-dialog', 'Maya changes Theo to Member: the same dialog offers to hand Release bot to another Admin or Owner (Maya by default); skipping blocks its sign-ins, which expire after 30 days', { height: 1100, act: demote });
await one(settings('page=people&as=maya'), 's-26b-demote-handed-over', 'Change role and hand over: Theo is a Member and Release bot is sponsored by Maya, still working', { height: 1100, act: async (page) => {
  await demote(page);
  await page.getByRole('button', { name: 'Change role and hand over' }).click();
} });
await one(settings('page=people&as=maya'), 's-26c-demote-skipped-blocks', 'Skip and block it: Release bot can’t sign in until an Admin takes it over', { height: 1100, act: async (page) => {
  await demote(page);
  await page.getByRole('button', { name: 'Skip and block it' }).click();
} });
await one('view=people&as=jules', 's-27-people-presence-limited', 'People as Jules (Member, Crumb only): Rina works in a Ledger workspace and Sam in Field notes, so Jules sees only “Online”; where and what show only to people in the same project', { height: 1300 });
await one('view=people&as=theo', 's-27b-people-presence-theo', 'People as Theo (Admin, not in Field notes): Sam shows only Online; Rina’s Ledger workspace shows, since Theo is in Ledger', { height: 1300 });
await one('view=person&person=rina&as=sam', 's-27c-person-member-view', 'Rina’s page as Sam (Member): presence limited to Online, no connections and never the names of her personal values', { height: 900 });

// Bots: Admin sponsors, blocked state, slices, Admin-only client secrets
await one(settings('page=bots&as=theo'), 's-30-bots', 'Crumb & Co › Bots as Theo: sponsors are Admins or Owners; Support triage bot’s sign-ins blocked (Take over)', { height: 1500 });
await one(settings('page=bots&person=triage-bot&as=theo'), 's-31-bot-blocked', 'Bot · Support triage bot › Profile as Theo (Admin): “Sign-ins blocked: its sponsor Devon Hale left the team”; its sign-ins kept, Take it over restores them', { height: 1100 });
await one(settings('page=bots&person=triage-bot&as=theo'), 's-32-bot-taken-over', 'Theo takes it over: its sign-ins work again; the header reads sponsored by Theo', { height: 1100, act: (page) => page.getByRole('button', { name: 'Take it over' }).click() });
await one(settings('page=passkeys&person=release-bot&as=theo'), 's-33-bot-release', 'Bot · Release bot › Sign-ins as Theo (its Admin sponsor): connected clients and client secrets, each with its slice; Edit slice, Revoke', { height: 1500 });
await one(settings('page=passkeys&person=release-bot&as=theo'), 's-34-bot-edit-slice', 'Edit slice: the same capability picker as a person’s MCP client; the bot’s roles are the ceiling', { height: 1100, act: (page) => page.getByRole('button', { name: 'Edit the slice of release-ci' }).click() });
await one(settings('page=passkeys&person=release-bot&as=theo'), 's-35-connect-as-bot', 'Connect a client: consent page in Theo’s browser, “Connect as Release bot”, with its slice, approve with passkey', { height: 1200, act: (page) => page.getByRole('button', { name: 'Connect a client' }).click() });
await one(settings('page=passkeys&person=release-bot&as=theo'), 's-36-client-secret', 'Create client secret (Owners and Admins only): label and slice, then passkey', { height: 1200, act: (page) => page.getByRole('button', { name: 'Create client secret' }).click() });
await one(settings('page=bots&person=deps-bot&as=maya'), 's-37-bot-deps', 'Bot · Deps bot › Profile as Maya (Owner, its sponsor): You’re managing Deps bot’s settings', { height: 1300 });
await one(settings('page=bots&person=release-bot&as=sam'), 's-38-bot-refused', 'Sam (Member) asking for Release bot’s settings: refused', {});

// Crumb & Co: the rest
await one(settings('page=inference&as=maya'), 's-40-team-inference', 'Crumb & Co › Inference; Budgets labelled New (not in GitSpace yet)', { height: 2000 });
await one(settings('page=machines&as=maya'), 's-41-team-machines', 'Crumb & Co › Machines: team machines and the team SSH key', { height: 1500 });
await one(settings('page=github&as=maya'), 's-42-github-app', 'Crumb & Co › GitHub App', { height: 1600 });
await one(settings('page=audit&as=theo'), 's-43-audit', 'Audit log as Theo', { height: 1300 });

// ── A project's settings ──
await one(project('project=ledger&page=members&as=rina'), 's-50-project-members-lead', 'Ledger · Members as Rina (Lead): Maya (Owner) and Theo (Admin) both marked “Lead can’t change”', { height: 1100 });
await one(project('project=ledger&page=members&as=rina'), 's-50b-lead-refused-on-owner', 'Rina hovers Remove on Maya: Owners are Lead everywhere; a Lead can’t change or remove them', { height: 1100, act: (page) => page.getByRole('button', { name: 'Remove Maya Okafor from Ledger' }).hover() });
await one(project('project=ledger&page=repositories&as=theo'), 's-51-project-repositories', 'Ledger · Repositories: the project repository and the bitbucket fixtures, each with how it’s reached; Add repository', {});
await one(project('project=ledger&page=repositories&as=theo'), 's-52-connect-repositories', 'Add repository runs “Connect repositories”: GitHub App, through team machines (team SSH key), or not reachable with the fix', { height: 1100, act: (page) => page.getByRole('button', { name: 'Add repository' }).click() });
await one(project('project=crumb&page=environment&as=maya'), 's-53-project-environment', 'Crumb · Environment: Instructions (“How to work on Crumb”) with Deps bot’s proposed revision 8 above them (Approve, Decline), then the machine profiles Crumb needs (Web, iOS) with their checks and readiness', { height: 1700 });
await one(project('project=crumb&page=environment&as=maya'), 's-54-environment-revisions', 'Crumb · Environment, lower: secrets it uses with each rule (project, team, each holder’s own and who set it), origins and network, approvals, revision history with Diff and Roll back', { height: 1700, act: async (page) => {
  await page.locator('[data-revision="5"]').first().scrollIntoViewIfNeeded();
} });
await one(project('project=ledger&page=automations&as=theo'), 's-55-project-automations', 'Ledger · Automations: “Enabled by Theo Park”; a failed run goes to Needs you for Owners, Admins, the Leads and whoever enabled it', {});
await one(project('project=crumb&page=members&as=maya'), 's-56-project-settings-760', 'Project settings at 760 px: Back to Crumb button, nav narrows, rows wrap', { width: 760, height: 1100 });

// ── Live pages, full width and half width ──
const live = [
  ['view=people&as=maya', 'people', 'People: presence, roles, projects, the bots each sponsors; bots with sponsors and blocked sign-ins', 1700],
  ['view=person&person=rina&as=theo', 'person-rina', 'Rina’s page as Theo (Admin): presence, roles, admin actions, and everything she’s connected with Revoke', 2400],
  ['view=projects&as=maya', 'projects', 'Projects: cards with health and New project', 1000],
  ['view=project&project=ledger&as=theo', 'project-ledger', 'Ledger’s overview', 1500],
  ['view=services&as=maya', 'services', 'Services: stats strip, crashed pinned with its last log lines, each service with up/down, uptime, requests/min, errors, p50 and sparklines; sites with last deploy; share links with visitors', 2600],
  ['view=machines&as=maya', 'machines', 'Machines: stats strip, each machine with CPU/memory/disk gauges, load sparkline, processes and how long, release, recent events; offline dimmed with “since”', 2800],
  ['view=browsers&as=maya', 'browsers', 'Browsers: stats strip, live tab thumbnails (sign-in waiting for a person, menu, docs, dashboard, checkout, tables) with driver, time, actions/min, Watch / Take over / Stop; paired Chromes', 2200],
  ['view=sessions&as=theo&who=everyone', 'sessions', 'Sessions as Theo with Person: Everyone: presence, MCP clients with last call and calls/hour, step-ups counting down, sign-ins expiring, timeline, devices, bots', 2600],
  ['view=usage&as=sam', 'usage-member', 'Usage as Sam (Member): team totals plus his own', 1600],
];
for (const [query, name, caption, height] of live) {
  await one(query, `p-${name}`, caption, { height });
  await one(query, `p-${name}-900`, `${caption} · at 900 px`, { width: 900, height });
  await one(query, `p-${name}-760`, `${caption} · at 760 px`, { width: 760, height });
}
await one('view=sessions&as=theo', 'p-sessions-own', 'Sessions opens on your own; Owners and Admins switch “Person: Everyone”', { height: 1600 });
await one('view=usage&as=maya', 'p-usage-owner', 'Usage as Maya (Owner): budgets (New), subscription windows, spend by person, project, profile, provider', { height: 2400 });
await one('view=machines&page=add&as=maya', 'p-add-computer', 'Add a computer: mine (own SSH key and GitHub setup) or the team’s', {});
await one('view=projects&page=new&as=maya', 'p-new-project', 'New project, step 1', {});
await one('view=projects&page=new&as=maya', 'p-new-project-repositories', 'New project, step 2: Source, the same Connect repositories steps as Add repository', { height: 1100, act: (page) => page.getByRole('dialog').getByRole('button', { name: 'Next', exact: true }).click() });
await one('view=browsers&as=rina', 'p-browsers-lead', 'Browsers as Rina (Member, Lead in Ledger): she can take over the PDFKit tab in invoice-pdf-export, which Theo holds, as Lead in Ledger; Crumb tabs she doesn’t hold are refused', { height: 2000 });
await one('view=sessions&as=theo', 'p-sessions-lead', 'Sessions as Theo is the Admin view; as a Lead who isn’t an Admin (next shot) it stays your own', { height: 1200 });
await one('view=sessions&as=rina', 'p-sessions-lead-own', 'Sessions as Rina (Lead in Ledger, Member): only her own; Leads don’t see their members’ sessions, only Owners and Admins pick “Everyone”', { height: 1400 });

await browser.close();
console.log(captions.join('\n'));
await Bun.write(`${OUT}/s-captions.txt`, `${captions.join('\n')}\n`);
console.log(problems.length ? `\nPROBLEMS (${problems.length}):\n${problems.join('\n')}` : '\nNo console errors or warnings.');
