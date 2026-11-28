// Project settings flows: Members (add, change role, remove, a refusal), Repositories (Connect repositories from the
// GitHub App, another Git host and a public URL; remove), Inference and Plugins changes, Secrets (add a secret, value,
// token or login with its rule; secure input's Save to), Automations (new, enable, pause), the team Projects page (Join project,
// New project) and the Projects grid's New project. Every wizard step, error and success state. Environment's flows
// are in shots-r7-env.mjs. Shots into $OUT as f-proj-*.png with captions in f-proj-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('f-proj-captions.txt');
const ps = (as, project, page) => `as=${as}&view=project-settings&project=${project}&page=${page}`;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
// InputField's label carries a hidden twin of its text, so text fields are found by role and name; password fields
// (not textboxes) and text areas by label.
const fill = (scope, label, value) => scope.getByRole('textbox', { name: label, exact: true }).or(scope.getByLabel(label)).first().fill(value);
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
async function pick(page, trigger, option) {
  await page.getByRole('combobox', { name: trigger }).or(page.getByLabel(trigger, { exact: true })).first().click();
  await page.getByRole('option', { name: option }).first().click();
}
const H = { height: 1000 };

// ── Members ──
await r.session(ps('rina', 'ledger', 'members'), async (page, step) => {
  await press(page, 'Add member');
  const d = flow(page, 'add-member');
  await step('f-proj-members-01-add-people', 'Add member as Rina (Ledger’s Lead), step 1 People: Maya is an Owner (Lead already), Theo and the bots already members, Support triage bot blocked without a sponsor');
  await press(d, 'Next');
  await step('f-proj-members-02-add-none-error', 'Add member, error: nobody picked');
  await d.locator('[data-pick="sam"]').click();
  await d.locator('[data-pick="jules"]').click();
  await press(d, 'Next');
  await step('f-proj-members-03-add-role', 'Add member, step 2 Project role: Rina is Lead, so Lead is offered; Contributor picked');
  await press(d, 'Next');
  await step('f-proj-members-04-add-review', 'Add member, step 3 Review: who, project, role, what they can do, the audit line');
  await press(d, 'Add 2 members');
  await step('f-proj-members-05-add-success', 'Add member, success: Sam and Jules are Contributors in Ledger');
}, H);
await r.session(ps('maya', 'field-notes', 'members'), async (page, step) => {
  await press(page, 'Add member');
  const d = flow(page, 'add-member');
  await d.locator('[data-pick="deps-bot"]').click();
  await press(d, 'Next');
  await step('f-proj-members-06-add-bot-no-lead', 'Add member as Maya in Field notes with Deps bot picked: Lead is refused for a bot, with the reason');
}, H);
await r.session(ps('sam', 'crumb', 'members'), async (page, step) => {
  await press(page, 'Add member');
  await step('f-proj-members-07-sam-refused', 'Sam (Designer in Crumb) presses Add member: refused, “Your project role in Crumb (Designer) can’t manage members”, and who can');
}, H);
await r.session(ps('maya', 'crumb', 'members'), async (page, step) => {
  await pick(page, 'Project role for Jules Moreau', 'Engineer');
  await step('f-proj-members-08-change-role', 'Change Jules’s role Contributor → Engineer: what it gains and loses');
  await press(flow(page, 'change-role'), 'Change role');
  await step('f-proj-members-09-change-role-success', 'Change role, success: Jules is Engineer in Crumb; recorded under Maya');
  await press(flow(page, 'change-role'), 'Done');
  await page.getByRole('button', { name: 'Remove Sam Lee from Crumb' }).click();
  await step('f-proj-members-10-remove', 'Remove Sam from Crumb: releases loyalty-stamps, detaches Sam’s own resources');
  await press(flow(page, 'remove-member'), 'Remove from Crumb');
  await step('f-proj-members-11-remove-success', 'Remove, success: Sam is no longer in Crumb; loyalty-stamps is free');
}, H);
await r.session(ps('theo', 'crumb', 'members'), async (page, step) => {
  await pick(page, 'Project role for Jules Moreau', 'Lead');
  await step('f-proj-members-12-change-to-lead', 'Theo (Admin, Lead in Crumb) makes Jules Lead: gains manage members, settings, approvals…');
}, H);

// ── Team Projects page ──
await r.session('as=theo&view=settings&page=projects', async (page, step) => {
  await press(page, 'Join project');
  const d = flow(page, 'join-project');
  await step('f-proj-projects-01-join', 'Join project as Theo (Admin, not in Field notes): pick a project role; the member-list mark and the audit line it writes');
  await choose(d, 'engineer');
  await press(d, 'Join as Engineer');
  await step('f-proj-projects-02-join-success', 'Join project, success: Theo is Engineer in Field notes; “Joined just now · Admin” and the audit line');
}, H);
await r.session('as=maya&view=settings&page=projects', async (page, step) => {
  await press(page, 'New project');
  const d = flow(page, 'new-project');
  await step('f-proj-projects-03-new-project', 'New project from Settings › Projects, step 1 Project: name, base branch, a repository the App covers');
  await fill(d, 'Name', 'Crumb');
  await press(d, 'Next');
  await step('f-proj-projects-04-new-name-error', 'New project, error: Crumb & Co already has a project named Crumb');
  await fill(d, 'Name', 'Bakery site');
  await press(d, 'Next');
  await step('f-proj-projects-05-new-source', 'New project, step 2 Source: the same Connect repositories steps');
  await press(d, 'Next');
  await step('f-proj-projects-06-new-repositories', 'New project, step 3 Repositories: optional here, “Skip: no extra repositories”');
  await press(d, 'Skip: no extra repositories');
  await press(d, 'Next');
  await step('f-proj-projects-07-new-review', 'New project, step 5 Review: the project, its repository, you as Lead, no extra repositories');
  await press(d, 'Create project');
  await step('f-proj-projects-08-new-success', 'New project, success: Bakery site is created, Maya is its Lead; next: its Environment');
}, H);
await r.session('as=maya&view=projects', async (page, step) => {
  await page.getByRole('button', { name: 'New project' }).last().click();
  const d = flow(page, 'new-project');
  await fill(d, 'Name', 'Catering');
  await press(d, 'Next');
  await choose(d, 'host');
  await press(d, 'Next');
  await d.locator('[data-repository-choice="gitlab.crumbco.example/ops/terraform"]').click();
  await step('f-proj-grid-01-new-connect', 'Projects grid › New project, Repositories from another Git host (gitlab.crumbco.example) through team machines; terraform picked');
  await press(d, 'Next');
  await step('f-proj-grid-02-new-placement', 'New project, In workspaces: where terraform is cloned and on which branch');
  await press(d, 'Next');
  await step('f-proj-grid-03-new-review', 'New project, Review: Catering from bakery-site with terraform at repos/terraform');
}, H);

// ── Repositories ──
await r.session(ps('maya', 'crumb', 'repositories'), async (page, step) => {
  await press(page, 'Add repository');
  const d = flow(page, 'add-repository');
  await step('f-proj-repos-01-source', 'Add repository › Connect repositories, step 1 Source: GitHub App installation, another Git host through team machines, or a public URL');
  await press(d, 'Next');
  await step('f-proj-repos-02-choose', 'Step 2 Repositories (crumb-co installation): search; reach per repository; stripe-samples/apple-pay-js isn’t covered, shows the fix and can’t be picked');
  await press(d, 'Next');
  await step('f-proj-repos-03-none-error', 'Repositories, error: none picked');
  await fill(d, 'Search', 'bakery');
  await d.locator('[data-repository-choice="github.com/crumb-co/bakery-site"]').click();
  await press(d, 'Next');
  await fill(d, 'Path in the workspace', '../bakery');
  await step('f-proj-repos-04-placement-error', 'Step 3 In workspaces, error: the path must stay inside the workspace');
  await fill(d, 'Path in the workspace', 'repos/bakery-site');
  await fill(d, 'Branch', 'main');
  await step('f-proj-repos-05-placement', 'Step 3 In workspaces: path repos/bakery-site on main');
  await press(d, 'Next');
  await step('f-proj-repos-06-review', 'Step 4 Review: path, branch and how it’s reached');
  await press(d, 'Connect 1');
  await step('f-proj-repos-07-success', 'Connect repositories, success: bakery-site connected to Crumb');
  await press(d, 'Done');
  await step('f-proj-repos-08-list', 'Repositories after connecting: bakery-site with its path and branch');
}, { height: 1100 });
await r.session(ps('maya', 'crumb', 'repositories'), async (page, step) => {
  await press(page, 'Add repository');
  const d = flow(page, 'add-repository');
  await choose(d, 'host');
  await pick(page, 'Host', /^git\.sr\.ht/);
  await step('f-proj-repos-09-host-source', 'Source: another Git host, git.sr.ht (team key not registered there)');
  await press(d, 'Next');
  await press(d, 'I’ve registered it: check again');
  await step('f-proj-repos-10-host-check-failed', 'git.sr.ht/~crumb/menu-fonts can’t be reached: the fix, and Check again still fails with Permission denied, with the team key to add');
  await fill(d, 'Another repository on this host', 'git@gitlab.crumbco.example:ops/infra.git');
  await press(d, 'Check from a team machine');
  await step('f-proj-repos-11-host-wrong-host', 'Another repository on this host, error: the address is on gitlab.crumbco.example, not git.sr.ht');
}, H);
await r.session(ps('maya', 'crumb', 'repositories'), async (page, step) => {
  await press(page, 'Add repository');
  const d = flow(page, 'add-repository');
  await choose(d, 'public');
  await press(d, 'Next');
  await fill(d, 'Repository URL', 'https://github.com/crumb-labs/secret-recipes');
  await press(d, 'Check URL');
  await page.waitForTimeout(1100);
  await step('f-proj-repos-12-public-private', 'Public URL, error: the repository isn’t public (404 without signing in), with what to do');
  await fill(d, 'Repository URL', 'https://github.com/stripe-samples/apple-pay-js');
  await press(d, 'Check URL');
  await page.waitForTimeout(1100);
  await step('f-proj-repos-13-public-found', 'Public URL found: read only over HTTPS on every machine');
}, H);
await r.session(ps('theo', 'ledger', 'repositories'), async (page, step) => {
  await page.getByRole('button', { name: 'Remove bitbucket.org/openbank/sandbox-fixtures' }).click();
  await step('f-proj-repos-14-remove', 'Remove repository as Theo in Ledger: Ledger’s Instructions tell agents to clone it, so edit them in Environment too');
  await press(flow(page, 'remove-repository'), 'Remove');
  await step('f-proj-repos-15-remove-success', 'Remove repository, success');
}, H);

// ── Inference and plugins ──
await r.session(ps('maya', 'crumb', 'inference'), async (page, step) => {
  await pick(page, 'Inference profile', 'Ledger (team keys only)');
  await step('f-proj-inference-01-change', 'Inference profile change: models, team providers and holders’ own providers before → after');
  await press(flow(page, 'inference-profile'), 'Use Ledger (team keys only)');
  await step('f-proj-inference-02-success', 'Inference profile change, success: new turns use it; recorded in the audit log');
}, H);
await r.session(ps('maya', 'crumb', 'plugins'), async (page, step) => {
  await page.getByRole('switch', { name: 'Jira on in Crumb' }).click();
  await step('f-proj-plugins-01-off', 'Turn Jira off in Crumb: its tools leave the open workspaces on their next turn');
  await press(flow(page, 'plugin-toggle'), 'Turn off');
  await step('f-proj-plugins-02-success', 'Plugin toggle, success');
  await press(flow(page, 'plugin-toggle'), 'Done');
  await page.getByRole('switch', { name: 'Holders’ own plugins allowed' }).click();
  await step('f-proj-plugins-03-holders', 'Turn holders’ own plugins off in Crumb: what stops joining');
}, H);

// ── Secrets ──
await r.session(ps('maya', 'crumb', 'secrets'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-secret');
  await step('f-proj-secrets-01-add', 'Add to Crumb, step 1 Kind: secret, value, API token or login; the write target is Crumb');
  await press(d, 'Next');
  await fill(d, 'Name', 'redis url');
  await press(d, 'Next');
  await step('f-proj-secrets-02-errors', 'Step 2, errors: name format and a missing value');
  await fill(d, 'Name', 'SENTRY_DSN');
  await fill(d, 'Secret value', 'https://8f2c@o1.ingest.sentry.io/42');
  await step('f-proj-secrets-03-overrides', 'Step 2: SENTRY_DSN overrides the team’s in Crumb');
  await press(d, 'Next');
  await press(d, 'Save to Crumb');
  await step('f-proj-secrets-04-success', 'Saved to Crumb with its rule, overriding the team’s');
  await press(d, 'Done');
  await step('f-proj-secrets-05-list', 'Crumb’s Secrets with the new SENTRY_DSN and its rule');
}, H);
await r.session(ps('sam', 'crumb', 'secrets'), async (page, step) => {
  await press(page, 'Add');
  await step('f-proj-secrets-06-sam-refused', 'Sam (Designer) presses Add: refused, Designer can’t edit project secrets; who can');
}, H);

// ── Tokens and logins (what were workspace credentials) ──
await r.session(ps('maya', 'crumb', 'secrets'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-secret');
  await choose(d, 'token');
  await step('f-proj-cred-01-kind', 'Add to Crumb, step 1 Kind: an API token');
  await press(d, 'Next');
  await press(d, 'Next');
  await step('f-proj-cred-02-kind-errors', 'Step 2, errors: name, host and token required');
  await fill(d, 'Name', 'STRIPE_SECRET_KEY');
  await fill(d, 'Service host', 'api.stripe.com');
  await fill(d, 'Token', ['sk', 'live', '51Hc0ffee'].join('_'));
  await step('f-proj-cred-03-value', 'Step 2 Value: name, host and the token through secure input');
  await press(d, 'Next');
  await step('f-proj-cred-04-value-errors', 'Step 2, errors: Crumb already has STRIPE_SECRET_KEY (rotate it instead); a live key is refused, use a test key');
  await fill(d, 'Name', 'STRIPE_RESTRICTED_KEY');
  await fill(d, 'Token', 'rk_test_51Hc0ffee');
  await press(d, 'Next');
  await step('f-proj-cred-05-phases', 'Step 3 Rule: sensitive, so only to approved scripts; Leads and Engineers in Crumb; only while holding');
  await d.getByRole('group', { name: 'Project roles in Crumb' }).getByRole('button', { name: 'Leads', exact: true }).click();
  await d.getByRole('group', { name: 'Project roles in Crumb' }).getByRole('button', { name: 'Engineers', exact: true }).click();
  await press(d, 'Save to Crumb');
  await step('f-proj-cred-06-phases-error', 'Step 3, error: no role picked, so nobody could use it');
  await d.getByRole('group', { name: 'Project roles in Crumb' }).getByRole('button', { name: 'Leads', exact: true }).click();
  await step('f-proj-cred-07-review', 'Step 3: Leads in Crumb only');
  await press(d, 'Save to Crumb');
  await step('f-proj-cred-08-success', 'Saved to Crumb with its rule');
  await press(d, 'Done');
  await step('f-proj-cred-09-list', 'Crumb’s Secrets with STRIPE_RESTRICTED_KEY: Leads in Crumb · only while holding · only to approved scripts');
}, { height: 1100 });
await r.session(ps('jules', 'crumb', 'secrets'), async (page, step) => {
  await step('f-proj-cred-10-sam-refused', 'Jules (Contributor) can’t see Crumb’s secrets at all: the role that refuses it');
}, H);
await r.session(ps('rina', 'crumb', 'secrets'), async (page, step) => {
  await press(page, 'Preview secure input’s Save to…');
  const d = flow(page, 'save-to');
  await step('f-proj-cred-11-save-to', 'Secure input’s Save to as Rina (Engineer): team secret refused by her account role; Crumb’s secret, or her own STAGING_LOGIN');
  await choose(d, 'project');
  await press(d, 'Save');
  await step('f-proj-cred-12-save-to-success', 'Save to, success: saved as Crumb’s secret STAGING_RINA, only to approved scripts to start');
}, H);

// ── Automations ──
await r.session(ps('maya', 'crumb', 'automations'), async (page, step) => {
  await press(page, 'New automation');
  const d = flow(page, 'new-automation');
  await step('f-proj-auto-01-trigger', 'New automation, step 1 Trigger: name; schedule, event or webhook; cron with presets');
  await fill(d, 'Name', 'Nightly accessibility sweep');
  await fill(d, 'Schedule (cron, UTC)', '0 25 * * *');
  await press(d, 'Next');
  await step('f-proj-auto-02-cron-error', 'Step 1, error: the hour must be 0–23');
  await press(d, 'Weekdays 09:00');
  await press(d, 'Next');
  await press(d, 'Next');
  await step('f-proj-auto-03-runs-error', 'Step 2 What it runs, error: the instruction is required');
  await d.getByLabel('Instruction').fill('Run axe on every page of the ordering site and open a pull request fixing what it finds, one commit per page.');
  await step('f-proj-auto-04-runs', 'Step 2 What it runs: start a workspace, instruction, template, phase');
  await press(d, 'Next');
  await step('f-proj-auto-05-where', 'Step 3 Where: team machines and the model profile; personal ones never run automations');
  await press(d, 'Next');
  await step('f-proj-auto-06-notify', 'Step 4 Notify: Leads and the enabler always; others optional; Slack');
  await press(d, 'Next');
  await step('f-proj-auto-07-review', 'Step 5 Review: Enable, “Enabled by Maya”');
  await press(d, 'Enable');
  await step('f-proj-auto-08-success', 'New automation, success: on, Enabled by Maya');
  await press(d, 'Done');
  await step('f-proj-auto-09-list', 'Automations with the new one');
}, H);
await r.session(ps('maya', 'ledger', 'automations'), async (page, step) => {
  await press(page, 'New automation');
  const d = flow(page, 'new-automation');
  await fill(d, 'Name', 'Bank sandbox webhook');
  await choose(d, 'webhook');
  await step('f-proj-auto-10-webhook', 'Webhook trigger: the URL and how requests are signed');
  await press(d, 'Next');
  await d.getByLabel('Instruction').fill('Import the transactions in the payload into the test ledger and report mismatches.');
  await press(d, 'Next');
  await press(d, 'Next');
  await press(d, 'Next');
  await press(d, 'Enable');
  await step('f-proj-auto-11-webhook-success', 'Webhook automation, success: the signing secret shown once');
}, H);
await r.session(ps('sam', 'crumb', 'automations'), async (page, step) => {
  await press(page, 'New automation');
  const d = flow(page, 'new-automation');
  await fill(d, 'Name', 'Weekly design QA');
  await choose(d, 'event');
  await step('f-proj-auto-12-sam-event', 'Sam (Designer) starts one with an Event trigger: Pull request opened in a repository the GitHub App covers; events from authors without write access are skipped');
  await press(d, 'Next');
  await d.getByLabel('Instruction').fill('Compare the opened pull request’s screenshots with the Figma frames and comment the differences.');
  await press(d, 'Next');
  await press(d, 'Next');
  await press(d, 'Next');
  await step('f-proj-auto-13-sam-review', 'Review as Sam: Propose, not Enable (Designer can propose, not enable)');
  await press(d, 'Propose');
  await step('f-proj-auto-14-sam-proposed', 'Proposed: Crumb’s Leads see it in Needs you');
}, H);
await r.session(ps('maya', 'crumb', 'automations'), async (page, step) => {
  await page.getByRole('button', { name: 'Enable Nightly flaky-test sweep' }).click();
  await step('f-proj-auto-15-enable', 'Enable the proposed Nightly flaky-test sweep: Enabled by Maya, who hears about failures');
  await press(flow(page, 'automation-state'), 'Enable');
  await step('f-proj-auto-16-enable-success', 'Enable, success');
  await press(flow(page, 'automation-state'), 'Done');
  await page.getByRole('button', { name: 'Pause Weekly dependency updates' }).click();
  await step('f-proj-auto-17-pause', 'Pause Weekly dependency updates: no new runs; one running finishes');
  await press(flow(page, 'automation-state'), 'Pause');
  await step('f-proj-auto-18-pause-success', 'Pause, success');
}, H);

await r.finish();
