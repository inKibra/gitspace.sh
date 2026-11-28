// Round 9 · environment: Leads propose machine profiles and Admins approve them (9), an Admin declines a profile on a
// team machine (10), a proposal made against an older revision or version is re-diffed against the current one before
// approving (11), any project member proposes an Instructions change (12), and Review is gated by the pull request's
// CI checks (13). Shots into $OUT as r9-env9-*.png with captions in r9-env9-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('r9-env9-captions.txt');
const settings = (query) => `view=settings&${query}`;
const ps = (as, project) => `as=${as}&view=project-settings&project=${project}&page=environment`;
const PASSKEY_MS = 1700;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByLabel(new RegExp(`^(?:${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}){1,2}`)).first().fill(value);
const area = (scope, label, value) => scope.locator('label', { hasText: label }).locator('textarea').first().fill(value);
const act = (page, readiness, id) => page.locator(`[data-readiness="${readiness}"] [data-act="${id}"]`).first().click({ force: true });
const open = (page, profile) => page.locator(`[data-profile="${profile}"]`).locator('xpath=ancestor::*[.//button[@data-act="open"]][1]').locator('[data-act="open"]').click();
const proposalAct = (page, id, which) => page.locator(`[data-profile-proposal="${id}"]`).locator(`xpath=ancestor::*[.//button[@data-act="${which}"]][1]`).locator(`[data-act="${which}"]`).first().click();
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'center' }));

// ── 9. Rina (Lead in Ledger) proposes; Theo (Admin) approves or declines ──
await r.session(settings('page=machine-profiles&as=rina'), async (page, step) => {
  await step('r9-env9-profiles-01-rina-library', 'Machine profiles as Rina (Member, Lead in Ledger): her two proposals wait for an Owner or Admin (Maya and Theo); “Propose a profile” and “Propose a change” instead of New and Edit; Approve on proposals is dimmed for her');
  await open(page, 'ios');
  await press(page, 'Propose a change');
  const d = flow(page, 'mprofile-edit');
  await step('r9-env9-profiles-02-rina-propose-edit', 'Propose a change to iOS, step 1: Rina edits like an Admin would, but the description says it’s a proposal against v2 and every machine keeps v2 until an Owner or Admin approves');
  await area(d, 'Setup script', 'xcodebuild -downloadPlatform iOS\nbrew install cocoapods\nbrew install xcbeautify');
  await area(d, 'What changed', 'xcbeautify for readable test logs');
  await press(d, 'Continue');
  await step('r9-env9-profiles-03-rina-diff', 'Step 2 Diff: v2 · 7c2e1b4 against the proposed scripts (one added setup line)');
  await press(d, 'Continue');
  await step('r9-env9-profiles-04-rina-propose', 'Step 3 Propose: what approving would do to each machine with iOS; no approve-now choice, a note that approval makes it v3');
  await press(d, 'Propose against v2');
  await step('r9-env9-profiles-05-rina-proposed', 'Proposed: under Proposals on iOS’s page for Maya and Theo; if iOS changes first they see it re-diffed against the newer version');
  await press(d, 'Done');
  await scrollTo(page, '[data-profile-proposal]');
  await step('r9-env9-profiles-06-rina-pending', 'iOS’s page after: Proposals shows “iOS: xcbeautify for readable test logs” waiting for an Owner or Admin, proposed by Rina, just now');
  await press(page, 'All machine profiles');
  await press(page, 'Propose a profile');
  const n = flow(page, 'mprofile-new');
  await fill(n, 'Name', 'Android');
  await fill(n, 'Summary', 'Android SDK 35, Gradle');
  await press(n, 'Continue');
  await fill(n, 'Label', 'Android SDK 35');
  await fill(n, 'Command', 'sdkmanager --list_installed | grep "platforms;android-35"');
  await fill(n, 'How to install', 'sdkmanager "platforms;android-35"');
  await press(n, 'Continue');
  await area(n, 'Setup script', 'sdkmanager "platforms;android-35" "build-tools;35.0.0"');
  await press(n, 'Continue');
  await step('r9-env9-profiles-07-rina-new-review', 'Propose a machine profile, step 4: Android’s checks and scripts with its hash; an Owner or Admin approves the hash for team machines');
  await press(n, 'Propose Android');
  await step('r9-env9-profiles-08-rina-new-proposed', 'Proposed: Android waits under Proposals in Machine profiles for Maya and Theo; no machine runs it until then');
}, { height: 1000 });

await r.session(settings('page=machine-profiles&as=theo'), async (page, step) => {
  await step('r9-env9-profiles-09-theo-library', 'Machine profiles as Theo (Admin): Proposals on top, Data (marimo) and Web (pnpm, amber: against v2 · v3 is current), each with Decline and Review and approve; the Web and Data rows add “a change is proposed”');
  await proposalAct(page, 'pp-data-marimo', 'approve-proposal');
  const d = flow(page, 'mprofile-proposal-approve');
  await step('r9-env9-profiles-10-theo-approve-data', 'Approve Rina’s change to Data: made against v1, the current version, so the diff is against v1 (marimo check and setup line); Theo’s passkey');
  await press(d, 'Approve with passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('r9-env9-profiles-11-theo-approved-data', 'Approved: Data v2 is approved for team machines; machines that have it are asked again, team machines are set up; Rina is told; in the audit log');
  await press(d, 'Done');
  await proposalAct(page, 'pp-web-pnpm', 'decline-proposal');
  const x = flow(page, 'mprofile-proposal-decline');
  await press(x, 'Decline');
  await step('r9-env9-profiles-12-theo-decline-error', 'Decline Rina’s Web change, error: say why, so Rina knows what to change (the dialog still shows it re-diffed against v3)');
  await area(x, 'Why', 'Use corepack in Ledger’s own setup, not the shared Web profile');
  await press(x, 'Decline');
  await step('r9-env9-profiles-13-theo-declined', 'Declined: Rina gets the reason; nothing changed');
}, { height: 1000 });

// ── 11. A profile proposal made against an older version: re-diffed against the current one ──
await r.session(settings('page=machine-profiles&as=maya'), async (page, step) => {
  await proposalAct(page, 'pp-web-pnpm', 'approve-proposal');
  const d = flow(page, 'mprofile-proposal-approve');
  await step('r9-env9-rediff-01-profile-stale', 'Maya approves Rina’s Web change made against v2: v3 (bun 1.3, Theo) was saved since, so it’s re-diffed against v3: the bun 1.2 pin it carries shows as a change; below, Rina’s own change against v2; the button says “Approve against v3 with passkey”');
  await scrollTo(page, '[data-flow="mprofile-proposal-approve"] [data-diff]');
  await press(d, 'Approve against v3 with passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('r9-env9-rediff-02-profile-approved', 'Approved against v3: Web v4 is exactly what the re-diff showed; Rina is told it was re-diffed against v3');
}, { height: 1100 });

// ── 10. An Admin declines a profile on a team machine ──
await r.session(settings('page=machine-profiles&as=theo'), async (page, step) => {
  await open(page, 'ios');
  await scrollTo(page, '[data-readiness="counter-mini:ios"]');
  await step('r9-env9-decline-01-team-row', 'iOS on Theo’s view: the Mac mini (a team machine) misses the iOS 18 simulator, with Run setup and now Decline for an Admin');
  await act(page, 'counter-mini:ios', 'decline');
  const d = flow(page, 'mprofile-decline');
  await press(d, 'Decline');
  await step('r9-env9-decline-02-error', 'Decline iOS on the Mac mini, error: say why, so the project’s Leads know');
  await area(d, 'Why', 'Disk is full: no room for another simulator runtime');
  await press(d, 'Decline');
  await step('r9-env9-decline-03-done', 'Declined: placement sends Crumb’s iOS work elsewhere (Maya’s MacBook Pro); allow it again here any time; in the audit log');
  await press(d, 'Done');
  await scrollTo(page, '[data-placement]');
  await step('r9-env9-decline-04-placement', 'iOS after: the Mac mini “declined by Theo” with Why declined and Allow again; Where placement sends work skips it');
  await act(page, 'counter-mini:ios', 'allow');
  await scrollTo(page, '[data-readiness="counter-mini:ios"]');
  await step('r9-env9-decline-05-allowed', 'Allow again: the Mac mini is back to missing the simulator, with Run setup (team approval of 7c2e1b4 stands)');
}, { height: 1000 });
await r.flow(settings('page=machine-profiles&as=rina'), 'r9-env9-decline-06-rina-refused', 'As Rina (Member): Decline on a team machine is dimmed: Owners and Admins approve, decline and run setup for profiles on team machines', {
  act: async (page) => { await open(page, 'web'); await scrollTo(page, '[data-readiness="crumb-cloud-1:web"]'); await page.locator('[data-readiness="crumb-cloud-1:web"] [data-act="decline"]').hover(); await page.waitForTimeout(600); },
});

// ── 12. Any project member proposes; 11. re-diff when a newer revision was saved ──
await r.session(ps('sam', 'crumb'), async (page, step) => {
  await step('r9-env9-instr-01-sam-page', 'Crumb › Environment as Sam (Designer): any member proposes, so “Propose an edit” is open; the Instructions say `bun test` runs in CI on the pull request and its checks gate Review');
  await press(page, 'Propose an edit');
  const d = flow(page, 'edit-instructions');
  const text = await d.locator('textarea').first().inputValue();
  await d.locator('textarea').first().fill(`${text}\n\n## Design\n- UI changes: attach before and after screenshots to the pull request.`);
  await press(d, 'Next');
  await fill(d, 'What changed', 'Screenshots for UI changes');
  await press(d, 'Next');
  await step('r9-env9-instr-02-sam-propose', 'Sam’s step 3 Propose: revision 9 proposed against revision 7; Crumb’s Leads (Maya, Theo) decide');
  await press(d, 'Propose as revision 9');
  await step('r9-env9-instr-03-sam-proposed', 'Proposed as revision 9: above the history and in the Leads’ Needs you; agents keep reading revision 7');
}, { height: 1000 });

await r.session(ps('theo', 'crumb'), async (page, step) => {
  await press(page, 'Edit');
  const d = flow(page, 'edit-instructions');
  const text = await d.locator('textarea').first().inputValue();
  await d.locator('textarea').first().fill(text.replace('(port 5173)', '(port 5173; 5174 for the kitchen display)'));
  await press(d, 'Next');
  await fill(d, 'What changed', 'Kitchen display port');
  await press(d, 'Next');
  await press(d, 'Save as revision 9');
  await press(d, 'Done');
  await scrollTo(page, '[data-env-proposal="8"]');
  await step('r9-env9-rediff-03-instr-stale-row', 'Theo saved revision 9; Deps bot’s proposal 8 now says “made against revision 7” and, in amber, that approving re-applies its change to revision 9 after a confirm; its diff is against revision 7');
  await page.locator('[data-env-proposal="8"]').getByRole('button', { name: 'Approve', exact: true }).click();
  const a = flow(page, 'approve-proposal');
  await step('r9-env9-rediff-04-instr-confirm', 'Approve proposed revision 8: made against 7, revision 9 saved since; its change against 7, then re-diffed against 9 (only the --pool=forks line); the button reads “Approve against revision 9”; nothing in revision 9 is replaced');
  await press(a, 'Approve against revision 9');
  await step('r9-env9-rediff-05-instr-approved', 'Approved: revision 10 is current with Theo’s port change kept and the --pool=forks line applied');
  await press(a, 'Done');
  await scrollTo(page, '[data-instructions]');
  await step('r9-env9-rediff-06-instr-current', 'The Instructions now: “(port 5173; 5174 for the kitchen display)” and “bun test --pool=forks runs in CI on the pull request (vitest 4.1); its checks gate Review”');
}, { height: 1000 });

await r.session('as=theo&mode=board&group=state&arrive=never', async (page, step) => {
  await page.locator('[data-account-item="acc-env-proposal"]').scrollIntoViewIfNeeded();
  await step('r9-env9-rediff-07-needs-you', 'Needs you as Theo: the Crumb instructions proposal (Review, Decline, Approve); approving here goes straight through while revision 7 is current, and opens the re-diff confirm once a newer revision was saved');
}, { height: 1000 });
await r.session('as=maya&mode=board&group=state&arrive=never', async (page, step) => {
  const row = page.locator('[data-account-item="acc-profile-proposal"]').locator('xpath=..');
  await row.scrollIntoViewIfNeeded();
  await press(row, 'Approve with passkey');
  await step('r9-env9-profiles-14-needs-you-approve', 'Needs you as Maya (Owner): “Machine profile proposal: Data v2” from Rina (Review, Decline, Approve with passkey) goes to Owners and Admins; Approve opens the same dialog as the profile page: the diff against v1 and Maya’s passkey');
  const d = flow(page, 'mprofile-proposal-approve');
  await press(d, 'Approve with passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await press(d, 'Done');
}, { height: 1000 });

// ── 13. Review is gated by the pull request's CI checks ──
await r.session('as=maya&open=slot-holds&arrive=never', async (page, step) => {
  await scrollTo(page, '[data-proposal]');
  await page.locator('[data-proposal]').getByRole('button', { name: /Accept/ }).hover();
  await page.waitForTimeout(700);
  await step('r9-env9-ci-01-failing', 'slot-holds as Maya: the agent proposes Review; “CI checks on #41 fail · Review waits until the pull request’s checks pass”; Accept is held and says so on hover');
}, { height: 1000 });
await r.session('as=sam&open=offline-drafts&arrive=never', async (page, step) => {
  await scrollTo(page, '[data-proposal]');
  await step('r9-env9-ci-02-no-ci', 'offline-drafts (Field notes) as Sam: the repository runs no CI, so the proposal says “No CI checks: Review relies on the agent’s report”; CI doesn’t hold Accept here (it’s dimmed only because Sam’s Contributor role can’t move into Review)');
}, { height: 1000 });
await r.flow('as=theo&open=menu-cache&arrive=never', 'r9-env9-ci-03-passing-review', 'menu-cache in Review as Theo: “CI checks on #38 pass · read from GitHub through the GitHub App; they gate Review”', {
  act: async (page) => { await scrollTo(page, '[data-review-state]'); },
});
await r.flow('as=maya&open=deps-week-48&arrive=never', 'r9-env9-ci-04-pending-bot', 'deps-week-48 (Deps bot holds it) as Maya: the bot proposes Review; “CI checks on #46 are running · Review waits for them”; Accept is held until they finish', {
  act: async (page) => { await scrollTo(page, '[data-proposal]'); },
});

await r.finish();
