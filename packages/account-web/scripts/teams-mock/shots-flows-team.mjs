// Team flows: People & roles (invite wizard, allowed domains, Resend/Revoke/link, account-role promotion and demotion,
// removing a person, project roles), Secrets (add with its rule, edit a value, rotate, replace; team and project scope),
// Domains (add with DNS checks, verify, remove), Source & releases (channel, roll back, return), GitHub App (create,
// install, change repositories, uninstall, request to an owner) and the Audit log (filters, export), each step, error
// and success; Member refusals. Shots into $OUT as f-team-*.png with captions in f-team-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('f-team-captions.txt');
const settings = (query) => `view=settings&${query}`;
const PASSKEY_MS = 1700;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).click();
// An InputField's label element holds its text twice (one copy aria-hidden), so match the label exactly once or twice.
const fill = (scope, label, value) => scope.getByLabel(new RegExp(`^(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}){1,2}$`)).fill(value);
async function pick(page, trigger, option) {
  await page.getByRole('combobox', { name: trigger }).first().click();
  await page.getByRole('option', { name: option, exact: true }).first().click();
}
const wait = (page, ms) => page.waitForTimeout(ms);

// ── People & roles › Invites ──
await r.session(settings('page=people&tab=invites&as=theo'), async (page, step) => {
  await page.getByRole('button', { name: 'Invite', exact: true }).first().click();
  const d = flow(page, 'invite');
  await step('f-team-people-01-invite-who', 'Invite, step 1 Who as Theo (Admin): by email (several, as chips) or an invite link');
  await fill(d, 'Email addresses', 'pat.k@crumbco.example, jules@crumbco.example ana@pastry-studio.example, not-an-address');
  await press(d, 'Add');
  await press(d, 'Next');
  await step('f-team-people-02-invite-errors', 'Invite, errors: Jules is already in the team, @pastry-studio.example isn’t an allowed domain (with who adds one and where), a typo; Next refused until they’re fixed');
  await press(d, 'Remove jules@crumbco.example');
  await press(d, 'Remove ana@pastry-studio.example');
  await press(d, 'Remove not-an-address');
  await fill(d, 'Email addresses', 'pat@crumbco.example');
  await press(d, 'Add');
  await fill(d, 'Email addresses', 'pat.k@crumbco.example');
  await press(d, 'Add');
  await step('f-team-people-03-invite-duplicates', 'Invite, errors: pat@ already has a pending invite (Resend it instead), and pat.k@ is already in the list');
  await press(d, 'Remove pat@crumbco.example');
  await fill(d, 'Email addresses', 'lou@crumbco.example');
  await press(d, 'Add');
  await press(d, 'Next');
  await step('f-team-people-04-invite-account-role', 'Invite, step 2 Account role: Member by default; Owner refused for Theo (only Owners invite Owners)');
  await press(d, 'Next');
  await pick(page, 'Project role in Crumb', 'Not a member');
  await press(d, 'Next');
  await step('f-team-people-05-invite-projects-error', 'Invite, step 3 Projects, error: a Member in no project sees nothing; only projects Theo manages are listed (he isn’t in Field notes)');
  await pick(page, 'Project role in Crumb', 'Engineer');
  await pick(page, 'Project role in Ledger', 'Viewer');
  await step('f-team-people-06-invite-projects', 'Invite, step 3 Projects: Engineer in Crumb, Viewer in Ledger, each with what the role may do');
  await press(d, 'Next');
  await step('f-team-people-07-invite-review', 'Invite, step 4 Review: addresses, roles, projects, expires in 7 days, confirmed with Theo’s passkey (ThinkPad)');
  await press(d, 'Send 2 invites with passkey');
  await step('f-team-people-08-invite-passkey', 'Invite, passkey: waiting for Theo’s passkey');
  await wait(page, PASSKEY_MS);
  await step('f-team-people-09-invite-sent', 'Invite, success: 2 invites pending, each expiring in 7 days');
  await press(d, 'Done');
  await step('f-team-people-10-invites-listed', 'Pending invites now lists pat.k@ and lou@, with Resend and Revoke');
}, { height: 1000 });

await r.session(settings('page=people&tab=invites&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Invite', exact: true }).first().click();
  const d = flow(page, 'invite');
  await d.locator('[data-choice="link"]').click();
  await pick(page, 'Uses', '5 people');
  await press(d, 'Next');
  await d.locator('[data-choice="owner"]').click();
  await step('f-team-people-11-invite-link-owner', 'Invite by link as Maya (Owner): she may invite an Owner');
  await press(d, 'Next');
  await press(d, 'Next');
  await press(d, 'Create link with passkey');
  await wait(page, PASSKEY_MS);
  await step('f-team-people-12-invite-link-ready', 'Invite link, success: works for 5 people for 7 days, copy it');
}, { height: 1000 });

// Allowed domains
await r.session(settings('page=people&tab=invites&as=maya'), async (page, step) => {
  await press(page, 'Add domain');
  const d = flow(page, 'allow-domain');
  await fill(d, 'Domain', 'gmail.com');
  await press(d, 'Allow domain');
  await step('f-team-people-13-domain-public-error', 'Allow a domain, error: a public email provider would let anyone be invited');
  await fill(d, 'Domain', 'studio crumbco');
  await press(d, 'Allow domain');
  await step('f-team-people-14-domain-format-error', 'Allow a domain, error: not a domain');
  await fill(d, 'Domain', 'studio.crumbco.example');
  await press(d, 'Allow domain');
  await step('f-team-people-15-domain-allowed', 'Allow a domain, success: invites may go to @studio.crumbco.example');
  await press(d, 'Done');
  await press(page, 'Remove studio.crumbco.example');
  await step('f-team-people-16-domain-remove', 'Stop allowing a domain: its pending invites are revoked; people already in keep their users');
  await press(flow(page, 'remove-allowed-domain'), 'Stop allowing @studio.crumbco.example');
  await step('f-team-people-17-domain-removed', 'Stop allowing, success');
  await press(flow(page, 'remove-allowed-domain'), 'Done');
  await press(page, 'Remove crumbco.example');
  await step('f-team-people-18-domain-last-error', 'Stop allowing the last domain, refused: keep at least one, allow the new one first');
}, { height: 1000 });

// Resend, link, revoke
await r.session(settings('page=people&tab=invites&as=maya'), async (page, step) => {
  await press(page, 'Resend');
  await step('f-team-people-19-resend', 'Resend: a new link, 7 days again; the first email’s link stops working');
  await press(flow(page, 'invite-resend'), 'Send again');
  await step('f-team-people-20-resent', 'Resend, success');
  await press(flow(page, 'invite-resend'), 'Done');
  await press(page, 'Copy link');
  await step('f-team-people-21-link', 'An invite link: copy it, who it lets in, revoke to stop it');
  await press(flow(page, 'invite-link'), 'Done');
  await page.getByRole('button', { name: 'Revoke', exact: true }).first().click();
  await step('f-team-people-22-revoke', 'Revoke an invite: confirm');
  await press(flow(page, 'invite-revoke'), 'Revoke invite');
  await step('f-team-people-23-revoked', 'Revoke, success: the link stopped working');
}, { height: 1000 });

await r.flow(settings('page=people&tab=invites&as=rina'), 'f-team-people-24-member-refused', 'Rina (Member) presses Invite: refused with the reason (only Owners and Admins manage the team)', {
  act: async (page) => { const button = page.getByRole('button', { name: 'Invite', exact: true }).first(); await button.hover(); await button.click({ force: true }); await wait(page, 300); },
});

// Account roles
await r.session(settings('page=people&as=maya'), async (page, step) => {
  await pick(page, 'Account role for Rina Ortiz', 'Admin');
  const d = flow(page, 'promote');
  await step('f-team-people-25-promote', 'Make Rina Admin: what she gains, needs Maya’s passkey');
  await press(d, 'Make Rina Admin with passkey');
  await step('f-team-people-26-promote-passkey', 'Promotion, waiting for Maya’s passkey');
  await wait(page, PASSKEY_MS);
  await step('f-team-people-27-promoted', 'Promotion, success: recorded in the audit log');
}, { height: 1000 });
await r.session(settings('page=people&as=maya'), async (page, step) => {
  await pick(page, 'Account role for Theo Park', 'Member');
  const d = flow(page, 'demote');
  await step('f-team-people-28-demote', 'Change Theo to Member: what he loses; Release bot goes to another Admin or Owner (Maya by default), or skip and block it (sign-ins expire after 30 days)');
  await press(d, 'Change role and hand over');
  await step('f-team-people-29-demoted', 'Demotion, success: Theo is Member, Release bot sponsored by Maya');
}, { height: 1000 });

// Remove a person
await r.session(settings('page=people&as=maya'), async (page, step) => {
  await press(page, 'Remove Theo Park');
  const d = flow(page, 'remove-person');
  await step('f-team-people-30-remove-handles', 'Remove Theo, step 1 Handles: each workspace he holds, hand it to someone in its project or leave it free');
  await pick(page, 'Handle of invoice-pdf-export', 'Hand to Rina Ortiz');
  await step('f-team-people-31-remove-handles-picked', 'Remove Theo, Handles: invoice-pdf-export handed to Rina');
  await press(d, 'Next');
  await step('f-team-people-32-remove-bots', 'Remove Theo, step 2 Bots: Release bot handed to Maya, or blocked');
  await press(d, 'Next');
  await step('f-team-people-33-remove-resources', 'Remove Theo, step 3 Personal resources: providers, machines, browsers, plugins, MCP clients, passkeys, all revoked');
  await press(d, 'Next');
  await fill(d, 'Type Theo to confirm', 'Theodore');
  await press(d, 'Remove Theo with passkey');
  await step('f-team-people-34-remove-confirm-error', 'Remove Theo, step 4 Confirm: summary; error, the typed name doesn’t match');
  await fill(d, 'Type Theo to confirm', 'Theo');
  await press(d, 'Remove Theo with passkey');
  await step('f-team-people-35-remove-passkey', 'Remove Theo: waiting for Maya’s passkey');
  await wait(page, PASSKEY_MS);
  await step('f-team-people-36-removed', 'Remove Theo, success: the audit line');
  await press(d, 'Done');
  await step('f-team-people-37-after-remove', 'People after: Theo gone');
}, { height: 1000 });

// Project roles
await r.session(settings('page=people&tab=roles&as=maya'), async (page, step) => {
  await press(page, 'New role');
  const d = flow(page, 'new-role');
  await fill(d, 'Name', 'Admin');
  await press(d, 'Create role');
  await step('f-team-people-38-role-error', 'New project role, error: Admin is an account role; the two never share names');
  await fill(d, 'Name', 'QA');
  await press(d, 'Create role');
  await step('f-team-people-39-role-created', 'New project role, success: QA, from Contributor');
  await press(d, 'Done');
  await page.getByRole('button', { name: 'Delete', exact: true }).first().click();
  await step('f-team-people-40-role-delete', 'Delete QA: no one holds it');
  await press(flow(page, 'delete-role'), 'Delete role');
  await step('f-team-people-41-role-deleted', 'Delete, success');
}, { height: 1000 });

// ── Secrets ──
await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-team-secret');
  await step('f-team-secrets-01-kind', 'Add, step 1 Kind: secret or value, service token, or login');
  await press(d, 'Next');
  await fill(d, 'Name', 'sentry dsn');
  await press(d, 'Next');
  await step('f-team-secrets-02-name-error', 'Add a secret, errors: the name isn’t UPPER_SNAKE_CASE and the value is empty');
  await fill(d, 'Name', 'SENTRY_DSN');
  await fill(d, 'Value', 'https://4f1@o1.ingest.sentry.io/77');
  await press(d, 'Next');
  await step('f-team-secrets-03-duplicate', 'Add a secret, error: SENTRY_DSN already exists, rotate it instead');
  await fill(d, 'Name', 'POSTHOG_KEY');
  await press(d, 'Next');
  await d.getByRole('group', { name: 'Account roles' }).getByRole('button', { name: 'Owners and Admins', exact: true }).click();
  await press(d, 'Add POSTHOG_KEY');
  await step('f-team-secrets-04-where-error', 'Add, step 3 Rule, error: no role picked, so nobody could use it');
  await d.getByRole('group', { name: 'Account roles' }).getByRole('button', { name: 'Owners and Admins', exact: true }).click();
  await d.getByRole('group', { name: 'Project roles in Crumb' }).getByRole('button', { name: 'Engineers', exact: true }).click();
  await step('f-team-secrets-05-where', 'Add, step 3 Rule: Owners and Admins (Owners always count as Admins) and Engineers in Crumb, only while holding, only to approved scripts (sensitive)');
  await press(d, 'Add POSTHOG_KEY');
  await step('f-team-secrets-06-added', 'Add, success: the rule in one line');
  await press(d, 'Done');
  await step('f-team-secrets-07-listed', 'Team secrets now list POSTHOG_KEY with its rule');
}, { height: 1000 });

await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-team-secret');
  await d.locator('[data-choice="token"]').click();
  await press(d, 'Next');
  await fill(d, 'Name', 'CLOUDFLARE_DNS_TOKEN');
  await fill(d, 'Token', ['ghp', '123456'].join('_'));
  await press(d, 'Check token');
  await step('f-team-secrets-08-token-prefix', 'Service token, error: a Cloudflare token starts with cf_');
  await fill(d, 'Token', 'cf_8QmZt1readonlyDNSv2Kk');
  await press(d, 'Check token');
  await step('f-team-secrets-09-token-checking', 'Service token: asking Cloudflare which scopes it has');
  await wait(page, 1400);
  await step('f-team-secrets-10-token-scope', 'Service token, error: missing Workers Scripts:Edit, with where to add it');
  await fill(d, 'Token', 'cf_8QmZt1fullDNSandWorkers');
  await press(d, 'Check token');
  await wait(page, 1400);
  await step('f-team-secrets-11-token-ok', 'Service token: Cloudflare reports every scope needed');
  await press(d, 'Next');
  await press(d, 'Add CLOUDFLARE_DNS_TOKEN');
  await step('f-team-secrets-12-token-added', 'Service token, success, with its rule');
}, { height: 1000 });

await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await press(page, 'Add');
  const d = flow(page, 'add-team-secret');
  await d.locator('[data-choice="login"]').click();
  await press(d, 'Next');
  await fill(d, 'Name', 'Apple Developer');
  await fill(d, 'Site', 'apple developer');
  await press(d, 'Next');
  await step('f-team-secrets-13-credential-errors', 'Login, errors: the name isn’t UPPER_SNAKE_CASE, the site isn’t a site, username and password required');
}, { height: 1000 });

await r.session(settings('page=secrets&as=maya'), async (page, step) => {
  await press(page, 'Edit AWS_REGION');
  const d = flow(page, 'rotate-secret');
  await press(d, 'Save value');
  await step('f-team-secrets-14-edit-unchanged', 'Edit a value, error: unchanged');
  await fill(d, 'Value', 'eu-west-2');
  await press(d, 'Save value');
  await step('f-team-secrets-15-edited', 'Edit, success: who gets it and when');
  await press(d, 'Done');
  await press(page, 'Rotate CLOUDFLARE_API_TOKEN');
  const c = flow(page, 'rotate-secret');
  await fill(c, 'New value', 'cf_short');
  await fill(c, 'New value again', 'cf_other');
  await press(c, 'Rotate and check');
  await step('f-team-secrets-16-rotate-errors', 'Rotate a token, errors: too short, and the two values differ; who picks it up (approved scripts at their next run) and its rule');
  await fill(c, 'New value', 'cf_9Rr2mWq7Lx0Tz4Hb8Kd1Vn');
  await fill(c, 'New value again', 'cf_9Rr2mWq7Lx0Tz4Hb8Kd1Vn');
  await press(c, 'Rotate and check');
  await step('f-team-secrets-17-rotate-checking', 'Rotate: checking with the service');
  await wait(page, 1500);
  await step('f-team-secrets-18-rotated', 'Rotate, success');
}, { height: 1000 });

await r.session('view=project-settings&project=ledger&page=secrets&as=maya', async (page, step) => {
  await press(page, 'Replace OPENBANK_CLIENT_SECRET');
  const c = flow(page, 'rotate-secret');
  await step('f-team-secrets-19-replace-project', 'Ledger’s settings: Replace an expired project secret, the same dialog at project scope');
  const rotated = ['obsk', 'live', '7Hq2Lm9Pz4Wx1Kc8'].join('_');
  await fill(c, 'New value', rotated);
  await fill(c, 'New value again', rotated);
  await press(c, 'Replace and check');
  await wait(page, 1500);
  await step('f-team-secrets-20-replaced', 'Replace, success: approved scripts get it at their next run');
}, { height: 1000 });

await r.session('view=project-settings&project=crumb&page=secrets&as=maya', async (page, step) => {
  await press(page, 'Rotate DATABASE_URL');
  const d = flow(page, 'rotate-secret');
  await press(d, 'Rotate and check');
  await step('f-team-secrets-21-project-edit-error', 'Crumb’s settings: Rotate a project secret, masked; error, empty');
  await fill(d, 'New value', 'postgres://crumb:x8Kq2@staging-db.internal/crumb');
  await fill(d, 'New value again', 'postgres://crumb:x8Kq2@staging-db.internal/crumb');
  await press(d, 'Rotate and check');
  await wait(page, 1500);
  await step('f-team-secrets-22-project-edited', 'Project secret, success: seed-staging-db gets it at its next run');
}, { height: 1000 });

await r.flow(settings('page=secrets&as=rina'), 'f-team-secrets-23-member-refused', 'Rina (Member) presses Add: refused with the reason', {
  act: async (page) => { const button = page.getByRole('button', { name: 'Add', exact: true }).first(); await button.hover(); await button.click({ force: true }); await wait(page, 300); },
});

// ── Domains ──
await r.session(settings('page=domains&as=maya'), async (page, step) => {
  await press(page, 'Add domain');
  const d = flow(page, 'add-domain');
  await fill(d, 'Domain', 'app..crumbco.example');
  await press(d, 'Next');
  await step('f-team-domains-01-format-error', 'Add a domain, step 1, error: not a domain name');
  await d.locator('[data-choice="previews"]').click();
  await fill(d, 'Domain', 'preview.crumbco.example');
  await press(d, 'Next');
  await step('f-team-domains-02-wildcard-error', 'Add a domain, error: previews need a wildcard');
  await d.locator('[data-choice="address"]').click();
  await fill(d, 'Domain', 'app.crumbco.example');
  await press(d, 'Next');
  await step('f-team-domains-03-records', 'Add a domain, step 2 DNS records: the TXT and the CNAME to add');
  await press(d, 'Verify');
  await wait(page, 1200);
  await step('f-team-domains-04-not-found', 'Verify, error: no records found yet, how long DNS takes and where to look');
  await press(d, 'Check again');
  await wait(page, 1200);
  await step('f-team-domains-05-wrong-value', 'Verify, error: the CNAME has the zone appended; add a trailing dot');
  await press(d, 'Check again');
  await wait(page, 1200);
  await step('f-team-domains-06-found', 'Verify: both records found');
  await press(d, 'Issue certificate');
  await step('f-team-domains-07-issuing', 'Add a domain, step 3 Certificate: asking Let’s Encrypt');
  await wait(page, 1800);
  await step('f-team-domains-08-active', 'Add a domain, success: active with TLS, renews itself');
  await press(d, 'Done');
  await step('f-team-domains-09-listed', 'Domains now list app.crumbco.example, verified');
}, { height: 1000 });

await r.session(settings('page=domains&as=maya'), async (page, step) => {
  await press(page, 'DNS records');
  const d = flow(page, 'domain-dns');
  await step('f-team-domains-10-pending', 'A pending preview domain’s DNS records');
  await press(d, 'Verify');
  await wait(page, 1200);
  await step('f-team-domains-11-pending-not-found', 'Verify, error: not found yet');
  await press(d, 'Check again');
  await wait(page, 1200);
  await step('f-team-domains-12-pending-active', 'Verify, success: active, certificate issued');
  await press(d, 'Done');
  await press(page, 'Remove gitspace.crumbco.example');
  const x = flow(page, 'remove-domain');
  await fill(x, 'Type gitspace.crumbco.example to confirm', 'gitspace.crumbco');
  await press(x, 'Remove domain');
  await step('f-team-domains-13-remove-error', 'Remove a domain: what stops; error, the typed name doesn’t match');
  await fill(x, 'Type gitspace.crumbco.example to confirm', 'gitspace.crumbco.example');
  await press(x, 'Remove domain');
  await step('f-team-domains-14-removed', 'Remove, success');
}, { height: 1000 });

// ── Source & releases ──
await r.session(settings('page=source&as=maya'), async (page, step) => {
  await pick(page, 'Release channel', 'Beta');
  const d = flow(page, 'release-channel');
  await step('f-team-source-01-channel', 'Switch to Beta: what changes');
  await press(d, 'Switch to Beta');
  await step('f-team-source-02-channel-done', 'Switch, success: 2026.11.4 on Friday');
  await press(d, 'Done');
  await press(page, 'Roll back');
  const b = flow(page, 'rollback');
  await step('f-team-source-03-rollback-release', 'Roll back, step 1 Release: 2026.10.4 refused, past an irreversible migration');
  await press(b, 'Next');
  await press(b, 'Next');
  await step('f-team-source-04-rollback-impact-error', 'Roll back, step 2 Impact: what happens; error, say why');
  await b.getByLabel('Why').fill('The audit export times out since 2026.11.3');
  await press(b, 'Next');
  await step('f-team-source-05-rollback-confirm', 'Roll back, step 3 Confirm with passkey');
  await press(b, 'Roll back with passkey');
  await wait(page, PASSKEY_MS);
  await step('f-team-source-06-rollback-deploying', 'Roll back: deploying, running turns finish first');
  await wait(page, 2000);
  await step('f-team-source-07-rolled-back', 'Roll back, success: updates paused');
  await press(b, 'Done');
  await step('f-team-source-08-page-rolled-back', 'Source & releases after: rolled back, Return to latest');
  await pick(page, 'Release channel', 'Stable');
  await step('f-team-source-09-channel-refused', 'Switch channel while rolled back: refused, return to latest first');
  await press(flow(page, 'release-channel'), 'Cancel');
  await press(page, 'Return to latest');
  const t = flow(page, 'return-latest');
  await press(t, 'Update to 2026.11.3');
  await wait(page, 1700);
  await step('f-team-source-10-returned', 'Return to latest, success: updates on again');
}, { height: 1000 });

// ── GitHub App ──
await r.session(settings('page=github&as=maya&app=none'), async (page, step) => {
  await step('f-team-github-01-no-app', 'GitHub App, none yet: Create the GitHub App');
  await press(page, 'Create the GitHub App');
  const d = flow(page, 'create-github-app');
  await fill(d, 'App name', 'GitSpace');
  await press(d, 'Next');
  await step('f-team-github-02-name-taken', 'Create the App, step 1 Name, error: the name is taken on GitHub');
  await fill(d, 'App name', 'GitSpace for Crumb & Co');
  await press(d, 'Next');
  await step('f-team-github-03-permissions', 'Create the App, step 2 Permissions: what the manifest asks for');
  await press(d, 'Next');
  await step('f-team-github-04-redirect', 'Create the App, step 3: continue to GitHub');
  await press(d, 'Continue to GitHub');
  await wait(page, 1100);
  await step('f-team-github-05-on-github', 'Create the App: GitHub’s page');
  await d.locator('[data-github-page] button', { hasText: 'Cancel' }).click();
  await step('f-team-github-06-cancelled', 'Create the App, error: cancelled on GitHub, nothing made');
  await press(d, 'Continue to GitHub');
  await wait(page, 1100);
  await press(d, 'Create GitHub App');
  await wait(page, 1400);
  await step('f-team-github-07-created', 'Create the App, success: key and webhook secret kept by GitSpace; Install next');
  await press(d, 'Install on an organization');
  const i = flow(page, 'install-github-app');
  await i.locator('[data-choice="bakery-partners"]').click();
  await press(i, 'Next');
  await step('f-team-github-08-install-not-owner', 'Install, step 1 Organization, error: Maya is a member of bakery-partners, not an owner');
  await press(i, 'Pick another');
  await i.locator('[data-choice="crumb-events"]').click();
  await press(i, 'Next');
  await press(i, 'Next');
  await step('f-team-github-09-install-repos-error', 'Install, step 2 Repositories, error: none selected');
  await fill(i, 'Search repositories', 'ticket');
  await i.locator('[data-repo="tickets-api"]').click();
  await step('f-team-github-10-install-repos', 'Install, step 2: search and pick tickets-api');
  await press(i, 'Next');
  await step('f-team-github-11-install-review', 'Install, step 3: what GitHub will be asked');
  await press(i, 'Continue to GitHub');
  await step('f-team-github-12-install-on-github', 'Install: GitHub’s Install & Authorize');
  await press(i, 'Install & Authorize');
  await wait(page, 1400);
  await step('f-team-github-13-installed', 'Install, success');
}, { height: 1000 });

await r.session(settings('page=github&as=theo'), async (page, step) => {
  await press(page, 'Install on another organization');
  const i = flow(page, 'install-github-app');
  await i.locator('[data-choice="bakery-partners"]').click();
  await press(i, 'Next');
  await press(i, 'Send request to an owner');
  await step('f-team-github-14-request-sent', 'Install as Theo, a member of bakery-partners: request sent to its owners');
}, { height: 1000 });

await r.session(settings('page=github&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Change repositories', exact: true }).first().click();
  const d = flow(page, 'change-repos');
  await step('f-team-github-15-change-repos', 'Change repositories on crumb-co: all or selected, with search');
  await d.locator('[data-repo="crumb-kitchen"]').click();
  await press(d, 'Save on GitHub');
  await step('f-team-github-16-change-repos-error', 'Change repositories, error: Crumb uses crumb-kitchen; confirm to remove it anyway');
  await d.getByRole('switch').click();
  await press(d, 'Save on GitHub');
  await step('f-team-github-17-change-repos-saved', 'Change repositories, success');
  await press(d, 'Done');
  await page.getByRole('button', { name: 'Uninstall…', exact: true }).nth(1).click();
  const u = flow(page, 'uninstall-github-app');
  await fill(u, 'Type crumb-labs to confirm', 'crumb');
  await press(u, 'Uninstall from crumb-labs');
  await step('f-team-github-18-uninstall-error', 'Uninstall from crumb-labs: what stops for Crumb; error, the typed name doesn’t match');
  await fill(u, 'Type crumb-labs to confirm', 'crumb-labs');
  await press(u, 'Uninstall from crumb-labs');
  await step('f-team-github-19-uninstalled', 'Uninstall, success');
}, { height: 1000 });

// ── Audit log ──
await r.session(settings('page=audit&as=maya'), async (page, step) => {
  await pick(page, 'Person or bot', 'Any bot');
  await step('f-team-audit-01-any-bot', 'Audit log filtered to any bot');
  await pick(page, 'Person or bot', 'Everyone and every bot');
  await pick(page, 'Sponsor', 'Bots sponsored by Theo');
  await step('f-team-audit-02-sponsor', 'Audit log: bots sponsored by Theo');
  await pick(page, 'Sponsor', 'Any sponsor');
  await pick(page, 'Project', 'Ledger');
  await pick(page, 'Date range', 'Today');
  await fill(page, 'Search the log', 'moved');
  await step('f-team-audit-03-project-range-text', 'Audit log: Ledger, today, “moved”');
  await fill(page, 'Search the log', 'zzz');
  await step('f-team-audit-04-nothing', 'Audit log: nothing matches, clear a filter');
  await press(page, 'Export');
  const d = flow(page, 'export-audit');
  await step('f-team-audit-05-export-format', 'Export, step 1 Format: CSV or JSON');
  await press(d, 'Next');
  await press(d, 'Export 0 entries');
  await step('f-team-audit-06-export-empty', 'Export, step 2, error: the filters match nothing');
  await d.locator('[data-choice="30d"]').click();
  await step('f-team-audit-07-export-range', 'Export, step 2 Range and contents: last 30 days, MCP client, sponsor, project');
  await d.getByRole('button', { name: /^Export \d+ entries$/ }).click();
  await step('f-team-audit-08-export-preparing', 'Export, step 3: preparing');
  await wait(page, 1700);
  await step('f-team-audit-09-export-ready', 'Export, success: the download, 24 hours, recorded in the log');
}, { height: 1000 });
await r.flow(settings('page=audit&as=rina'), 'f-team-audit-10-member', 'Audit log as Rina (Member): not available, Owners and Admins only', {});

await r.finish();
