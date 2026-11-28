// Round 7 · secrets and their rules: the team's Secrets, each project's Secrets (with the values it asks of each holder),
// You › My secrets (your own, the old step-ups, and the values projects ask you for), Edit rule (roles, handle,
// delivery: only to approved scripts or a cleared shell with a passkey; an Admin forbidding shells; a holder narrowing
// their own value; the approved scripts a change affects), the step-up into a cleared shell, adding a secret ending
// with its rule, and the live Sessions and person pages reading the merged model. Shots into $OUT as r7-sec-*.png.
import { runner } from './shots-lib.mjs';

const r = await runner('r7-sec-captions.txt');
const settings = (query) => `view=settings&${query}`;
const project = (as, id) => `view=project-settings&project=${id}&page=secrets&as=${as}`;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByLabel(new RegExp(`^(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}){1,2}$`)).fill(value);
const minutes = (scope, value) => scope.getByLabel(/Minutes after each passkey/).first().fill(value);
const chip = (scope, group, name) => scope.getByRole('group', { name: group }).getByRole('button', { name, exact: true }).click();
const wait = (page, ms) => page.waitForTimeout(ms);
const PASSKEY_MS = 1700;

// ── Crumb & Co › Secrets ──
await r.flow(settings('page=secrets&as=maya'), 'r7-sec-team-01-maya', 'Team Secrets as Maya (Owner): every row shows its rule in one line (roles · handle · delivery), sensitive and expiring marks, the approved scripts that use it (CLOUDFLARE_API_TOKEN → deploy-menu-worker), “shell forbidden by an Admin”; Step up on cleared-shell rows; Edit rule and Rotate/Edit on every row', { height: 1900 });
await r.flow(settings('page=secrets&as=theo'), 'r7-sec-team-02-theo', 'Team Secrets as Theo (Admin): the same page, every action live', { height: 1900 });
await r.flow(settings('page=secrets&as=rina'), 'r7-sec-team-03-rina-read-only', 'Team Secrets as Rina (Member): Read only; Add, Edit rule and Rotate dimmed with the reason (“Your account role (Member) can’t manage team secrets”)', { height: 1900 });
await r.flow(settings('page=secrets&as=sam'), 'r7-sec-team-04-sam-refused', 'Sam (Member) presses Edit rule on SENTRY_DSN: refused with the reason, as a tooltip and the app’s toast', {
  height: 1000, act: async (page) => { const button = page.getByRole('button', { name: 'Edit rule for SENTRY_DSN' }); await button.hover(); await button.click({ force: true }); await wait(page, 300); },
});

await r.session(settings('page=secrets&as=theo'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for CLOUDFLARE_API_TOKEN' }).click();
  const d = flow(page, 'edit-rule');
  await step('r7-sec-team-05-rule-who', 'Edit rule · CLOUDFLARE_API_TOKEN, step 1 Who: account roles (“Owners and Admins” picked: Owners always count as Admins) and each project’s roles as chips');
  await chip(d, 'Account roles', 'Owners and Admins');
  await press(d, 'Next');
  await step('r7-sec-team-06-rule-who-error', 'Who, error: with no role picked nobody (and no approved script anyone starts) could use it');
  await chip(d, 'Account roles', 'Owners and Admins');
  await chip(d, 'Project roles in Crumb', 'Leads');
  await press(d, 'Next');
  await step('r7-sec-team-07-rule-delivery-forbidden', 'Step 2 Handle and delivery: only while holding (dropped on Let go); only to approved scripts (default for sensitive); the cleared shell is off because an Admin forbade it, and Theo (Admin) can switch Forbid shell delivery');
  await press(d, 'Next');
  await step('r7-sec-team-08-rule-review', 'Step 3 Review: before and after, and the approved script that uses it (deploy-menu-worker v1, for the team, approved by Theo, last run 3h ago: keeps getting it)');
  await press(d, 'Save rule');
  await step('r7-sec-team-09-rule-saved', 'Saved: the new rule in one line; in the audit log');
  await press(d, 'Done');
  await step('r7-sec-team-10-rule-listed', 'The row now reads “Owners and Admins, Leads in Crumb · only while holding · only to approved scripts”');
}, { height: 1100 });

await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for SENTRY_DSN' }).click();
  const d = flow(page, 'edit-rule');
  await press(d, 'Next');
  await d.locator('[data-choice="shell"]').click();
  await minutes(d, '90');
  await press(d, 'Next');
  await step('r7-sec-team-11-shell-minutes-error', 'SENTRY_DSN · delivery “in a cleared shell with a passkey”, error: between 1 and 60 minutes (longer should be an approved script)');
  await minutes(d, '20');
  await d.getByRole('switch', { name: 'Forbid shell delivery' }).click();
  await step('r7-sec-team-12-forbid-shell', 'Maya (Owner) switches Forbid shell delivery on: the shell card turns off with the reason');
  await press(d, 'Next');
  await step('r7-sec-team-13-forbid-error', 'Error: shell delivery is forbidden for SENTRY_DSN; pick approved scripts, or allow shells again');
  await d.locator('[data-choice="scripts"]').click();
  await press(d, 'Next');
  await step('r7-sec-team-14-forbid-review', 'Review: delivery and “Shell delivery: Allowed → Forbidden by an Admin”; no approved script uses SENTRY_DSN');
  await press(d, 'Save rule');
  await step('r7-sec-team-15-forbid-saved', 'Saved: only approved scripts get SENTRY_DSN, shells forbidden');
}, { height: 1100 });

await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-team-secret');
  await d.locator('[data-choice="login"]').click();
  await step('r7-sec-team-16-add-kind', 'Add a team secret, step 1 Kind: secret or value, service token (scopes checked), login');
  await press(d, 'Next');
  await fill(d, 'Name', 'square login');
  await fill(d, 'Site', 'square up');
  await press(d, 'Next');
  await step('r7-sec-team-17-add-errors', 'Step 2, errors: UPPER_SNAKE_CASE name, the site isn’t a site, username and password required');
  await fill(d, 'Name', 'SQUARE_DASHBOARD');
  await fill(d, 'Site', 'squareup.com');
  await fill(d, 'Username', 'shop@crumbco.example');
  await fill(d, 'Password', 'kiosk-2026-Crumb!');
  await d.getByRole('switch', { name: /Sensitive/ }).click();
  await press(d, 'Next');
  await step('r7-sec-team-18-add-rule', 'Step 3 Rule, defaulting by sensitivity: not sensitive, so a 15-minute cleared shell with a passkey; Owners and Admins; change it now or later');
  await press(d, 'Add SQUARE_DASHBOARD');
  await step('r7-sec-team-19-add-done', 'Added: its rule in one line; rotate it or edit its rule from its row');
}, { height: 1100 });

// ── A project's Secrets ──
await r.flow(project('maya', 'crumb'), 'r7-sec-project-01-maya', 'Crumb › Secrets as Maya (Lead as Owner): project secrets with their rules (DATABASE_URL → seed-staging-db; REDIS_URL a 15-min cleared shell, open for Rina in slot-holds), then “Asked of each holder” (STAGING_LOGIN, FIGMA_TOKEN, SENTRY_AUTH_TOKEN) with who set theirs', { height: 2000 });
await r.flow(project('theo', 'crumb'), 'r7-sec-project-02-theo', 'Crumb › Secrets as Theo (Admin, Lead in Crumb): every action live', { height: 2000 });
await r.flow(project('rina', 'crumb'), 'r7-sec-project-03-rina-engineer', 'Crumb › Secrets as Rina (Engineer): Add and Rotate live, Edit rule dimmed (“only its Leads do”); Step up on REDIS_URL and Drop on her open shell', { height: 2000 });
await r.flow(project('sam', 'crumb'), 'r7-sec-project-04-sam-read-only', 'Crumb › Secrets as Sam (Designer): Read only; every action dimmed with the role that refuses it; Step up refused (Designer isn’t in REDIS_URL’s rule)', { height: 2000 });
await r.flow(project('jules', 'crumb'), 'r7-sec-project-05-jules-refused', 'Crumb › Secrets as Jules (Contributor): not even names: “Your project role in Crumb (Contributor) can’t see project secrets”', { height: 800 });
await r.flow(project('rina', 'ledger'), 'r7-sec-project-06-rina-ledger-lead', 'Ledger › Secrets as Rina (Lead in Ledger): Edit rule live on every row; OPENBANK_CLIENT_SECRET expired with Replace; “shell forbidden by an Admin”', { height: 1300 });

await r.session(project('rina', 'ledger'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for OPENBANK_CLIENT_SECRET' }).click();
  const d = flow(page, 'edit-rule');
  await press(d, 'Next');
  await step('r7-sec-project-07-lead-shell-forbidden', 'Rina (Lead in Ledger, Member account) edits OPENBANK_CLIENT_SECRET: the cleared shell is off (“An Admin forbade shell delivery”), and the Forbid switch is hers to read, not change (“Only Owners and Admins forbid shell delivery”)');
}, { height: 1100 });

await r.session(project('theo', 'crumb'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for DATABASE_URL' }).click();
  const d = flow(page, 'edit-rule');
  await chip(d, 'Project roles in Crumb', 'Engineers');
  await step('r7-sec-project-08-rule-narrow-roles', 'Theo edits DATABASE_URL’s rule: Engineers off, Leads only');
  await press(d, 'Next');
  await press(d, 'Next');
  await step('r7-sec-project-09-affected-scripts', 'Review warns: seed-staging-db (v2, for Crumb, approved by Theo) uses DATABASE_URL, and runs started by Rina will fail (she ran it today 08:02)');
  await press(d, 'Save rule');
  await step('r7-sec-project-10-rule-saved', 'Saved: Leads in Crumb · only while holding · only to approved scripts; in the audit log');
}, { height: 1100 });

await r.session(project('rina', 'crumb'), async (page, step) => {
  await page.getByRole('button', { name: 'Step up REDIS_URL' }).click();
  const d = flow(page, 'step-up-now');
  await step('r7-sec-project-11-step-up', 'Step up REDIS_URL as Rina: a cleared shell for 15 min with a passkey, only her turns; pick a Crumb workspace she holds');
  await press(d, 'Unlock with passkey');
  await step('r7-sec-project-12-step-up-already-open', 'Error: already open in slot-holds with 9 min left; drop it first, or use the one that’s open');
  await d.locator('[data-choice="slot-picker-ui"]').click();
  await press(d, 'Unlock with passkey');
  await step('r7-sec-project-13-step-up-passkey', 'Passkey: waiting for Rina’s security key');
  await wait(page, PASSKEY_MS);
  await step('r7-sec-project-14-step-up-done', 'Open in slot-picker-ui: a fresh shell with only REDIS_URL added, closed after 15 min, on Drop or on Let go; in the audit log');
  await press(d, 'Done');
  await step('r7-sec-project-15-two-shells', 'The row shows both of Rina’s open shells, each with Drop');
}, { height: 1100 });

await r.session(project('maya', 'crumb'), async (page, step) => {
  await page.getByRole('button', { name: 'Add', exact: true }).first().click();
  const d = flow(page, 'add-secret');
  await d.locator('[data-choice="token"]').click();
  await step('r7-sec-project-16-add-kind', 'Add to Crumb, step 1 Kind: secret, value, API token, login (one flow for what were secrets and workspace credentials)');
  await press(d, 'Next');
  await fill(d, 'Name', 'STRIPE_WEBHOOK_KEY');
  await fill(d, 'Service host', 'api.stripe.com');
  await fill(d, 'Token', ['sk', 'live', 'x'.repeat(16)].join('_'));
  await press(d, 'Next');
  await step('r7-sec-project-17-add-live-key', 'Step 2, error: a live Stripe key; projects keep test keys only');
  await fill(d, 'Token', ['rk', 'test', 'x'.repeat(19)].join('_'));
  await press(d, 'Next');
  await step('r7-sec-project-18-add-rule', 'Step 3 Rule: sensitive, so only to approved scripts; Leads and Engineers in Crumb; only while holding');
  await press(d, 'Save to Crumb');
  await step('r7-sec-project-19-add-done', 'Saved to Crumb with its rule; in the audit log');
}, { height: 1100 });

await r.session(project('rina', 'crumb'), async (page, step) => {
  await press(page, 'Preview secure input’s Save to…');
  const d = flow(page, 'save-to');
  await step('r7-sec-project-20-save-to', 'Secure input’s Save to, as Rina: the team secret refused by her account role; Crumb’s secret STAGING_RINA; or her own STAGING_LOGIN value');
  await press(d, 'Save');
  await step('r7-sec-project-21-save-to-done', 'Saved as Crumb’s secret STAGING_RINA: only approved scripts get it to start');
}, { height: 1000 });

// ── You › My secrets ──
await r.flow(settings('page=my-secrets&as=maya'), 'r7-sec-you-01-maya', 'You › My secrets as Maya: her own secrets (NPM_TOKEN open in checkout-apple-pay, GITHUB_ADMIN_TOKEN) each “Only Maya · only while holding · in a cleared shell for N min with a passkey”, then the values projects ask her for with Crumb’s rule', { height: 1500 });
await r.flow(settings('page=my-secrets&as=rina'), 'r7-sec-you-02-rina', 'You › My secrets as Rina: AWS_SANDBOX open in slot-holds; her values with Crumb’s rules (SENTRY_AUTH_TOKEN a 30-min shell) and Edit rule to narrow', { height: 1500 });
await r.flow(settings('page=my-secrets&as=sam'), 'r7-sec-you-03-sam', 'You › My secrets as Sam: no own secrets yet; STAGING_LOGIN missing, FIGMA_TOKEN set, each with Crumb’s rule', { height: 1200 });

await r.session(settings('page=my-secrets&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Step up GITHUB_ADMIN_TOKEN' }).click();
  const d = flow(page, 'step-up-now');
  await step('r7-sec-you-04-step-up', 'The merged step-up: GITHUB_ADMIN_TOKEN, in a cleared shell for 15 min with a passkey; pick a workspace Maya holds');
  await press(d, 'Unlock with passkey');
  await step('r7-sec-you-05-step-up-passkey', 'Waiting for Maya’s passkey');
  await wait(page, PASSKEY_MS);
  await step('r7-sec-you-06-step-up-done', 'Cleared shell for 15 min in slot-holds, Maya’s turns only; closes on Drop or Let go');
  await press(d, 'Done');
  await page.getByRole('button', { name: 'Drop GITHUB_ADMIN_TOKEN in slot-holds' }).click();
  await step('r7-sec-you-07-drop', 'Drop it early: the shell closes now');
  await press(flow(page, 'drop-step-up'), 'Drop');
  await step('r7-sec-you-08-dropped', 'Dropped');
}, { height: 1100 });

await r.session(settings('page=my-secrets&as=rina'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for SENTRY_AUTH_TOKEN' }).click();
  const d = flow(page, 'edit-rule');
  await step('r7-sec-you-09-narrow', 'Rina narrows the rule for her own SENTRY_AUTH_TOKEN: Crumb’s rule bounds it (holding is already required; a shell of 30 min at most)');
  await minutes(d, '45');
  await press(d, 'Next');
  await step('r7-sec-you-10-narrow-widen-error', 'Error: Crumb’s rule allows 30 min at most; she can narrow it, not widen it');
  await minutes(d, '10');
  await press(d, 'Next');
  await step('r7-sec-you-11-narrow-review', 'Review: a 30-min shell becomes 10 min, for her value only');
  await press(d, 'Save rule');
  await step('r7-sec-you-12-narrow-saved', 'Saved: “Narrowed by you” on her row; Crumb’s rule for everyone else is unchanged');
  await press(d, 'Done');
  await page.getByRole('button', { name: 'Edit rule for STAGING_LOGIN' }).click();
  await step('r7-sec-you-13-narrow-autofill-only', 'STAGING_LOGIN: Crumb has the browser fill it on staging.crumb.example, so the shell is off for her too (“you can narrow its rule for your value, not widen it”); autofill or approved scripts only');
}, { height: 1100 });

// ── Live pages ──
await r.flow('view=sessions&as=theo&who=everyone', 'r7-sec-live-01-sessions', 'Sessions as Theo (Everyone): “Cleared shells open” stat and “Cleared shells counting down”: AWS_SANDBOX and REDIS_URL (Rina), NPM_TOKEN (Maya), GOOGLE_DRIVE_TOKEN (Theo), each with what it unlocks and Drop', { height: 1800 });
await r.flow('view=person&person=rina&as=theo', 'r7-sec-live-02-person', 'Rina’s page as Theo: Own secrets (AWS_SANDBOX with its rule), Cleared shells open (Drop), Values projects asked for with their rules', { height: 1800 });

await r.finish();
