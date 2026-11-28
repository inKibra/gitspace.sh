// Bot flows: You › Bots you sponsor, a bot's settings pages (Bot · name: Profile with Roles and projects, Activity and
// Audit; Sign-ins; Git identity) with every dialog and wizard step, its error states and success; Create bot; a Member
// refused; the sponsor's approval in Needs you. Shots into $OUT as f-bot-*.png with captions in f-bot-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('f-bot-captions.txt');
const settings = (query) => `view=settings&${query}`;
const PASSKEY_MS = 1700;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).click();
// InputField's label repeats its text in a hidden span, so labels match by substring within the dialog.
const fill = (scope, label, value) => scope.getByLabel(label).first().fill(value);
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
async function pick(page, trigger, option) {
  await page.getByRole('combobox', { name: trigger }).or(page.getByLabel(trigger, { exact: true })).first().click();
  await page.getByRole('option', { name: option }).first().click();
}

// ── Crumb & Co › Bots: the ones you sponsor first ──
await r.flow(settings('page=bots&as=theo'), 'f-bot-sponsored-01-theo', 'Crumb & Co › Bots as Theo: Bots you sponsor on top (Release bot with its state, projects, sign-ins, its own secrets, requests waiting for him, last activity; Open), then every bot', { height: 1400 });
await r.flow(settings('page=bots&as=maya'), 'f-bot-sponsored-02-maya', 'Crumb & Co › Bots as Maya (Owner): Bots you sponsor (Deps bot) on top', { height: 1400 });
await r.flow(settings('page=bots&as=sam'), 'f-bot-sponsored-03-sam-member', 'Sam (Member) sponsors none: no Bots you sponsor section; New bot refused with the reason', { height: 1100 });
await r.flow(settings('page=bots&as=theo'), 'f-bot-sponsored-04-opens-page', 'Open from Bots you sponsor: “Settings for” switches to Release bot and its Profile opens', { height: 3600, act: (page) => page.getByRole('button', { name: 'Open Release bot' }).first().click() });

// ── The bot page as Theo, its sponsor ──
await r.flow(settings('page=bots&person=release-bot&as=theo'), 'f-bot-page-01-release-full', 'Release bot as Theo (its sponsor), page=bots&person=release-bot: its Profile page (Profile, Roles and projects, Activity, Audit) under Bot · Release bot', { height: 3600 });

// Profile › Edit
await r.session(settings('page=bots&person=release-bot&as=theo'), async (page, step) => {
  await press(page, 'Edit profile');
  const d = flow(page, 'bot-edit');
  await step('f-bot-profile-01-edit', 'Edit profile: name, fixed handle, what it does, notes, avatar colour');
  await fill(d, 'Name', 'Deps bot');
  await press(d, 'Save');
  await step('f-bot-profile-02-error', 'Edit profile, error: another bot already has that name');
  await fill(d, 'Name', 'Release bot');
  await d.locator('textarea').nth(1).fill('Publishes @crumbco/* to npm only from Ship, with Theo’s approval each time. Ask Theo before widening its slice.');
  await d.getByRole('radio', { name: 'Colour #0b7285' }).click();
  await press(d, 'Save');
  await step('f-bot-profile-03-saved', 'Edit profile, success: saved; its actions read “Release bot (sponsored by Theo)”');
}, { height: 1000 });

// Roles and projects › Edit roles
await r.session(settings('page=bots&person=release-bot&as=theo'), async (page, step) => {
  await press(page, 'Edit roles');
  const d = flow(page, 'bot-roles');
  await step('f-bot-roles-01-dialog', 'Edit roles: one row per project Theo can see; he gives roles within his own (Lead in both)');
  await pick(page, 'Release bot’s project role in Crumb', 'Not a member');
  await pick(page, 'Release bot’s project role in Ledger', 'Not a member');
  await press(d, 'Save roles');
  await step('f-bot-roles-02-error', 'Edit roles, error: a bot needs at least one project; to stop it, revoke its sign-ins');
  await pick(page, 'Release bot’s project role in Crumb', 'Engineer');
  await pick(page, 'Release bot’s project role in Ledger', 'Contributor');
  await press(d, 'Save roles');
  await step('f-bot-roles-03-saved', 'Edit roles, success: Contributor in Ledger (was Engineer); in the audit log');
}, { height: 1000 });
await r.flow(settings('page=bots&person=release-bot&as=theo'), 'f-bot-roles-04-account-role-refused', 'Account role Change refused with the reason: a bot’s account role is Member, fixed', { height: 1000, act: async (page) => {
  await scrollTo(page, '[data-bot-role]');
  await page.getByRole('button', { name: 'Change', exact: true }).click({ force: true });
} });

// Sign-ins › Connect a client
await r.session(settings('page=passkeys&person=release-bot&as=theo'), async (page, step) => {
  await press(page, 'Connect a client');
  const d = flow(page, 'bot-connect');
  await step('f-bot-connect-01-code', 'Connect a client, step 1 Code: the client ran /mcp and shows a code; Theo enters it');
  await fill(d, 'Code the client shows', 'ABCD-0000');
  await press(d, 'Next');
  await step('f-bot-connect-02-wrong-code', 'Connect, error: no sign-in waits with that code; codes expire after 10 minutes, run /mcp again');
  await fill(d, 'Code the client shows', 'KTRW-4821');
  await press(d, 'Next');
  await step('f-bot-connect-03-connect-as', 'Connect, step 2: Connect as Release bot, or as Theo himself');
  await press(d, 'Next');
  await step('f-bot-connect-04-slice', 'Connect, step 3 Slice: its projects and capabilities, its roles the ceiling');
  await d.getByRole('button', { name: 'Crumb', exact: true }).click();
  await d.getByRole('button', { name: 'Ledger', exact: true }).click();
  await press(d, 'Next');
  await step('f-bot-connect-05-slice-error', 'Connect, error: pick at least one project');
  await d.getByRole('button', { name: 'Crumb', exact: true }).click();
  await press(d, 'Next');
  await press(d, 'Approve with passkey');
  await step('f-bot-connect-06-passkey', 'Connect, step 4 Passkey: summary, waiting for Theo’s passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-bot-connect-07-done', 'Connect, success: Claude Code on build-02 acts as Release bot');
}, { height: 1000 });

// Sign-ins › Create client secret
await r.session(settings('page=passkeys&person=release-bot&as=theo'), async (page, step) => {
  await press(page, 'Create client secret');
  const d = flow(page, 'bot-secret');
  await step('f-bot-secret-01-label', 'Client secret, step 1 Label');
  await fill(d, 'Label', 'release-ci');
  await press(d, 'Next');
  await step('f-bot-secret-02-label-error', 'Client secret, error: Release bot already has release-ci');
  await fill(d, 'Label', 'nightly-ci');
  await press(d, 'Next');
  await step('f-bot-secret-03-slice', 'Client secret, step 2 Slice');
  await press(d, 'Next');
  await press(d, 'Create with passkey');
  await step('f-bot-secret-04-passkey', 'Client secret, step 3 Passkey: waiting');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-bot-secret-05-shown-once', 'Client secret, step 4: client ID and the secret, shown once, with the token exchange');
  await press(d, 'I’ve copied it');
  await step('f-bot-secret-06-done', 'Client secret, success: Release bot signs in with nightly-ci');
}, { height: 1000 });

// Sign-ins › Edit slice, Revoke
await r.session(settings('page=passkeys&person=release-bot&as=theo'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit the slice of release-ci' }).click();
  const d = flow(page, 'bot-slice');
  await step('f-bot-slice-01-dialog', 'Edit slice of release-ci');
  for (const name of ['read', 'comment']) await d.getByRole('button', { name, exact: true }).click();
  await press(d, 'Save slice');
  await step('f-bot-slice-02-error', 'Edit slice, error: pick at least one capability');
  for (const name of ['read', 'comment', 'move phases']) await d.getByRole('button', { name, exact: true }).click();
  await press(d, 'Save slice');
  await step('f-bot-slice-03-saved', 'Edit slice, success');
  await press(d, 'Done');
  await page.getByRole('button', { name: 'Revoke release-ci' }).click();
  const v = flow(page, 'bot-revoke');
  await step('f-bot-revoke-01-confirm', 'Revoke release-ci? What stops working');
  await press(v, 'Revoke');
  await step('f-bot-revoke-02-done', 'Revoke, success: Release bot can’t sign in with release-ci');
}, { height: 1000 });

// Git identity
await r.session(settings('page=git&person=release-bot&as=theo'), async (page, step) => {
  await scrollTo(page, '[data-bot-author]');
  await step('f-bot-git-01-section', 'Git identity: commit author release-bot@bots.crumbco.gitspace.sh (default), through the team’s GitHub App');
  await page.getByRole('button', { name: 'Edit the commit author' }).click();
  const d = flow(page, 'bot-author');
  await fill(d, 'Author email', 'release-bot at crumbco');
  await press(d, 'Save');
  await step('f-bot-git-02-author-error', 'Commit author, error: that isn’t an email address');
  await fill(d, 'Author email', '231907+crumbco-release@users.noreply.github.com');
  await press(d, 'Save');
  await step('f-bot-git-03-author-done', 'Commit author, success');
  await press(d, 'Done');
  await press(page, 'Use its own GitHub account');
  const m = flow(page, 'bot-machine-user');
  await fill(m, 'GitHub account', 'crumbco_release!');
  await press(m, 'Next');
  await step('f-bot-git-04-account-error', 'Own GitHub account, step 1 Account, error: not a GitHub username');
  await fill(m, 'GitHub account', 'crumbco-release');
  await press(m, 'Next');
  await step('f-bot-git-05-token', 'Step 2 Token: where to make a fine-grained token and which permissions');
  await fill(m, 'Fine-grained token', ['ghp', 'x'.repeat(36)].join('_'));
  await press(m, 'Check permissions');
  await step('f-bot-git-06-classic-error', 'Token, error: a classic token reaches every repository; use a fine-grained one');
  await fill(m, 'Fine-grained token', 'github_pat_11BREL0readonly');
  await press(m, 'Check permissions');
  await page.waitForTimeout(1100);
  await step('f-bot-git-07-missing-scope', 'Step 3 Check permissions, error: missing pull_requests:write, and how to fix it on GitHub');
  await press(m, 'Paste another token');
  await fill(m, 'Fine-grained token', 'github_pat_11BREL0expired');
  await press(m, 'Check permissions');
  await page.waitForTimeout(1100);
  await step('f-bot-git-08-expired', 'Check permissions, error: the token expired Nov 1; regenerate it');
  await press(m, 'Paste another token');
  await fill(m, 'Fine-grained token', 'github_pat_11BREL0aX9kQ2wLm7Zt4');
  await press(m, 'Check permissions');
  await page.waitForTimeout(1100);
  await step('f-bot-git-09-check-ok', 'Check permissions: contents:write and pull_requests:write granted');
  await press(m, 'Connect');
  await step('f-bot-git-10-done', 'Own GitHub account, success: pull requests show as crumbco-release');
}, { height: 1000 });
await r.session(settings('page=git&person=deps-bot&as=maya'), async (page, step) => {
  await scrollTo(page, '[data-bot-author]');
  await step('f-bot-git-11-deps-machine-user', 'Deps bot as Maya: it reaches GitHub through its own account crumbco-deps');
  await press(page, 'Use the GitHub App');
  await step('f-bot-git-12-use-app-confirm', 'Switch Deps bot to the GitHub App? Its token is deleted');
  await press(flow(page, 'bot-use-app'), 'Use the GitHub App');
  await step('f-bot-git-13-use-app-done', 'Back on the GitHub App: pull requests show as crumbco-gitspace[bot]');
}, { height: 1000 });

// Activity and Audit
await r.flow(settings('page=bots&person=release-bot&as=theo'), 'f-bot-activity-01', 'Activity: turns, commits with their sha, comments and phase moves, each with its workspace', { height: 1000, act: (page) => scrollTo(page, '[data-bot-activity]') });
await r.flow(settings('page=bots&person=release-bot&as=theo'), 'f-bot-audit-01', 'Audit: its entries; Open in the audit log', { height: 1000, act: (page) => scrollTo(page, '[data-bot-audit]') });
await r.flow(settings('page=bots&person=release-bot&as=theo'), 'f-bot-audit-02-filtered', 'Open in the audit log: the log filtered to Release bot', { height: 1100, act: (page) => page.getByRole('button', { name: 'Open in the audit log' }).click() });

// ── Maya: Deps bot and the Create bot wizard ──
await r.flow(settings('page=bots&person=deps-bot&as=maya'), 'f-bot-page-02-deps-maya', 'Deps bot as Maya (Owner, its sponsor): its Profile page under Bot · Deps bot', { height: 3600 });
await r.session(settings('page=bots&as=maya'), async (page, step) => {
  await press(page, 'New bot');
  const d = flow(page, 'bot-create');
  await step('f-bot-create-01-name', 'New bot, step 1 Name: name, handle (derived, lowercase, “-bot”), what it does');
  await fill(d, 'Name', 'Docs');
  await fill(d, 'Handle', 'Docs_Bot');
  await press(d, 'Next');
  await step('f-bot-create-02-name-errors', 'New bot, errors: handle lowercase with hyphens only; say what it does');
  await fill(d, 'Handle', 'release-bot');
  await d.getByLabel('What it does').fill('Keeps the docs site in step with merged pull requests.');
  await press(d, 'Next');
  await step('f-bot-create-03-handle-taken', 'New bot, error: release-bot is taken');
  await fill(d, 'Handle', 'docs-bot');
  await press(d, 'Next');
  await step('f-bot-create-04-sponsor', 'Step 2 Sponsor: Maya by default; Owners and Admins may pick another Admin or Owner');
  await d.locator('[data-choice="theo"]').click();
  await press(d, 'Next');
  await press(d, 'Next');
  await step('f-bot-create-05-roles-error', 'Step 3 Roles: account role Member, fixed; project roles within Maya’s own; error: at least one project');
  await pick(page, 'Docs’s project role in Crumb', 'Contributor');
  await pick(page, 'Docs’s project role in Field notes', 'Viewer');
  await step('f-bot-create-06-roles', 'Roles picked: Contributor in Crumb, Viewer in Field notes');
  await press(d, 'Next');
  await d.locator('[data-choice="secret"]').click();
  await step('f-bot-create-07-first-sign-in', 'Step 4 First sign-in: connect a client now, create a client secret now, or later');
  await press(d, 'Next');
  await press(d, 'Create with passkey');
  await step('f-bot-create-08-passkey', 'Step 5 Passkey: summary, waiting for Maya’s passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-bot-create-09-done', 'New bot, success: Docs (sponsored by Theo), with its client secret shown once');
  await press(d, 'Open its page');
  await page.waitForTimeout(400);
  await step('f-bot-create-10-page', 'Open its page: Bot · Docs › Profile, sponsored by Theo, managed by Maya as Owner');
}, { height: 1000 });

// ── Refused ──
await r.flow(settings('page=bots&person=release-bot&as=sam'), 'f-bot-refused-01-sam-page', 'Sam (Member) opening Release bot: refused; only Theo (its sponsor), Owners and Admins open a bot', { height: 900 });
await r.flow(settings('page=bots&as=sam'), 'f-bot-refused-02-sam-list', 'Crumb & Co › Bots as Sam: read only; Roles, Open and New bot say why', { height: 1500, act: (page) => page.getByRole('button', { name: 'Open Release bot' }).click({ force: true }) });

// ── The sponsor's Needs you ──
const board = 'as=theo&mode=board&group=state&arrive=never';
await r.session(board, async (page, step) => {
  const row = page.locator('[data-account-item="acc-bot-secret"]');
  await row.scrollIntoViewIfNeeded();
  await step('f-bot-approve-01-needs-you', 'Theo’s Needs you: “Release bot asks for NPM_PUBLISH_TOKEN in release-2026-11”, one of its own secrets whose rule waits for its sponsor (Open its secrets, Deny, Approve with passkey)');
  await row.locator('xpath=..').getByRole('button', { name: 'Approve with passkey' }).click();
  await step('f-bot-approve-02-passkey', 'Approve with passkey: waiting for Theo’s passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-bot-approve-03-resolved', 'Approved: NPM_PUBLISH_TOKEN goes to release-2026-11’s approved script for this turn only, with Undo');
}, { height: 1000 });
await r.flow('as=maya&mode=board&group=state&arrive=never', 'f-bot-approve-04-maya-not-sent', 'Maya’s Needs you (Owner, not Release bot’s sponsor): the request isn’t there; it goes to the sponsor only', { height: 1000, act: async (page) => {
  if (await page.locator('[data-account-item="acc-bot-secret"]').count()) throw new Error('the bot secret request reached Maya');
} });

await r.finish();
