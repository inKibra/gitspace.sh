// Round 9 · Approved scripts: forwarding a secret-refused approval (5), revoking the old version on approval (6),
// editing a pending version replaces it (7), and "anyone in scope" prompts going to whoever can see the workspace (8).
import { runner } from './shots-lib.mjs';

const r = await runner('r9-scr9-captions.txt');
const card = (page, id) => page.locator(`[data-script-card="${id}"]`).first();
const openDetail = async (page, id) => {
  await page.locator(`[data-script-row="${id}"]`).locator('xpath=ancestor::*[contains(@class,"flex-wrap")][1]').getByRole('button', { name: 'Open' }).click();
};

await r.session('as=sam&open=loyalty-stamps&arrive=never', async (page, step) => {
  await card(page, 'loyalty-export').getByRole('button', { name: /^Forward to/ }).evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await step('r9-scr9-forward-01-refused', 'As Sam (Designer in Crumb): export-loyalty-orders needs DATABASE_URL, so Sam can’t approve it; the card says to forward it to Maya and Theo, who can approve it for Crumb');
  await card(page, 'loyalty-export').getByRole('button', { name: /^Forward to/ }).click();
  await card(page, 'loyalty-export').scrollIntoViewIfNeeded();
  await step('r9-scr9-forward-02-forwarded', 'Forwarded: “Sam forwarded it to Maya and Theo, who can approve it for Crumb”; it waits in their Needs you and the agent waits too');
}, { height: 1100 });

await r.session('as=theo&view=settings&page=scripts', async (page, step) => {
  await openDetail(page, 'deploy-worker');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Edit' }).click();
  await page.locator('[data-flow="script-edit"] textarea').fill('bunx wrangler deploy --env ${ENVIRONMENT} --minify');
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await step('r9-scr9-edit-01-pending', 'deploy-menu-worker after Theo’s edit: v2 waits for approval, v1 in use; Edit stays available (no “decide it first” refusal)');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Edit' }).click();
  await step('r9-scr9-edit-02-replaces', 'Edit again while v2 waits: the dialog says submitting replaces v2 and its old hash can’t be approved any more; the content starts from v2');
  await page.locator('[data-flow="script-edit"] textarea').fill('bunx wrangler deploy --env ${ENVIRONMENT} --minify --keep-vars');
  await page.getByRole('button', { name: 'Review' }).click();
  await step('r9-scr9-edit-03-review', 'Review step: Replaces v2 (old hash, waiting for approval), Becomes v2 with the new hash in its place, v1 stays in use meanwhile');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await step('r9-scr9-edit-04-replaced', 'Submitted: v2 with the new hash waits in the Admins’ Needs you in place of the old one');
  await page.getByRole('button', { name: 'Done' }).click();
  await step('r9-scr9-edit-05-detail', 'The detail lists one pending v2 (the replacement) and v1 in use');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Review v2' }).click();
  await page.locator('[data-revoke-old]').scrollIntoViewIfNeeded();
  await step('r9-scr9-revoke-01-checked', 'Approving v2: “Revoke version 1 when this is approved” is checked by default');
  await page.locator('[data-revoke-old]').click();
  await step('r9-scr9-revoke-02-unchecked', 'Unchecked: v1 and v2 both stay approved');
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await page.waitForTimeout(1700);
  await page.locator('[data-script-versions]').scrollIntoViewIfNeeded();
  await step('r9-scr9-revoke-03-kept', 'Approved with the box unchecked: v2 in use and v1 “Approved · kept until revoked”');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('link', { name: 'Audit log' }).or(page.getByRole('button', { name: 'Audit log' })).first().click();
  await step('r9-scr9-revoke-04-audit-kept', 'Audit log: “Approved script deploy-menu-worker v2 … · kept v1 approved too”, after the replaced pending version');
}, { height: 1100 });

await r.session('as=theo&view=settings&page=scripts', async (page, step) => {
  await openDetail(page, 'deploy-worker');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Edit' }).click();
  await page.locator('[data-flow="script-edit"] textarea').fill('bunx wrangler deploy --env ${ENVIRONMENT} --minify');
  await page.getByRole('button', { name: 'Review' }).click();
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await page.getByRole('button', { name: 'Done' }).click();
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Review v2' }).click();
  await page.getByRole('button', { name: 'Approve with passkey' }).click();
  await page.waitForTimeout(1700);
  await page.locator('[data-script-versions]').scrollIntoViewIfNeeded();
  await step('r9-scr9-revoke-05-revoked', 'Approved with the box left checked: v2 in use, v1 revoked');
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Close', exact: true }).last().click();
  await page.getByRole('link', { name: 'Audit log' }).or(page.getByRole('button', { name: 'Audit log' })).first().click();
  await step('r9-scr9-revoke-06-audit-revoked', 'Audit log: “Approved script deploy-menu-worker v2 … · revoked v1 #3e8b5f1”');
}, { height: 1100 });

await r.session('as=theo&open=pickup-reminders-sms&arrive=never', async (page, step) => {
  await card(page, 'pickup-smoke').getByRole('button', { name: 'Approve with passkey' }).click();
  await page.waitForTimeout(1700);
  const prompt = page.locator('[data-prompt-card="run-pickup-smoke-1"]');
  await prompt.scrollIntoViewIfNeeded();
  await step('r9-scr9-scope-01-went-to', 'pickup-reminders-sms as Theo: check-staging-pickups pauses on STAGING_OTP (anyone in scope); the card says it went to Maya, Theo, Rina, Sam and Jules: everyone who can see the workspace (Crumb’s members, Owners included), in their Needs you');
}, { height: 1100 });

await r.session('as=rina&open=bank-feed-sync&arrive=never', async (page, step) => {
  await page.locator('[data-prompt-card="run-sso"]').scrollIntoViewIfNeeded();
  await step('r9-scr9-scope-02-holder', 'A holder-only prompt for contrast: aws-sso-sandbox “Went to Rina: only the holder answers”');
}, { height: 1100 });

await r.session('as=maya&mode=board&group=state&arrive=never', async (page, step) => {
  await page.locator('[data-account-item="acc-run-checkout"]').scrollIntoViewIfNeeded();
  await step('r9-scr9-scope-03-needs-you', 'Needs you as Maya: the MFA prompt card in place, naming who it went to');
}, { height: 1100 });

await r.finish();
