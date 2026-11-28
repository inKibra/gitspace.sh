// Round 7 · Approved scripts: the approval card in the transcript (approve, route to the Leads, the secret refusal,
// decline), Needs you rows, the three libraries, a script's detail, Revoke and Edit.
import { runner } from './shots-lib.mjs';

const r = await runner('r7-scr-captions.txt');
const card = (page, id) => page.locator(`[data-script-card="${id}"]`).first();
const show = async (page, id) => { await card(page, id).scrollIntoViewIfNeeded(); };

await r.session('as=rina&open=bank-feed-sync&arrive=never', async (page, step) => {
  await show(page, 'bank-sandbox-token');
  await step('r7-scr-transcript-01-card', 'bank-feed-sync as Rina (Lead in Ledger): the agent submits refresh-openbank-token; the card shows content and hash, OPENBANK_CLIENT_SECRET (Rina may use it), network, Data profile, pinned commit, scope For Ledger, and the URL-elicitation caption');
  await card(page, 'bank-sandbox-token').getByRole('button', { name: 'Approve with passkey' }).click();
  await step('r7-scr-transcript-02-passkey', 'Approve with passkey: waiting for Rina’s passkey');
  await page.waitForTimeout(1700);
  await page.locator('[data-script-submission="bank-sandbox-token"]').last().scrollIntoViewIfNeeded();
  await step('r7-scr-transcript-03-run', 'Approved for Ledger: the agent runs it by name; the run shows *** where the secret would be, exit 0');
}, { height: 1100 });

await r.session('as=jules&open=pickup-reminders-sms&arrive=never', async (page, step) => {
  await card(page, 'pickup-smoke').getByRole('button', { name: /^Forward to/ }).evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await step('r7-scr-transcript-04-jules', 'As Jules (Contributor in Crumb): For Crumb needs a Lead; the card names Maya and Theo and offers to forward it to them');
  await card(page, 'pickup-smoke').getByRole('button', { name: /^Forward to/ }).click();
  await step('r7-scr-transcript-05-sent', 'Jules forwarded it to Maya and Theo, who can approve it for Crumb: it waits in their Needs you');
}, { height: 1100 });

await r.session('as=sam&open=loyalty-stamps&arrive=never', async (page, step) => {
  await show(page, 'loyalty-export');
  await step('r7-scr-transcript-06-secret-refused', 'As Sam (Designer in Crumb): export-loyalty-orders needs DATABASE_URL (Leads and Engineers in Crumb); every scope is off with the reason, and Sam can forward it to Maya and Theo, who can approve it');
  await card(page, 'loyalty-export').getByRole('button', { name: 'Decline' }).click();
  await card(page, 'loyalty-export').getByRole('button', { name: 'Decline' }).last().click();
  await step('r7-scr-transcript-07-decline-error', 'Decline without a reason: the card asks for one');
  await card(page, 'loyalty-export').locator('textarea').fill('Use the fixture orders in db/seed instead of staging data');
  await card(page, 'loyalty-export').getByRole('button', { name: 'Decline' }).last().click();
  await page.locator('[data-script-submission="loyalty-export"]').last().scrollIntoViewIfNeeded();
  await step('r7-scr-transcript-08-declined', 'Declined with a reason: the agent is told and works without it');
}, { height: 1100 });

await r.session('as=theo&mode=board&group=state&arrive=never', async (page, step) => {
  await page.locator('[data-account-item="acc-script-bank-sandbox-token"]').scrollIntoViewIfNeeded();
  await step('r7-scr-needs-you-01-rows', 'Needs you as Theo: script approvals for Ledger and Crumb, one row each, with Review');
  await page.locator('[data-column-card="acc-script-vitest-codemod"]').getByRole('button', { name: 'Review' }).click();
  await step('r7-scr-needs-you-02-review', 'Review opens the same card in a dialog: Deps bot’s apply-vitest-codemod for Crumb');
  await page.locator('[data-flow="script-review"]').getByRole('button', { name: 'Ask for changes' }).click();
  await page.locator('[data-flow="script-review"] textarea').fill('Run it on packages/menu only first');
  await page.locator('[data-flow="script-review"]').getByRole('button', { name: 'Send to the agent' }).click();
  await step('r7-scr-needs-you-03-asked', 'Ask for changes: the row clears with Undo; the agent revises and resubmits');
}, { height: 1100 });
await r.session('as=maya&open=checkout-apple-pay&arrive=never', async (page, step) => {
  const prompt = page.locator('[data-prompt-card="run-checkout"]');
  await prompt.scrollIntoViewIfNeeded();
  await step('r7-scr-prompt-01-paused', 'checkout-apple-pay as Maya: deploy-checkout-prod runs by name and pauses; the MFA code card goes to Maya (the holder); over MCP it is a URL elicitation to the secure-input page');
  await prompt.locator('input').fill('12345');
  await prompt.getByRole('button', { name: 'Send to the script' }).click();
  await step('r7-scr-prompt-02-code-error', 'A 5-digit code: it must match ^[0-9]{6}$');
  await prompt.locator('input').fill('482913');
  await prompt.getByRole('button', { name: 'Send to the script' }).click();
  await prompt.scrollIntoViewIfNeeded();
  await step('r7-scr-prompt-03-choice', 'The code went into the process (the output says “answered by Maya · not shown”); next it asks the region');
  await prompt.locator('[data-choice="eu-west-1"]').click();
  await prompt.getByRole('button', { name: 'Send to the script' }).click();
  await page.locator('[data-script-run="run-checkout"]').scrollIntoViewIfNeeded();
  await step('r7-scr-prompt-04-done', 'The run continues to exit 0 with redacted output; neither answer appears');
}, { height: 1100 });

await r.session('as=rina&open=bank-feed-sync&arrive=never', async (page, step) => {
  const prompt = page.locator('[data-prompt-card="run-sso"]');
  await prompt.scrollIntoViewIfNeeded();
  await step('r7-scr-prompt-05-link', 'Rina’s own aws-sso-sandbox pauses on a link prompt: the URL and device code');
  await prompt.getByRole('button', { name: 'Open sign-in page' }).click();
  await step('r7-scr-prompt-06-link-waiting', 'Waiting for the script to continue after the sign-in');
  await page.waitForTimeout(2000);
  await page.locator('[data-script-run="run-sso"]').scrollIntoViewIfNeeded();
  await step('r7-scr-prompt-07-link-done', 'Signed in; the script continued to exit 0');
}, { height: 1100 });

await r.session('as=maya&mode=board&group=state&arrive=never', async (page, step) => {
  await page.locator('[data-account-item="acc-run-checkout"]').scrollIntoViewIfNeeded();
  await step('r7-scr-needs-you-04-prompt', 'Needs you as Maya: the MFA prompt card answered in place, beside the script approvals');
}, { height: 1100 });

await r.flow('as=maya&view=settings&page=scripts', 'r7-scr-team-01-page', 'Crumb & Co › Approved scripts: the team’s (deploy-menu-worker; deploy-checkout-prod with its MFA and region prompts), with Also show for projects and Mine');
await r.flow('as=maya&view=settings&page=scripts', 'r7-scr-team-02-filtered', 'Also show Crumb: Crumb’s scripts, pending ones marked', {
  act: async (page) => { await page.getByRole('button', { name: 'Crumb', exact: true }).click(); },
});
await r.flow('as=maya&view=project-settings&project=crumb&page=scripts', 'r7-scr-project-01-crumb', 'Crumb › Approved scripts: the project’s list');
await r.flow('as=sam&view=settings&page=my-scripts', 'r7-scr-mine-01-sam', 'You › My approved scripts as Sam: export-figma-frames For Sam only, nothing waiting, what his agents may also run');

await r.session('as=maya&view=project-settings&project=crumb&page=scripts', async (page, step) => {
  await page.locator('[data-script-row="seed-staging"]').locator('xpath=ancestor::*[contains(@class,"flex-wrap")][1]').getByRole('button', { name: 'Open' }).click();
  await step('r7-scr-detail-01-seed', 'seed-staging-db: scope, v2 in use and v1 kept until revoked, who approved each, usage with inputs and exit codes');
  const dialog = page.locator('[data-flow]');
  await dialog.getByRole('button', { name: 'Revoke' }).click();
  await step('r7-scr-revoke-01-what', 'Revoke · step 1: v1 only (v2 stays in use) or the whole script');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('[data-flow="script-revoke"] textarea').fill('seed-staging');
  await page.getByRole('button', { name: 'Revoke with passkey' }).click();
  await step('r7-scr-revoke-02-error', 'Revoke · step 2: the typed name doesn’t match');
  await page.locator('[data-flow="script-revoke"] textarea').fill('seed-staging-db');
  await page.getByRole('button', { name: 'Revoke with passkey' }).click();
  await step('r7-scr-revoke-03-passkey', 'Revoke · confirming with Maya’s passkey');
  await page.waitForTimeout(1700);
  await step('r7-scr-revoke-04-done', 'v1 revoked; v2 stays in use; recorded in the audit log');
}, { height: 1100 });

await r.session('as=theo&view=settings&page=scripts', async (page, step) => {
  await page.getByRole('button', { name: 'Open' }).first().click();
  await page.locator('[data-flow="script-detail"]').getByRole('button', { name: 'Edit' }).click();
  await page.getByRole('button', { name: 'Review' }).click();
  await step('r7-scr-edit-01-unchanged', 'Edit deploy-menu-worker · nothing changed yet');
  await page.locator('[data-flow="script-edit"] textarea').fill('bunx wrangler deploy --env ${ENVIRONMENT} --var RELEASE:$GIT_SHA');
  await page.getByRole('button', { name: 'Review' }).click();
  await step('r7-scr-edit-02-undeclared', 'Edit · the body reads $GIT_SHA, which isn’t a declared secret or input');
  await page.locator('[data-flow="script-edit"] textarea').fill('bunx wrangler deploy --env ${ENVIRONMENT} --minify');
  await page.getByRole('button', { name: 'Review' }).click();
  await step('r7-scr-edit-03-review', 'Edit · review: new hash, diff, who approves, v1 stays in use meanwhile');
  await page.getByRole('button', { name: 'Submit for approval' }).click();
  await step('r7-scr-edit-04-submitted', 'v2 is waiting for approval in the Admins’ Needs you');
  await page.getByRole('button', { name: 'Done' }).click();
  await step('r7-scr-edit-05-pending', 'deploy-menu-worker: v2 pending, v1 in use, Review v2');
}, { height: 1100 });

await r.finish();
