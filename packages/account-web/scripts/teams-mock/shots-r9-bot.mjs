// Round 9, bot principal profile: a bot's settings are the same pages as You, under "Bot · name" (Profile, Git identity,
// Defaults, Inference, Plugins, Skills, Machines, <Bot>'s secrets, <Bot>'s approved scripts, Sign-ins), with the
// managing banner; as Maya for Deps bot (each page), as Theo for Release bot, Theo managing Maya's bot as Admin, Sam
// refused, the blocked triage bot, and each flow that moved onto a page. Shots into $OUT as r9-bot-*.png with captions
// in r9-bot-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('r9-bot-captions.txt');
const settings = (query) => `view=settings&${query}`;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).click();
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
const nav = (page, id) => page.locator(`[data-settings-nav="bot-${id}"]`).click();

// ── The "Settings for" picker, and opening a bot from Bots ──
await r.flow(settings('page=profile&as=maya'), 'r9-bot-nav-01-picker', 'Settings as Maya: under Back to work, “Settings for” shows Maya (you); her own pages, then Crumb & Co. No “Bots you sponsor” page: the list is at the top of Crumb & Co › Bots', { height: 1100 });
await r.flow(settings('page=profile&as=maya'), 'r9-bot-nav-01b-picker-open', 'The picker open: Maya (you), then each bot she manages, each with its avatar and sponsor (an Owner manages every bot)', { height: 1100, act: (page) => page.getByRole('combobox', { name: 'Settings for' }).click() });
await r.flow(settings('page=git&as=maya'), 'r9-bot-nav-01c-picked', 'Deps bot picked: the personal pages are Deps bot’s (Git identity stays open), with the managing banner; Crumb & Co stays below; the URL now has person=deps-bot', { height: 1100, act: async (page) => {
  await page.getByRole('combobox', { name: 'Settings for' }).click();
  await page.getByRole('option', { name: /^Deps bot/ }).click();
} });
await r.flow(settings('page=bots&as=theo'), 'r9-bot-nav-02-from-bots', 'Crumb & Co › Bots › Open Release bot as Theo: the picker switches to Release bot and its Profile opens', { height: 1100, act: (page) => page.getByRole('button', { name: 'Open Release bot' }).first().click() });
await r.flow(settings('page=bots&as=maya'), 'r9-bot-nav-02b-sponsored-list', 'Crumb & Co › Bots as Maya: “Bots you sponsor” (Deps bot, with what waits for her) on top, then every bot', { height: 1400 });
await r.flow(settings('page=profile&as=sam'), 'r9-bot-nav-02c-no-picker', 'Sam (Member, manages no bot): no picker, just You · Sam, as before', { height: 1000 });

// ── Each page, as Maya for Deps bot ──
const DEPS = 'person=deps-bot&as=maya';
await r.flow(settings(`page=bots&${DEPS}`), 'r9-bot-profile-01-deps', 'Bot · Deps bot · sponsored by Maya › Profile (page=bots&person=deps-bot): “You’re managing Deps bot’s settings”; name, handle, avatar, sponsor, notes; Roles and projects; Activity; Audit', { height: 2600 });
await r.flow(settings(`page=git&${DEPS}`), 'r9-bot-git-01-deps', 'Git identity: commit author, and GitHub through its own machine-user account crumbco-deps (fine-grained token) or the team’s App', { height: 1000 });
await r.flow(settings(`page=defaults&${DEPS}`), 'r9-bot-defaults-01-deps', 'Defaults: model role and workspace mode for runs Deps bot starts; no notifications row', { height: 900 });
await r.flow(settings(`page=my-inference&${DEPS}`), 'r9-bot-inference-01-deps', 'Inference: Deps bot has no key of its own, so its turns use the team’s providers; the team’s profiles apply as for anyone', { height: 1000 });
await r.flow(settings(`page=my-plugins&${DEPS}`), 'r9-bot-plugins-01-deps', 'Plugins › Custom MCP: Linear signed in as Deps bot (its own account), where it applies', { height: 1100 });
await r.flow(settings(`page=my-plugins&tab=browsers&${DEPS}`), 'r9-bot-plugins-02-browsers', 'Plugins › Browsers: a bot pairs no Chrome; Pair a Chrome says why; its logins reach a page by autofill from its secrets', { height: 1000 });
await r.flow(settings(`page=my-skills&${DEPS}`), 'r9-bot-skills-01-deps', 'Skills: deps-upgrade-policy, Deps bot’s own; New skill and Edit open for its sponsor', { height: 1000 });
await r.flow(settings(`page=my-machines&${DEPS}`), 'r9-bot-machines-01-deps', 'Machines: Deps bot owns none, its turns run on team machines; Cell container and Cloud VM add one for it, Physical computer is refused with why', { height: 1000 });
await r.flow(settings(`page=my-secrets&${DEPS}`), 'r9-bot-secrets-01-deps', 'Deps bot’s secrets: its own, each with a rule (approved scripts, browser autofill, or the sponsor approves each use with passkey; never a shell)', { height: 1500 });
await r.flow(settings(`page=my-scripts&${DEPS}`), 'r9-bot-scripts-01-deps', 'Deps bot’s approved scripts: scripts approved for its agents, versions waiting, and what its agents may also run', { height: 1500 });
await r.flow(settings(`page=passkeys&${DEPS}`), 'r9-bot-signins-01-deps', 'Sign-ins (Passkeys and devices and MCP clients merged): its connected clients and client secrets, each with its slice', { height: 1200 });
await r.flow(settings(`page=mcp&${DEPS}`), 'r9-bot-signins-02-mcp-link', 'An MCP clients link for a bot (page=mcp&person=deps-bot) opens its Sign-ins', { height: 900 });
await r.flow(settings(`page=voice&${DEPS}`), 'r9-bot-profile-02-voice-link', 'A Voice link for a bot opens its Profile: a bot has no Voice (nor step-up credentials, nor Bots you sponsor)', { height: 900 });
await r.flow(settings(`page=bots&${DEPS}`), 'r9-bot-nav-03-click-through', 'Clicking Bot · Deps bot › Git identity in the nav keeps person=deps-bot', { height: 900, act: (page) => nav(page, 'git') });

// ── As Theo for Release bot ──
const REL = 'person=release-bot&as=theo';
await r.flow(settings(`page=profile&${REL}`), 'r9-bot-profile-03-release', 'Bot · Release bot · sponsored by Theo › Profile, as Theo (Admin, its sponsor)', { height: 2600 });
await r.flow(settings(`page=my-inference&${REL}`), 'r9-bot-inference-02-release', 'Inference: Release bot’s own Anthropic key, where it can pay and where not (each project’s profile decides); Sign out', { height: 1000 });
await r.flow(settings(`page=my-plugins&${REL}`), 'r9-bot-plugins-03-release', 'Plugins: Slack with Release bot’s own bot token, posting to #releases', { height: 1100 });
await r.flow(settings(`page=passkeys&${REL}`), 'r9-bot-signins-03-release', 'Sign-ins: release-ci (client secret) and Claude Code on build-02 (connected), each with its slice', { height: 1200 });
await r.flow(settings(`page=my-secrets&${REL}`), 'r9-bot-secrets-02-release', 'Release bot’s secrets as Theo: NPM_PUBLISH_TOKEN and the rest, moved from the old credentials list', { height: 1500 });

// ── The banner: Theo, an Admin, managing Maya's bot ──
await r.flow(settings('page=profile&person=deps-bot&as=theo'), 'r9-bot-banner-01-admin', 'Theo (Admin, not its sponsor) on Deps bot: “You’re managing Deps bot’s settings · As Admin; Maya sponsors it and is told what you change”', { height: 900 });

// ── Refused, blocked ──
await r.flow(settings('page=profile&person=deps-bot&as=sam'), 'r9-bot-refused-01-sam', 'Sam (Member) asking for Deps bot’s settings: refused, no Bot nav; only Maya (its sponsor), Owners and Admins open it', { height: 900 });
await r.flow(settings('page=my-secrets&person=release-bot&as=sam'), 'r9-bot-refused-02-sam-secrets', 'Sam asking for Release bot’s secrets page directly: refused the same way', { height: 900 });
await r.flow(settings('page=bots&person=triage-bot&as=maya'), 'r9-bot-blocked-01-triage', 'Support triage bot as Maya: no sponsor; the blocked notice with Take it over sits over every page', { height: 1300 });
await r.flow(settings('page=passkeys&person=triage-bot&as=maya'), 'r9-bot-blocked-02-signins', 'Its Sign-ins: kept and marked Blocked; Connect a client and Edit slice say why', { height: 1100 });
await r.flow(settings('page=passkeys&person=triage-bot&as=maya'), 'r9-bot-blocked-03-taken-over', 'Take it over: Maya sponsors it now; its sign-ins work again', { height: 1100, act: (page) => press(page, 'Take it over') });

// ── Flows that moved onto the pages ──
await r.flow(settings(`page=profile&${REL}`), 'r9-bot-profile-04-edit', 'Profile › Edit profile: name, fixed handle, what it does, notes, avatar', { height: 1000, act: (page) => press(page, 'Edit profile') });
await r.flow(settings(`page=profile&${REL}`), 'r9-bot-profile-05-roles', 'Profile › Roles and projects › Edit roles, within Theo’s own', { height: 1000, act: (page) => press(page, 'Edit roles') });
await r.flow(settings(`page=profile&${REL}`), 'r9-bot-profile-06-activity', 'Profile › Activity', { height: 1000, act: (page) => scrollTo(page, '[data-bot-activity]') });
await r.flow(settings(`page=profile&${REL}`), 'r9-bot-profile-07-audit', 'Profile › Audit, with Open in the audit log', { height: 1000, act: (page) => scrollTo(page, '[data-bot-audit]') });
await r.flow(settings(`page=passkeys&${REL}`), 'r9-bot-signins-04-connect', 'Sign-ins › Connect a client', { height: 1000, act: (page) => press(page, 'Connect a client') });
await r.flow(settings(`page=passkeys&${REL}`), 'r9-bot-signins-05-client-secret', 'Sign-ins › Create client secret (Owners and Admins only)', { height: 1000, act: (page) => press(page, 'Create client secret') });
await r.flow(settings(`page=passkeys&${REL}`), 'r9-bot-signins-06-slice', 'Sign-ins › Edit slice of release-ci', { height: 1000, act: (page) => page.getByRole('button', { name: 'Edit the slice of release-ci' }).click() });
await r.flow(settings(`page=passkeys&${REL}`), 'r9-bot-signins-07-revoke', 'Sign-ins › Revoke release-ci', { height: 1000, act: (page) => page.getByRole('button', { name: 'Revoke release-ci' }).click() });
await r.flow(settings(`page=git&${REL}`), 'r9-bot-git-02-author', 'Git identity › Edit the commit author', { height: 1000, act: (page) => page.getByRole('button', { name: 'Edit the commit author' }).click() });
await r.flow(settings(`page=git&${REL}`), 'r9-bot-git-03-machine-user', 'Git identity › Use its own GitHub account: machine user with a fine-grained token', { height: 1000, act: (page) => press(page, 'Use its own GitHub account') });

// ── The You pages' flows, made for the bot ──
await r.session(settings(`page=my-inference&${DEPS}`), async (page, step) => {
  await press(page, 'Connect a provider');
  await step('r9-bot-inference-03-connect', 'Inference › Connect a provider for Deps bot: subscriptions refused (a subscription is a person’s); API keys or a local model');
  const d = flow(page, 'add-provider');
  await press(d, 'Continue');
  await d.getByLabel('API key').first().fill('sk-ant-api03-deps9Qk2mZ7xR4vT1pW8cY3abcdefghij');
  await press(d, 'Check key');
  await page.waitForTimeout(1300);
  await step('r9-bot-inference-04-where', 'Connect a provider: named “Deps bot’s Anthropic key”, where it may pay, and that it pays only for turns Deps bot starts');
  await press(d, 'Connect');
  await step('r9-bot-inference-05-done', 'Connected: the key is Deps bot’s; in the audit log');
  await press(d, 'Done');
  await step('r9-bot-inference-06-listed', 'Deps bot’s providers now list its own Anthropic key');
}, { height: 1000 });
await r.session(settings(`page=my-plugins&${DEPS}`), async (page, step) => {
  await press(page, 'Sign in to an MCP server');
  const d = flow(page, 'personal-plugin');
  await d.locator('[data-choice="slack"]').click();
  await press(d, 'Continue');
  await step('r9-bot-plugins-04-sign-in', 'Plugins › Sign in to an MCP server as Deps bot: the sign-in uses its own account, not Maya’s');
}, { height: 1000 });
await r.flow(settings(`page=my-skills&${DEPS}`), 'r9-bot-skills-02-new', 'Skills › New skill for Deps bot', { height: 1000, act: (page) => press(page, 'New skill') });
await r.flow(settings(`page=my-plugins&${DEPS}`), 'r9-bot-plugins-05-hosted-none', 'Plugins › Custom MCP › Hosted on machines: Add MCP server refused, “Deps bot has no machines yet: add one on its Machines page”', { height: 1000, act: (page) => page.getByText('Hosted on machines', { exact: false }).first().scrollIntoViewIfNeeded() });
await r.session(settings(`page=my-machines&${DEPS}`), async (page, step) => {
  await press(page, 'Cell container');
  await step('r9-bot-machines-02-container', 'Machines › Cell container for Deps bot: named deps-bot-cell, run for Deps bot');
  const d = flow(page, 'cell-container');
  await press(d, 'Continue');
  await press(d, 'Continue');
  await press(d, 'Create container');
  await page.waitForTimeout(1500);
  await step('r9-bot-machines-03-created', 'Created: deps-bot-cell is Deps bot’s; in the audit log');
  await press(d, 'Done');
  await step('r9-bot-machines-04-listed', 'Deps bot’s machines list deps-bot-cell');
  await nav(page, 'my-plugins');
  await page.waitForTimeout(300);
  await press(page, 'Add MCP server');
  await step('r9-bot-plugins-06-hosted-add', 'Plugins › Add MCP server: Deps bot’s own machine hosts a personal server, like a person’s');
}, { height: 1000 });

await r.finish();
