// Round 9 · secrets: Owners count as Admins in every rule (1); an Admin forbids shell delivery on a project secret where
// they aren't Lead (2); a bot's secrets are its own, on its secrets page, delivered to approved scripts, by browser
// autofill, or once its sponsor approves each use with a passkey, never a shell (3); browser autofill on named sites in
// Edit rule, on the rows and in a workspace's transcript (4). Shots into $OUT as r9-sec9-*.png.
import { runner } from './shots-lib.mjs';

const r = await runner('r9-sec9-captions.txt');
const settings = (query) => `view=settings&${query}`;
const project = (as, id) => `view=project-settings&project=${id}&page=secrets&as=${as}`;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByLabel(label).first().fill(value);
const sites = (scope, value) => scope.getByLabel(/Sites it fills on/).first().fill(value);
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));
const wait = (page, ms) => page.waitForTimeout(ms);
const PASSKEY_MS = 1700;

// ── (4) Browser autofill: rows and Edit rule ──
await r.flow(settings('page=secrets&as=maya'), 'r9-sec9-team-01-rows', 'Team Secrets as Maya (Owner): APPLE_DEVELOPER reads “Leads and Engineers in Crumb · only while holding · browser autofill on developer.apple.com, appleid.apple.com (and approved scripts) · the agent never sees it” with a Browser autofill mark; CLOUDFLARE_API_TOKEN and AWS_PROD_DEPLOY read “Owners and Admins”', {
  height: 1900, act: (page) => scrollTo(page, '[data-secret="APPLE_DEVELOPER"]'),
});
await r.session(settings('page=secrets&as=theo'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for APPLE_DEVELOPER' }).click();
  const d = flow(page, 'edit-rule');
  await step('r9-sec9-team-02-who-owners-admins', 'Edit rule · APPLE_DEVELOPER, step 1 Who: account roles are “Owners and Admins” and “Members” (Owners always count as Admins), then each project’s roles');
  await press(d, 'Next');
  await step('r9-sec9-team-03-autofill-picked', 'Step 2 Handle and delivery: “Browser autofill on named sites” picked, with the sites it fills on (developer.apple.com, appleid.apple.com); the cleared shell is off because an Admin forbade it');
  await sites(d, 'developer.apple.com/account, appleid.apple.com');
  await press(d, 'Next');
  await step('r9-sec9-team-04-origin-path-error', 'Error: “developer.apple.com/account: a site only, without a path. Write developer.apple.com; it fills on any of its pages”');
  await sites(d, 'http://appleid.apple.com');
  await press(d, 'Next');
  await step('r9-sec9-team-05-origin-http-error', 'Error: “http://appleid.apple.com: https only. The browser never fills a login over plain http”');
  await sites(d, 'appleid.apple.com');
  await press(d, 'Next');
  await step('r9-sec9-team-06-review', 'Review: delivery narrows to browser autofill on appleid.apple.com; no approved script uses APPLE_DEVELOPER');
  await press(d, 'Save rule');
  await step('r9-sec9-team-07-saved', 'Saved: from the next sign-in page the browser fills it on appleid.apple.com; the agent sees the form filled, never the value');
}, { height: 1100 });
await r.flow(project('maya', 'crumb'), 'r9-sec9-project-01-crumb-autofill', 'Crumb › Secrets as Maya: STAGING_ADMIN and KDS_PASSKEY are filled by the browser on staging.crumb.example and kds.crumb.example; STAGING_LOGIN, asked of each holder, too', {
  height: 2000, act: (page) => scrollTo(page, '[data-secret="STAGING_ADMIN"]'),
});
await r.session(project('theo', 'crumb'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for DATABASE_URL' }).click();
  const d = flow(page, 'edit-rule');
  await press(d, 'Next');
  await step('r9-sec9-project-02-autofill-not-login', 'DATABASE_URL isn’t a login: the autofill card is off (“Only for a login: the browser fills a site’s sign-in form with it”)');
}, { height: 1100 });
await r.session(settings('page=my-secrets&as=rina'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit rule for STAGING_LOGIN' }).click();
  const d = flow(page, 'edit-rule');
  await step('r9-sec9-you-01-narrow-autofill', 'Rina narrows her own STAGING_LOGIN: Crumb’s rule has the browser fill it on staging.crumb.example, so autofill (or approved scripts only) is all she may pick; no shell');
  await sites(d, 'staging.crumb.example, admin.crumb.example');
  await press(d, 'Next');
  await step('r9-sec9-you-02-narrow-widen-error', 'Error: “admin.crumb.example: Crumb’s rule fills it only on staging.crumb.example. You can narrow it, not widen it”');
}, { height: 1100 });

// ── (4) The autofill event in a workspace's transcript ──
await r.flow('as=rina&open=slot-holds&arrive=never', 'r9-sec9-transcript-01-slot-holds', 'slot-holds’ transcript: “Filled STAGING_LOGIN on staging.crumb.example · value not shown · Rina’s own value · browser autofill”', {
  height: 1100, act: (page) => scrollTo(page, '[data-autofill-event="STAGING_LOGIN"]'),
});
await r.flow('as=theo&open=kitchen-display-queue&arrive=never', 'r9-sec9-transcript-02-kds', 'kitchen-display-queue’s transcript: “Filled KDS_PASSKEY on kds.crumb.example · value not shown · Crumb secret · browser autofill”', {
  height: 1100, act: (page) => scrollTo(page, '[data-autofill-event="KDS_PASSKEY"]'),
});

// ── (1) Owners count as Admins ──
await r.session('as=maya&open=checkout-apple-pay&arrive=never', async (page, step) => {
  await page.locator('[data-environment]').click();
  await wait(page, 500);
  await scrollTo(page, '[data-workspace-secret="team:CLOUDFLARE_API_TOKEN"]');
  await step('r9-sec9-owner-01-admins-only-secret', 'checkout-apple-pay’s Environment as Maya (Owner): CLOUDFLARE_API_TOKEN, whose rule names Admins only, is hers to use (“Owners and Admins · only while holding · only to approved scripts”), not dimmed');
}, { height: 1000 });
await r.flow(settings('page=secrets&as=rina'), 'r9-sec9-owner-02-rina-not-admin', 'The same rule for Rina (Member): CLOUDFLARE_API_TOKEN “Owners and Admins” leaves her out; the row reads the rule in one line', {
  height: 1400, act: (page) => scrollTo(page, '[data-secret="CLOUDFLARE_API_TOKEN"]'),
});

// ── (2) An Admin forbids shells on a project secret where they aren't Lead ──
await r.session('as=theo&view=settings&page=projects', async (page, step) => {
  await press(page, 'Join project');
  const d = flow(page, 'join-project');
  await d.locator('[data-choice="engineer"]').click();
  await press(d, 'Join as Engineer');
  await press(d, 'Open Field notes');
  await wait(page, 400);
  await press(page, 'Secrets');
  await wait(page, 400);
  await scrollTo(page, '[data-secret="MAPBOX_TOKEN"]');
  await step('r9-sec9-admin-01-row', 'Field notes › Secrets as Theo (Admin, joined as Engineer, not Lead): Edit rule is the Leads’, but MAPBOX_TOKEN (a 60-min cleared shell) offers Forbid shell');
  await page.getByRole('button', { name: 'Forbid shell for MAPBOX_TOKEN' }).click();
  const f = flow(page, 'forbid-shell');
  await step('r9-sec9-admin-02-confirm', 'Forbid shell delivery for MAPBOX_TOKEN? It’s delivered in a cleared shell now, so forbidding moves it to only approved scripts; the rest of its rule stays the Leads’');
  await press(f, 'Forbid shell delivery');
  await step('r9-sec9-admin-03-done', 'Forbidden: only approved scripts get MAPBOX_TOKEN until an Owner or Admin allows shells again; in the audit log');
  await press(f, 'Done');
  await scrollTo(page, '[data-secret="MAPBOX_TOKEN"]');
  await step('r9-sec9-admin-04-row', 'The row: “only to approved scripts”, “shell forbidden by an Admin”, and Allow shell to undo it');
}, { height: 1100 });

// ── (3) A bot's secrets are its own ──
await r.flow(settings('page=my-secrets&person=release-bot&as=theo'), 'r9-sec9-bot-01-page', 'Release bot’s secrets as Theo (its sponsor): NPM_PUBLISH_TOKEN “Only Release bot · only while holding · to approved scripts once Theo approves each use with a passkey” with its request waiting in release-2026-11; SLACK_RELEASES_WEBHOOK only to approved scripts; Edit rule, Rotate, Remove', { height: 1300 });
await r.session(settings('page=my-secrets&person=release-bot&as=theo'), async (page, step) => {
  await press(page, 'Add secret');
  const d = flow(page, 'bot-secret-add');
  await fill(d, 'Variable', 'NPM_DEPRECATE_TOKEN');
  await fill(d, 'What it unlocks', 'npm deprecate for old @crumbco/* versions');
  await step('r9-sec9-bot-02-add-secret', 'Add a secret to Release bot, step 1: an API token, NPM_DEPRECATE_TOKEN, and what it unlocks (Theo reads it when approving)');
  await press(d, 'Next');
  await fill(d, 'Secret value', ['ghp', 'notAnNpmToken0001'].join('_'));
  await press(d, 'Next');
  await step('r9-sec9-bot-03-value-error', 'Value, error: npm tokens start with npm_');
  await fill(d, 'Secret value', ['npm', 'x'.repeat(19)].join('_'));
  await press(d, 'Next');
  await step('r9-sec9-bot-04-delivery', 'Delivery: only to approved scripts (its start), Theo approves each use with a passkey, browser autofill off (not a login), and no cleared shell: “Release bot has no passkey”');
  await d.locator('[data-choice="sponsor"]').click();
  await step('r9-sec9-bot-05-sponsor-picked', 'Theo approves each use, with a passkey: each turn that asks waits in his Needs you');
  await press(d, 'Next');
  await step('r9-sec9-bot-06-passkey', 'Passkey: the secret and its rule, “Only Release bot · only while holding · to approved scripts once Theo approves each use with a passkey”');
  await press(d, 'Add with passkey');
  await wait(page, PASSKEY_MS);
  await step('r9-sec9-bot-07-done', 'Added: each time a turn Release bot starts asks for it, Theo approves in Needs you with his passkey; in the audit log');
  await press(d, 'Done');
  await scrollTo(page, '[data-secret="NPM_DEPRECATE_TOKEN"]');
  await step('r9-sec9-bot-08-listed', 'Listed with its rule and the “Sponsor approves each use” mark');
  await page.getByRole('button', { name: 'Edit rule for SLACK_RELEASES_WEBHOOK' }).click();
  const e = flow(page, 'edit-rule');
  await e.locator('[data-choice="shell"]').click({ force: true });
  await step('r9-sec9-bot-09-edit-rule-no-shell', 'Edit rule on a bot’s secret: Who is “Only Release bot”; the cleared shell is refused: “Release bot has no passkey: a cleared shell opens only after a person’s passkey”');
}, { height: 1100 });
await r.flow(settings('page=my-secrets&person=deps-bot&as=maya'), 'r9-sec9-bot-10-deps-maya', 'Deps bot’s secrets as Maya (its sponsor): NPM_READ_TOKEN only to approved scripts', { height: 900 });

// ── (3) The sponsor's approval in Needs you ──
await r.session('as=theo&mode=board&group=state&arrive=never', async (page, step) => {
  const row = page.locator('[data-account-item="acc-bot-secret"]');
  await row.scrollIntoViewIfNeeded();
  await step('r9-sec9-sponsor-01-needs-you', 'Theo’s Needs you: “Release bot asks for NPM_PUBLISH_TOKEN in release-2026-11”, its own secret whose rule waits for its sponsor (Open its secrets, Deny, Approve with passkey)');
  await row.locator('xpath=..').getByRole('button', { name: 'Approve with passkey' }).click();
  await step('r9-sec9-sponsor-02-passkey', 'Approve with passkey: waiting for Theo’s passkey');
  await wait(page, PASSKEY_MS);
  await step('r9-sec9-sponsor-03-approved', 'Approved: NPM_PUBLISH_TOKEN goes to release-2026-11’s approved script for this turn only, with Undo');
}, { height: 1000 });
await r.flow('as=maya&mode=board&group=state&arrive=never', 'r9-sec9-sponsor-04-maya-not-sent', 'Maya’s Needs you (Owner, not Release bot’s sponsor): the request isn’t there; it goes to the sponsor only', { height: 1000, act: async (page) => {
  if (await page.locator('[data-account-item="acc-bot-secret"]').count()) throw new Error('the bot secret request reached Maya');
} });

await r.finish();
