// Round 7, machine profiles: Settings › Crumb & Co › Machine profiles (the library, each profile, version diffs), its
// flows (New profile, Edit a profile, Approve for team machines), each machine's readiness in Settings › Machines and
// You › Machines (Approve on my machine, Decline on my machine, Run setup), and the live Machines page (readiness per
// panel, the Profiles ready tile, the placement note) at full width and at 900 px. As Theo (Admin), Maya (Owner),
// Rina, Jules and Sam (Members). Shots into $OUT as r7-prof-*.png with captions in r7-prof-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('r7-prof-captions.txt');
const settings = (query) => `view=settings&${query}`;
const PASSKEY_MS = 1700;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByLabel(new RegExp(`^(?:${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}){1,2}`)).first().fill(value);
const area = (scope, label, value) => scope.locator('label', { hasText: label }).locator('textarea').fill(value);
const outcome = (scope, id) => scope.locator(`[data-outcome="${id}"]`).click();
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
const act = (page, readiness, id) => page.locator(`[data-readiness="${readiness}"] [data-act="${id}"]`).first().click({ force: true });
const open = (page, profile) => page.locator(`[data-profile="${profile}"]`).locator('xpath=ancestor::*[.//button[@data-act="open"]][1]').locator('[data-act="open"]').click();
const nav = (page, label) => page.getByRole('button', { name: label, exact: true }).first().click();

// ── The library and each profile (Theo, Admin) ──
await r.session(settings('page=machine-profiles&as=theo'), async (page, step) => {
  await step('r7-prof-library-01-list', 'Crumb & Co › Machine profiles as Theo (Admin): Rina’s two proposals on top (Data: marimo; Web: pnpm, made against v2 while v3 is current), then Web, iOS, Data with version and hash, team approval, image, projects that need each, and how many machines are ready');
  await open(page, 'web');
  await step('r7-prof-web-01-page', 'Web: team machines approved a41f09c by Theo, image gitspace/web:2026.11, needed by Crumb, Ledger, Field notes; Rina’s proposed change (against v2) under Proposals; checks with install lines; setup and teardown v3 · a41f09c');
  await page.locator('[data-profile-machine]').first().scrollIntoViewIfNeeded();
  await step('r7-prof-web-02-machines', 'Web, machines: ready on the team’s, Theo’s laptop needs his approval, Jules’s MacBook Air misses bun; where placement sends each project’s work; versions v3, v2, v1');
  await page.locator('[data-version="3"]').locator('xpath=ancestor::*[.//button[@data-act="diff"]][1]').locator('[data-act="diff"]').click();
  await page.locator('[data-diff]').scrollIntoViewIfNeeded();
  await step('r7-prof-web-03-diff', 'Web version history: v3 against v2, bun 1.2 pin dropped, check “bun ≥ 1.3”');
  await press(page, 'All machine profiles');
  await open(page, 'ios');
  await step('r7-prof-ios-01-page', 'iOS: no cloud image, needed by Crumb; Xcode 16, iOS 18 simulator and CocoaPods checks; setup v2 · 7c2e1b4');
  await page.locator('[data-placement]').first().scrollIntoViewIfNeeded();
  await step('r7-prof-ios-02-machines', 'iOS, machines: ready on Maya’s MacBook Pro, the Mac mini misses the iOS 18 simulator (Run setup), declined on rina-workstation; Crumb’s iOS work goes to Maya’s MacBook Pro or the Mac mini');
  await press(page, 'All machine profiles');
  await open(page, 'data');
  await step('r7-prof-data-01-page', 'Data: waiting for an Admin to approve e90d3aa; Approve for team machines at the top; Rina’s proposed change (marimo) under Proposals');
}, { height: 1100 });

// ── Approve for team machines (Theo, from the profile page), then Run setup on an offline team machine ──
await r.session(settings('page=machine-profiles&as=theo'), async (page, step) => {
  await open(page, 'data');
  await press(page, 'Approve for team machines');
  const d = flow(page, 'mprofile-approve-team');
  await step('r7-prof-approveteam-01-review', 'Approve Data for team machines, step 1: version e90d3aa by Rina, nothing approved yet, its checks and scripts');
  await press(d, 'Continue');
  await step('r7-prof-approveteam-02-machines', 'Step 2: the team machines that run it: crumb-cell-1 uses gitspace/data (checks only), ledger-cloud-2 is offline and runs setup when it connects');
  await press(d, 'Approve with passkey');
  await step('r7-prof-approveteam-03-passkey', 'Step 2: Theo’s passkey (ThinkPad) asked for');
  await outcome(d, 'cancel');
  await step('r7-prof-approveteam-04-cancelled', 'Step 2, error: the passkey wasn’t confirmed, nothing was approved');
  await press(d, 'Approve with passkey');
  await outcome(d, 'ok');
  await step('r7-prof-approveteam-05-done', 'Approved for team machines: crumb-cell-1 ready from the image, ledger-cloud-2 runs setup when it connects; in the audit log');
  await press(d, 'Done');
  await page.locator('[data-profile-machine]').first().scrollIntoViewIfNeeded();
  await step('r7-prof-approveteam-06-after', 'Data after: team machines approved e90d3aa by Theo; crumb-cell-1 ready, ledger-cloud-2 waiting to connect');
  await act(page, 'ledger-cloud-2:data', 'run-setup');
  const s = flow(page, 'mprofile-run-setup');
  await press(s, 'Run setup');
  await step('r7-prof-runsetup-01-offline', 'Run setup on ledger-cloud-2, error: it’s offline (last heartbeat 2h ago); start it or wait for it to connect');
}, { height: 1000 });

// ── New profile (Maya, Owner) ──
await r.session(settings('page=machine-profiles&as=maya'), async (page, step) => {
  await press(page, 'New profile');
  const d = flow(page, 'mprofile-new');
  await step('r7-prof-new-01-details', 'New machine profile as Maya (Owner), step 1 Details: name, summary, cloud image (optional)');
  await press(d, 'Continue');
  await step('r7-prof-new-02-name-empty', 'Step 1, error: name the profile');
  await fill(d, 'Name', 'web');
  await fill(d, 'Cloud image (optional)', 'android latest');
  await press(d, 'Continue');
  await step('r7-prof-new-03-taken-image', 'Step 1, errors: there’s already a profile named web; an image looks like name:tag');
  await fill(d, 'Name', 'Android');
  await fill(d, 'Summary', 'Android SDK 35, emulator, Gradle');
  await fill(d, 'Cloud image (optional)', 'gitspace/android:2026.11');
  await press(d, 'Continue');
  await step('r7-prof-new-04-checks', 'Step 2 Checks: label, command and how to install, per check');
  await d.locator('[data-check-row="0"]').getByLabel(/^(?:Label){1,2}/).fill('Android SDK 35');
  await press(d, 'Continue');
  await step('r7-prof-new-05-checks-error', 'Step 2, error: every check needs a label, a command and how to install it');
  await d.locator('[data-check-row="0"]').getByLabel(/^(?:Command){1,2}/).fill('sdkmanager --list_installed | grep "platforms;android-35"');
  await d.locator('[data-check-row="0"]').getByLabel(/^(?:How to install){1,2}/).fill('sdkmanager "platforms;android-35"');
  await press(d, 'Add a check');
  await d.locator('[data-check-row="1"]').getByLabel(/^(?:Label){1,2}/).fill('Java 21');
  await d.locator('[data-check-row="1"]').getByLabel(/^(?:Command){1,2}/).fill('java -version');
  await d.locator('[data-check-row="1"]').getByLabel(/^(?:How to install){1,2}/).fill('mise use -g java@21');
  await press(d, 'Continue');
  await press(d, 'Continue');
  await step('r7-prof-new-06-scripts-error', 'Step 3 Scripts, error: the setup script installs what the checks look for');
  await area(d, 'Setup script', 'mise use -g java@21\nsdkmanager "platforms;android-35" "emulator" "system-images;android-35;google_apis;arm64-v8a"');
  await area(d, 'Teardown script', 'rm -rf ~/.gradle/caches');
  await step('r7-prof-new-07-scripts', 'Step 3: setup and teardown in monospace; neither gets secrets');
  await press(d, 'Continue');
  await step('r7-prof-new-08-review', 'Step 4 Review: the content hash (v1), the scripts, and approve for team machines now with Maya’s passkey or leave it for another Admin');
  await press(d, 'Save and approve with passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('r7-prof-new-09-done', 'New profile, success: Android v1 saved and approved for team machines; no machine has it until a project needs it; in the audit log');
  await d.getByRole('button', { name: /^Open Android/ }).click();
  await step('r7-prof-new-10-page', 'Android’s page: v1, team machines approved by Maya, no machine has it yet');
}, { height: 1000 });

// ── Edit a profile (Theo edits iOS, leaves approval to another Admin) ──
await r.session(settings('page=machine-profiles&as=theo'), async (page, step) => {
  await open(page, 'ios');
  await press(page, 'Edit');
  const d = flow(page, 'mprofile-edit');
  await step('r7-prof-edit-01-change', 'Edit iOS as Theo, step 1 Change: checks, setup and teardown; a change makes v3 with a new hash');
  await press(d, 'Continue');
  await step('r7-prof-edit-02-unchanged', 'Step 1, error: nothing changed');
  await area(d, 'Setup script', 'xcodebuild -downloadPlatform iOS -buildVersion 18.2\nbrew install cocoapods');
  await press(d, 'Continue');
  await step('r7-prof-edit-03-note', 'Step 1, error: say what changed (the version’s note)');
  await area(d, 'What changed', 'Pin the iOS 18.2 simulator runtime');
  await press(d, 'Continue');
  await step('r7-prof-edit-04-diff', 'Step 2 Diff: v2 · 7c2e1b4 → v3 with its new hash, the changed setup line');
  await press(d, 'Continue');
  await step('r7-prof-edit-05-save', 'Step 3 Save: Maya and the Mac mini asked again, rina-workstation stays declined; approve for team machines now or leave it');
  await choose(d, 'later');
  await press(d, 'Save v3');
  await step('r7-prof-edit-06-done', 'Edit, success: iOS v3 saved; the Mac mini waits for an Admin; Maya’s MacBook Pro asked again; declined stays declined');
  await press(d, 'Done');
  await page.locator('[data-profile-machine]').first().scrollIntoViewIfNeeded();
  await step('r7-prof-edit-07-after', 'iOS after: v3 waiting for an Admin (approved now: 7c2e1b4); machines need approval again; version history v3, v2, v1');
}, { height: 1000 });

// ── Sam (Member) refused ──
await r.session(settings('page=machine-profiles&as=sam'), async (page, step) => {
  await page.getByRole('button', { name: 'New profile', exact: true }).click({ force: true });
  await step('r7-prof-refused-01-new', 'As Sam (Member, no Lead role): Machine profiles reads only; New profile says why: Owners and Admins create, edit and approve machine profiles; a project’s Lead may propose one');
  await open(page, 'web');
  await page.getByRole('button', { name: 'Edit', exact: true }).first().hover();
  await page.getByRole('button', { name: 'Edit', exact: true }).first().click({ force: true });
  await step('r7-prof-refused-02-edit', 'As Sam: Web’s Edit is refused with the reason, in a tooltip and a toast');
}, { height: 900 });

// ── Rina declines iOS on rina-workstation (You › Machines) ──
await r.session(settings('page=my-machines&as=rina'), async (page, step) => {
  await page.locator('[data-profile-readiness="rina-box"]').scrollIntoViewIfNeeded();
  await step('r7-prof-rina-01-row', 'You › Machines as Rina: rina-workstation “Ready: Web · Data · iOS (declined by Rina)” with Why declined and Allow again');
  await act(page, 'rina-box:ios', 'allow');
  await step('r7-prof-rina-02-allowed', 'Allow again: iOS needs Rina’s approval on rina-workstation, with Approve and Decline');
  await act(page, 'rina-box:ios', 'decline');
  const d = flow(page, 'mprofile-decline');
  await step('r7-prof-rina-03-decline', 'Decline iOS on rina-workstation: its scripts never run there and placement never picks it for iOS; Crumb needs iOS');
  await press(d, 'Decline');
  await step('r7-prof-rina-04-error', 'Decline, error: say why, so the project’s Leads know');
  await area(d, 'Why', 'not on my Mac: this is Linux, no Xcode');
  await press(d, 'Decline');
  await step('r7-prof-rina-05-done', 'Decline, success: Crumb’s iOS work goes to Maya’s MacBook Pro or the Mac mini instead');
  await press(d, 'Done');
  await act(page, 'rina-box:ios', 'why-declined');
  await step('r7-prof-rina-06-after', 'rina-workstation after: iOS declined by Rina; Why declined shows her reason');
}, { height: 900 });

// ── Jules approves Web on his MacBook Air (You › Machines) ──
await r.session(settings('page=my-machines&as=jules'), async (page, step) => {
  await step('r7-prof-jules-01-row', 'You › Machines as Jules: Jules’s MacBook Air “Not ready: Web (needs Jules’s approval)”, Approve and Decline');
  await act(page, 'jules-mba:web', 'approve');
  const d = flow(page, 'mprofile-approve-mine');
  await step('r7-prof-jules-02-review', 'Approve Web on Jules’s MacBook Air, step 1 Review: version a41f09c, checks with install lines, setup and teardown');
  await press(d, 'Continue');
  await step('r7-prof-jules-03-passkey', 'Step 2 Approve: setup runs as Jules, no secrets; Jules’s passkey (MacBook Air)');
  await press(d, 'Approve with passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('r7-prof-jules-04-queued', 'Step 3 Setup: the MacBook Air is offline, setup runs when it connects');
  await outcome(d, 'connect');
  await step('r7-prof-jules-05-running', 'Step 3: running Web setup, then its 3 checks');
  await outcome(d, 'fail');
  await step('r7-prof-jules-06-failed', 'Step 3, error: the check “bun ≥ 1.3” failed; install it with curl -fsSL https://bun.sh/install | bash, then Run setup again');
  await press(d, 'Run setup again');
  await outcome(d, 'pass');
  await step('r7-prof-jules-07-ready', 'Approve on my machine, success: Jules’s MacBook Air is ready for Web');
  await press(d, 'Done');
  await step('r7-prof-jules-08-after', 'You › Machines after: “Ready: Web”');
}, { height: 900 });

// ── Settings › Machines (team) as Theo ──
await r.flow(settings('page=machines&as=theo'), 'r7-prof-teammachines-01-rows', 'Crumb & Co › Machines as Theo: each team machine lists its profiles’ readiness: Data needs an Admin on the cells, the Mac mini misses the iOS 18 simulator (Run setup)', { height: 1200 });

// ── Live Machines page ──
await r.flow('view=machines&as=maya', 'r7-prof-live-01-full', 'Machines (live) as Maya, full width: Profiles ready tile, the placement note (Crumb’s iOS work goes to Maya’s MacBook Pro or the Mac mini), readiness in each panel', { height: 1800 });
await r.flow('view=machines&as=maya', 'r7-prof-live-02-900', 'Machines (live) at 900 px: tiles wrap, panels one across, readiness lines wrap with their actions', { width: 900, height: 2200 });
await r.session('view=machines&as=maya', async (page, step) => {
  await page.locator('[data-readiness="counter-mini:ios"]').scrollIntoViewIfNeeded();
  await act(page, 'counter-mini:ios', 'run-setup');
  const d = flow(page, 'mprofile-run-setup');
  await step('r7-prof-runsetup-02-dialog', 'Run iOS setup on the Back-office Mac mini (from its panel) as Maya: the approved setup v2 · 7c2e1b4');
  await press(d, 'Run setup');
  await step('r7-prof-runsetup-03-running', 'Run setup: running, then the checks');
  await outcome(d, 'fail');
  await step('r7-prof-runsetup-04-failed', 'Run setup, error: “iOS 18 simulator” failed; install it with xcodebuild -downloadPlatform iOS');
  await press(d, 'Run setup again');
  await outcome(d, 'pass');
  await step('r7-prof-runsetup-05-ready', 'Run setup, success: the Mac mini is ready for iOS; placement prefers it');
  await press(d, 'Done');
  await page.locator('[data-placement-note]').scrollIntoViewIfNeeded();
  await step('r7-prof-runsetup-06-after', 'Machines after: Profiles ready tile up by one; the Mac mini panel “Ready: Web · iOS”');
}, { height: 1000 });
await r.session('view=machines&as=theo', async (page, step) => {
  await page.locator('[data-readiness="crumb-cloud-1:data"]').scrollIntoViewIfNeeded();
  await act(page, 'crumb-cloud-1:data', 'approve');
  await step('r7-prof-live-03-team-approve', 'Approve Data for team machines from crumb-cell-1’s panel as Theo (Admin): the same by-hash approval');
  await page.keyboard.press('Escape');
  await page.locator('[data-readiness="theo-laptop:web"]').scrollIntoViewIfNeeded();
  await act(page, 'theo-laptop:web', 'approve');
  await step('r7-prof-live-04-mine-approve', 'Approve Web on Theo’s laptop from its panel: his own machine, so he approves it for that machine only');
}, { height: 1000 });

await r.finish();
