// Round 7 · Project › Environment: the Instructions, the machine profiles a project needs, the secrets it uses with
// their rules, origins and network, and the revision history; every flow (edit the Instructions, change the profile
// list, Set up with an agent, import instructions from the repository, a revision's diff, roll back, approve and
// decline a proposal) with its steps, errors and success; as Maya (Owner), Rina (Lead in Ledger, Engineer in Crumb:
// proposes) and Sam (Designer in Crumb: proposes too). Then the proposal in Needs you and the workspace's Environment popover.
// Shots into $OUT as r7-env-*.png with captions in r7-env-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('r7-env-captions.txt');
const ps = (as, project) => `as=${as}&view=project-settings&project=${project}&page=environment`;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByRole('textbox', { name: label, exact: true }).or(scope.getByLabel(label)).first().fill(value);
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
const pickRow = (scope, id) => scope.locator(`[data-pick="${id}"]`).click();
async function pick(page, trigger, option) {
  await page.getByRole('combobox', { name: trigger }).or(page.getByLabel(trigger, { exact: true })).first().click();
  await page.getByRole('option', { name: option }).first().click();
}
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
const INSTRUCTIONS = 'How to work on this project (markdown)';
const H = { height: 1000 };

// ── The page ──
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await step('r7-env-page-01-maya-instructions', 'Crumb › Environment as Maya (Owner, Lead everywhere): Instructions “How to work on Crumb” (run it, tests, fixtures through the approved script seed-staging-db, secrets, Web and iOS profiles), with Deps bot’s proposed revision 8 above them: its diff, Decline, Approve');
  await scrollTo(page, '[data-project-profile="web"]');
  await step('r7-env-page-02-maya-profiles-secrets', 'Machine profiles Crumb needs: Web (checks bun, node 22, gh; cloud image; ready on 4 of 4 team machines) and iOS (Xcode 16, iOS 18 simulator, CocoaPods; ready on none of the team machines, 1 personal); Team library and Change profiles. Below: the secrets Crumb uses, each with its rule');
  await scrollTo(page, '[data-secret-use="STAGING_LOGIN"]');
  await step('r7-env-page-03-maya-secrets-asked', 'Secrets this project uses, lower: team secrets with their rules, and the values Crumb asks each holder for (STAGING_LOGIN set by Maya, Rina, Theo; not yet by Sam, Jules); “Edit rules in Secrets” opens Crumb’s Secrets page');
  await scrollTo(page, '[data-revision="7"]');
  await step('r7-env-page-04-maya-network-history', 'Browser origins and network (kept), approvals, and the revision history: each revision snapshots the Instructions and the profile list, with Diff and Roll back');
}, { height: 1100 });
await r.flow(ps('rina', 'ledger'), 'r7-env-page-05-rina-ledger-lead', 'Ledger › Environment as Rina (Lead in Ledger): Edit, Set up with an agent, Import from repository and Change profiles all open; Instructions mention the bitbucket fixtures and the refresh-openbank-token script; profiles Web and Data', { height: 1100 });
await r.flow(ps('rina', 'crumb'), 'r7-env-page-06-rina-crumb-proposes', 'Crumb › Environment as Rina (Engineer in Crumb): “Propose an edit” and “Propose a change”: her changes become proposals; Approve and Decline on Deps bot’s proposal are dimmed (Leads only)', { height: 1000 });
await r.session(ps('sam', 'crumb'), async (page, step) => {
  await step('r7-env-page-07-sam-proposes', 'Crumb › Environment as Sam (Designer): any project member proposes, so “Propose an edit” and “Propose a change” are open; Approve and Decline on Deps bot’s proposal stay dimmed (Leads only)');
  await press(page, 'Propose an edit');
  await step('r7-env-page-08-sam-propose-dialog', 'Sam presses Propose an edit: his change becomes a proposal one of Crumb’s Leads (Maya, Theo) approves before agents read it');
}, H);

// ── Edit the Instructions (Maya, a Lead: saves a revision) ──
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await press(page, 'Edit');
  const d = flow(page, 'edit-instructions');
  await step('r7-env-edit-01-write', 'Edit Crumb’s instructions, step 1 Write: the markdown agents read before every turn, with what belongs there');
  await fill(d, INSTRUCTIONS, '');
  await press(d, 'Next');
  await step('r7-env-edit-02-empty-error', 'Write, error: empty instructions');
  await fill(d, INSTRUCTIONS, `# How to work on Crumb\n\nUse the **Web** machine profile.\n\n## Payments\n- Test with ${['sk', 'live', 'x'.repeat(17)].join('_')} in the checkout.`);
  await press(d, 'Next');
  await step('r7-env-edit-03-secret-error', 'Write, error: line 6 looks like a secret value; every member reads the instructions, so name the secret and let its rule deliver it');
  await fill(d, INSTRUCTIONS, '# How to work on Crumb\n\nUse the **Web** machine profile; the **iOS** profile only for the Apple Pay sheet in `ios/`.\n\n## Run it\n- `bun install`, then `bun run dev` (port 5173). Start it with your service tool and share it through the relay.\n- The kitchen display: `bun run kds` (port 4173).\n\n## Tests\n- `bun test` runs in CI on the pull request (GitHub Actions); its checks gate Review.\n\n## Fixtures\n- Run the approved script `seed-staging-db` with FIXTURES=tickets (or holds).');
  await press(d, 'Next');
  await step('r7-env-edit-04-preview', 'Step 2 Preview: the rendered instructions and the diff against revision 7');
  await press(d, 'Next');
  await step('r7-env-edit-05-summary-error', 'Preview, error: say what changed in a line');
  await fill(d, 'What changed', 'Kitchen display command; trimmed the secrets section');
  await press(d, 'Next');
  await step('r7-env-edit-06-save', 'Step 3 Save: revision 9 replaces 7 as current; Roll back can return to it');
  await press(d, 'Save as revision 9');
  await step('r7-env-edit-07-success', 'Edit, success: revision 9 is current; agents read it from their next turn; in the audit log');
  await press(d, 'Done');
  await scrollTo(page, '[data-revision="9"]');
  await step('r7-env-edit-08-history', 'Revision history with revision 9 current (Maya, just now)');
}, { height: 1100 });

// ── Change the profile list ──
await r.session(ps('rina', 'ledger'), async (page, step) => {
  await press(page, 'Change profiles');
  const d = flow(page, 'edit-profiles');
  await step('r7-env-profiles-01-pick', 'Change Ledger’s machine profiles as Rina (Lead), step 1: the team’s library, each with its checks and readiness; Web and Data needed now');
  await pickRow(d, 'web');
  await pickRow(d, 'data');
  await press(d, 'Next');
  await step('r7-env-profiles-02-none-error', 'Profiles, error: Ledger’s work needs at least one profile');
  await pickRow(d, 'web');
  await pickRow(d, 'data');
  await press(d, 'Next');
  await step('r7-env-profiles-03-unchanged-error', 'Profiles, error: nothing changed yet');
  await pickRow(d, 'ios');
  await press(d, 'Next');
  await step('r7-env-profiles-04-readiness', 'Step 2 Readiness: each team machine against Web, Data and iOS; no team machine is ready for iOS yet, so new workspaces wait for a ready personal machine');
  await press(d, 'Next');
  await step('r7-env-profiles-05-save', 'Step 3 Save: revision 4, added iOS; Instructions unchanged');
  await press(d, 'Save as revision 4');
  await step('r7-env-profiles-06-success', 'Change profiles, success: Ledger needs Web, Data and iOS; open workspaces keep their machine; in the audit log');
}, H);
await r.session(ps('rina', 'crumb'), async (page, step) => {
  await press(page, 'Propose a change');
  const d = flow(page, 'edit-profiles');
  await pickRow(d, 'data');
  await press(d, 'Next');
  await step('r7-env-profiles-07-propose-readiness', 'Rina (Engineer in Crumb) proposes adding Data: no team machine is ready for it, an Admin approves its setup scripts in Machine profiles first');
  await press(d, 'Next');
  await step('r7-env-profiles-08-propose', 'Step 3 Propose: revision 9 for Crumb’s Leads (Maya, Theo) to decide');
  await press(d, 'Propose as revision 9');
  await step('r7-env-profiles-09-propose-success', 'Proposed as revision 9: in the Leads’ Needs you and above the history');
  await press(d, 'Done');
  await step('r7-env-profiles-10-proposals', 'Crumb’s Environment as Rina: two proposals above the Instructions (8 from Deps bot, 9 from Rina: + Machine profile: Data)');
}, { height: 1100 });
await r.session(ps('rina', 'crumb'), async (page, step) => {
  await press(page, 'Propose an edit');
  const d = flow(page, 'edit-instructions');
  const area = d.getByLabel(INSTRUCTIONS);
  await area.fill(`${await area.inputValue()}\n\n## Holds\n- Holds live in Redis with a TTL; \`redis-cli monitor\` shows them.`);
  await press(d, 'Next');
  await fill(d, 'What changed', 'How to watch holds in Redis');
  await press(d, 'Next');
  await step('r7-env-edit-09-propose', 'Rina proposes an Instructions edit: the last step says Propose, with who decides');
  await press(d, 'Propose as revision 9');
  await step('r7-env-edit-10-propose-success', 'Proposed as revision 9; agents keep reading revision 7 until a Lead approves');
}, H);

// ── Set up with an agent ──
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await press(page, 'Set up with an agent');
  const d = flow(page, 'set-up-agent');
  await step('r7-env-agent-01-workspace', 'Set up Crumb with an agent, step 1 Workspace: its name and branch, from crumb on develop, Code, Maya holds it');
  await fill(d, 'Workspace name', 'slot-holds');
  await press(d, 'Next');
  await step('r7-env-agent-02-name-error', 'Workspace, error: Crumb already has a workspace named slot-holds');
  await fill(d, 'Workspace name', 'setup-environment');
  await press(d, 'Next');
  await step('r7-env-agent-03-where', 'Step 2 Where it runs: team machines and Maya’s own, each with its readiness for Web and iOS');
  await press(d, 'Next');
  await step('r7-env-agent-04-reads', 'Step 3 What it reads: the repositories, README and any AGENTS.md, Crumb’s approved scripts, the team’s profiles; it writes the Instructions and proposes the profile list, never scripts or secret values');
  await press(d, 'Next');
  await step('r7-env-agent-05-notify', 'Step 4 Notify: who gets a ping besides the Leads’ Needs you');
  await press(d, 'Next');
  await step('r7-env-agent-06-start', 'Step 5 Start: summary');
  await press(d, 'Start');
  await page.waitForTimeout(1600);
  await step('r7-env-agent-07-success', 'Set up with an agent, success: setup-environment proposed revision 9 (it lists the approved script deploy-menu-worker), the profile list unchanged, the workspace link');
  await press(d, 'Done');
  await step('r7-env-agent-08-row', 'Environment with the agent’s proposal above the Instructions and its setup workspace');
}, { height: 1100 });
await r.session(ps('rina', 'ledger'), async (page, step) => {
  await press(page, 'Set up with an agent');
  const d = flow(page, 'set-up-agent');
  await press(d, 'Next');
  await choose(d, 'rina-box');
  await press(d, 'Next');
  await step('r7-env-agent-09-unreadable', 'Set up Ledger as Rina on her own workstation, error: it can’t read bitbucket.org/openbank/sandbox-fixtures (the team SSH key is on team machines only)');
}, H);

// ── Import instructions from the repository ──
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await press(page, 'Import from repository');
  const d = flow(page, 'import-instructions');
  await step('r7-env-import-01-file', 'Import instructions, step 1 File: repository, AGENTS.md, .gitspace/instructions.md or CLAUDE.md, and branch');
  await choose(d, '.gitspace/instructions.md');
  await fill(d, 'Branch', 'develop');
  await press(d, 'Read .gitspace/instructions.md');
  await page.waitForTimeout(1200);
  await step('r7-env-import-02-missing-error', 'Import, error: crumb has no .gitspace/instructions.md on develop; it has AGENTS.md');
  await choose(d, 'AGENTS.md');
  await press(d, 'Read AGENTS.md');
  await page.waitForTimeout(1200);
  await step('r7-env-import-03-diff', 'Step 2 Diff: AGENTS.md against revision 7 (adds the kitchen display command)');
  await press(d, 'Next');
  await step('r7-env-import-04-propose', 'Step 3 Propose: a proposal for the Leads, never a replacement');
  await press(d, 'Propose as revision 9');
  await step('r7-env-import-05-success', 'Import, success: proposed as revision 9');
  await press(d, 'Done');
  await step('r7-env-import-06-proposals', 'Environment with two proposals: 8 from Deps bot, 9 imported from AGENTS.md');
}, { height: 1100 });
await r.session(ps('theo', 'ledger'), async (page, step) => {
  await press(page, 'Import from repository');
  const d = flow(page, 'import-instructions');
  await pick(page, 'Repository', 'bitbucket.org/openbank/sandbox-fixtures');
  await press(d, 'Read .gitspace/instructions.md');
  await page.waitForTimeout(1200);
  await step('r7-env-import-07-unreadable', 'Import in Ledger, error: bitbucket is reached only through team machines’ SSH key; GitSpace can’t read it');
}, H);

// ── Diff, roll back, approve, decline ──
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await page.getByRole('button', { name: 'Diff of revision 6' }).click();
  await step('r7-env-history-01-diff', 'Revision 6’s diff against revision 5: fixtures through seed-staging-db, a Secrets section; its profiles; Roll back');
  await press(flow(page, 'revision-diff'), 'Roll back to revision 6');
  await step('r7-env-history-02-rollback', 'Roll back to revision 6: what changes against revision 7 (the iOS lines and the iOS profile go), makes revision 9, proposal 8 stays open');
  await press(flow(page, 'roll-back'), 'Roll back as revision 9');
  await step('r7-env-history-03-rollback-success', 'Roll back, success: revision 9 is current with revision 6’s contents');
}, H);
await r.session(ps('maya', 'crumb'), async (page, step) => {
  await page.locator('[data-env-proposal="8"]').getByRole('button', { name: 'Approve', exact: true }).click();
  await step('r7-env-history-04-approve', 'Approve proposed revision 8 from Deps bot’s agent: its diff against revision 7');
  await press(flow(page, 'approve-proposal'), 'Approve');
  await step('r7-env-history-05-approve-success', 'Approve, success: revision 8 is current; Deps bot and the other Leads are told');
}, H);
await r.session(ps('theo', 'crumb'), async (page, step) => {
  await page.locator('[data-env-proposal="8"]').getByRole('button', { name: 'Decline', exact: true }).click();
  const d = flow(page, 'decline-proposal');
  await press(d, 'Decline');
  await step('r7-env-history-06-decline-error', 'Decline proposed revision 8 as Theo, error: say why for the proposer');
  await d.getByLabel('Why (sent to the proposer)').fill('--pool=forks doubles CI time; try --pool=threads with isolate off.');
  await press(d, 'Decline');
  await step('r7-env-history-07-decline-success', 'Decline, success: nothing changed in Crumb; Deps bot gets the reason');
}, H);

// ── Needs you ──
await r.session('as=maya&mode=board&group=state&arrive=never', async (page, step) => {
  await page.locator('[data-account-item="acc-env-proposal"]').scrollIntoViewIfNeeded();
  await step('r7-env-needs-you-01-row', 'Needs you as Maya: “Instructions proposal: Crumb revision 8” from Deps bot in deps-week-48 (Review, Decline, Approve); it goes to Crumb’s Leads only');
  await page.locator('[data-account-item="acc-env-proposal"]').locator('xpath=..').getByRole('button', { name: 'Approve', exact: true }).click();
  await page.waitForTimeout(500);
  await step('r7-env-needs-you-02-approved', 'Approved from Needs you: revision 8 is current in Crumb, with Undo');
}, { height: 1000 });
await r.flow('as=rina&mode=board&group=state&arrive=never', 'r7-env-needs-you-03-rina-none', 'Needs you as Rina (Engineer in Crumb): no Crumb instructions proposal; proposals go to the project’s Leads only', { height: 1000 });

// ── The workspace's Environment popover ──
await r.session('as=theo&open=kitchen-display-queue&arrive=never', async (page, step) => {
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await scrollTo(page, '[data-workspace-profiles]');
  await step('r7-env-popover-01-profiles', 'kitchen-display-queue’s Environment as Theo: Crumb’s machine profiles on crumb-cell-1 (Web ready, iOS not set up), placement prefers Maya’s MacBook Pro, Add a profile; then the secrets his turns may use, each with its rule');
  await page.locator('[data-workspace-profiles]').getByRole('button', { name: 'Add a profile' }).click();
  await page.waitForTimeout(300);
  await step('r7-env-popover-02-add', 'Add a profile for this workspace only: Data is the one left in the team’s library');
  await page.locator('[data-add-profile]').getByRole('button', { name: /^Data/ }).click();
  await page.waitForTimeout(400);
  await step('r7-env-popover-03-added', 'Data added here: crumb-cell-1’s Data setup waits for an Admin’s approval');
  await scrollTo(page, '[data-workspace-secrets]');
  await step('r7-env-popover-04-secrets', 'Secrets Theo’s turns may use here: each with its rule line (who, while holding, delivery); ones his roles don’t cover are dimmed with why');
}, { height: 1000 });
await r.session('as=sam&open=offline-drafts&arrive=never', async (page, step) => {
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await scrollTo(page, '[data-workspace-profiles]');
  await step('r7-env-popover-05-sam-ios-added', 'offline-drafts (Field notes) as Sam: Web from the project and iOS added for this workspace, neither set up on crumb-cell-1; Maya’s MacBook Pro is ready for both');
}, { height: 1000 });
await r.session('as=rina&open=slot-holds&arrive=never', async (page, step) => {
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await scrollTo(page, '[data-workspace-secrets]');
  await step('r7-env-popover-06-rina-shells', 'slot-holds as Rina: the secrets her turns may use, each with its rule; ones her roles don’t cover dimmed with why; REDIS_URL and her own AWS_SANDBOX open in cleared shells with minutes left; SENTRY_AUTH_TOKEN offers Step up');
}, { height: 1000 });

await r.finish();
