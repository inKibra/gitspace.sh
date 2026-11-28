// Screenshots of the teams mock's shell (the striped mock strip, the sidebar's nine-icon rail, board, workspace,
// Inbox) with headless Chromium into OUT (see shots-lib.mjs), and every console error or warning the pages logged.
import { chromium } from '@playwright/test';
import { MOCK_URL, OUT } from './shots-lib.mjs';

const browser = await chromium.launch();
const problems = [];
const captions = [];

async function open(path, scheme = 'light', viewport = { width: 1600, height: 960 }) {
  const context = await browser.newContext({ viewport, colorScheme: scheme, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') problems.push(`${path} · ${message.type()}: ${message.text()}`); });
  page.on('pageerror', (error) => problems.push(`${path} · pageerror: ${error.message}`));
  await page.goto(`${MOCK_URL}${path.slice(1)}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(800);
  return { page, context };
}

async function shot(page, name, caption) {
  await page.screenshot({ path: `${OUT}/${name}.png` });
  captions.push(`${name}.png — ${caption}`);
  console.log(`shot ${name}`);
}

// 1. The list and slot-holds as Maya (Owner): holders on every row, Free marks, two holders in the header; Theo's
// request arrives a moment later.
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=600', 'light');
  await page.waitForTimeout(1200);
  await shot(page, '01-maya-list-workspace-two-holders-light', 'Maya (Owner, implicitly Lead everywhere): sidebar rows with holder avatars and Free marks; slot-holds held by Maya and Rina, labelled prompts, the credential that paid, Theo’s handle request just arrived');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=now', 'dark');
  await shot(page, '02-maya-list-workspace-dark', 'Same, dark');
  await context.close();
}

// 2. Environment popover by scope, with the paying credential and the rotation.
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=now', 'light');
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-environment-popup]').evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(200);
  await shot(page, '03a-environment-top-payer-git', 'Environment, top: who pays (the Default profile allows Anthropic subscription and API key as holders’ own), then Git: each repository’s route (GitHub App crumb-co / crumb-labs, short-lived tokens) and “commits as Maya Okafor <maya@crumbco.example>”, the turn starter');
  await page.locator('[data-environment-popup]').evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.waitForTimeout(200);
  await shot(page, '03-environment-popover-rina-out-using-maya', 'Environment, scrolled down: Team resources, workspace credentials, each holder’s own (Rina’s OpenAI key dimmed: “Provider not allowed in this profile”), step-ups, detached processes');
  await page.keyboard.press('Escape');
  // Accept Theo: he joins as a holder and his credential enters the rotation.
  await page.locator('[data-handle-requests]').getByRole('button', { name: 'Add Theo' }).click();
  await page.waitForTimeout(700);
  await shot(page, '04-request-accepted-three-holders', 'Maya accepts Theo’s request: three holder chips, “Theo now holds the handle” in the conversation');
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await shot(page, '05-environment-after-theo-joins', 'Environment after Theo joins: Maya’s stays sticky, Theo’s is next (least spent today), his machine and browser attached');
  await page.keyboard.press('Escape');
  await context.close();
}

// 3. Notes: Sam (Designer, not a holder) sees the note composer and the notes beside it; Maya sends Sam's note on.
{
  const { page, context } = await open('/?as=sam&open=slot-holds&arrive=never', 'light');
  await page.locator('[data-slot="input-message"] textarea, [data-slot="input-message"] [contenteditable]').first().click();
  await page.keyboard.type('Can the held slot pulse once when it is about to expire?');
  await page.waitForTimeout(300);
  await shot(page, '06-sam-non-holder-notes-composer', 'Sam (Designer in Crumb, no handle): composer leaves notes, notes beside it, Ask for the handle; Take over refused by role');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(500);
  const takeOver = page.locator('[data-holder-chips]').getByRole('button', { name: 'Take over' });
  await takeOver.hover();
  await page.waitForTimeout(700);
  await shot(page, '07-sam-takeover-refused-tooltip', 'Sam hovers Take over: the reason names his project role in Crumb (Designer)');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=never', 'light');
  await page.locator('[data-note="n-sam-countdown"]').getByRole('button').first().click();
  await page.waitForTimeout(600);
  await page.locator('[data-prompt]').last().scrollIntoViewIfNeeded();
  await shot(page, '08-maya-sends-sams-note', 'Maya (holder) sends Sam’s note to the agent: it lands as Maya’s prompt marked “note from Sam”');
  await page.locator('[data-proposal]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, '09-agent-proposes-review', 'The agent proposes moving to Review; a holder whose role allows it accepts, once the pull request’s CI checks pass: #41’s fail, so Review waits');
  await page.locator('[data-proposal]').getByRole('button', { name: /Accept/ }).click({ force: true });
  await page.waitForTimeout(800);
  await shot(page, '10-proposal-held-by-ci', 'Maya presses Accept: held, the toast says CI checks on #41 fail and Review waits until they pass');
  await page.locator('[data-commits]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, '11-change-guide-commits-attribution', 'Change Guide PR card: author = turn starter, Co-authored-by the other holders who prompted, GitSpace committer, conversation trailer');
  await context.close();
}

// 4. The board as different users.
{
  const { page, context } = await open('/?as=maya&mode=board&group=state&arrive=now', 'light');
  await shot(page, '12-board-maya-inbox', 'Board by State (Needs you · Failed · Running · Waiting) as Maya: Needs you = her Inbox (her questions, Theo’s request inside slot-holds, approvals her role decides, account rows); holders and handle actions on every card');
  await page.getByRole('button', { name: 'Sidebar view' }).hover();
  await page.waitForTimeout(600);
  await shot(page, '12b-board-sidebar-view', 'The whole board’s header matches the product’s BoardView: “Board · 15 workspaces in 3 projects” and, at the right, the ghost icon button “Sidebar view” (the panel-left icon) in place of the mock’s old “Narrow”; beside a workspace, that workspace’s own sidebar toggle does it');
  await context.close();
}
{
  const { page, context } = await open('/?as=rina&mode=board&group=state&arrive=now', 'dark');
  await shot(page, '13-board-rina-inbox-dark', 'Board as Rina (Member; Engineer in Crumb, Lead in Ledger): sees two projects; her Inbox has Sam’s request for slot-picker-ui and the questions of workspaces she holds');
  await context.close();
}
{
  const { page, context } = await open('/?as=jules&mode=board&group=state&arrive=never', 'light');
  await shot(page, '14-board-jules-member', 'Board as Jules (Member at crumbco.example; Contributor in Crumb): only Crumb; refused handle actions greyed with reasons');
  const card = page.locator('[data-card="checkout-apple-pay"]');
  await card.evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await card.locator('[data-refused]').first().click({ force: true });
  await page.waitForTimeout(400);
  await shot(page, '15-jules-claim-refused-toast', 'Jules (Contributor) clicks Take over on Maya’s workspace: the toast names his project role');
  await context.close();
}
{
  const { page, context } = await open('/?as=sam&mode=board&group=phase&arrive=never', 'dark');
  const card = await page.locator('[data-card="loyalty-stamps"]').boundingBox();
  const target = await page.locator('[data-column="code"]').boundingBox();
  await page.mouse.move(card.x + 80, card.y + 20);
  await page.mouse.down();
  for (let step = 1; step <= 10; step++) await page.mouse.move(card.x + 80 + ((target.x + 120 - card.x - 80) * step) / 10, card.y + 20 + step * 12);
  await page.waitForTimeout(300);
  await shot(page, '16-sam-drag-into-code-refused', 'Sam (Designer in Crumb) drags loyalty-stamps toward Code: the column says “Your project role in Crumb (Designer) can’t move into Code”');
  await page.mouse.up();
  await page.waitForTimeout(500);
  await shot(page, '17-sam-drop-refused-toast', 'Dropped: refused, the card stays in Plan');
  await context.close();
}
{
  const { page, context } = await open('/?as=theo&mode=board&group=state&open=kitchen-display-queue&arrive=never', 'light');
  await shot(page, '18-board-theo-lead-with-workspace', 'Board as Theo (Admin; Lead in Crumb and Ledger, not in Field notes so it’s hidden) with kitchen-display-queue beside it: his Inbox has the environment approvals (routed by project role) and Deps bot’s card shows the bot holding its handle');
  await context.close();
}
{
  const { page, context } = await open('/?as=sam&open=slot-picker-ui&arrive=never', 'light');
  await page.locator('[data-workspace="slot-picker-ui"]').hover();
  await page.getByRole('button', { name: 'Space actions for slot-picker-ui' }).click();
  await page.waitForTimeout(400);
  await shot(page, '19-sam-row-menu-refusals', 'Sam’s row menu: Ask allowed, Take over refused, phase items refused into Code/Ship with reasons');
  await context.close();
}

{
  const { page, context } = await open('/?as=maya&mode=board&group=state&open=slot-holds&arrive=now', 'light');
  await shot(page, '20-board-maya-slot-holds-beside', 'Board as Maya with slot-holds beside it: holder avatars, request count, Environment in the narrow header');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=never', 'light');
  await page.locator('[data-rail="services"]').hover();
  await page.waitForTimeout(600);
  await shot(page, '21-rail-nine-icons', 'The sidebar rail is exactly Board (with the needs-you count), Projects, People, Services, Machines, Browsers, Sessions, Usage, Settings; the striped strip above is the mock’s View as, not product navigation');
  await context.close();
}
{
  const { page, context } = await open('/?as=rina&mode=board&group=state&arrive=never', 'light');
  await page.locator('[data-account-item="acc-automation"]').scrollIntoViewIfNeeded();
  await shot(page, '21b-board-failed-automation', 'Board as Rina (Lead in Ledger): Needs you heads with the failed automation run “Morning bank-feed import” (Open log, Automation settings, Run again), beside the machine-offline row; the “+” beside Board makes a new project');
  await context.close();
}

// 5. People's MCP clients act as the person: "Maya via Claude Code" in the transcript, sharing her handle; Release
// bot's comment beside the composer.
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=never', 'light');
  await page.locator('[data-prompt="p-cc"]').evaluate((element) => element.scrollIntoView({ block: 'center' }));
  await page.locator('[data-client]').hover();
  await page.waitForTimeout(600);
  await shot(page, '22-transcript-maya-via-claude-code', 'slot-holds transcript: a prompt from “Maya via Claude Code” (her MCP client, under her handle); beside the composer a note from “Release bot (sponsored by Theo)”');
  await context.close();
}

// 6. A workspace held by a bot: Deps bot (sponsored by Maya) holds deps-week-48 in Crumb.
{
  const { page, context } = await open('/?as=maya&open=deps-week-48&arrive=never', 'light');
  await shot(page, '23-bot-held-workspace', 'deps-week-48 held by “Deps bot (sponsored by Maya)”: its prompts read “Deps bot (sponsored by Maya) via Claude Code”, “Turn started by Deps bot · using the team’s key · bots use team credentials only”, the claim event');
  await page.locator('[data-script-card="vitest-codemod"]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.waitForTimeout(300);
  await shot(page, '24-bot-proposals-maya-accepts', 'Deps bot submits a script (apply-vitest-codemod) for approval; bots never approve, Maya (Lead) can approve it for Crumb; and it proposes moving to Review, refused for the bot by its own role: “Deps bot’s project role in Crumb (Contributor) can’t move into Review”; Maya’s Accept waits for #46’s CI checks, still running');
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-environment-popup]').evaluate((element) => { element.scrollTop = 0; });
  await page.waitForTimeout(200);
  await shot(page, '25-bot-environment', 'Environment of the bot-held workspace: the team key pays, Git commits as Deps bot (the bot is the author), and the machine profiles it needs on crumb-cell-1 (Web ready, iOS not set up there)');
  await context.close();
}
{
  const { page, context } = await open('/?as=jules&open=deps-week-48&arrive=never', 'light');
  await page.locator('[data-script-card="vitest-codemod"]').evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await page.locator('[data-proposal]').getByRole('button', { name: /Accept/ }).hover();
  await page.waitForTimeout(700);
  await shot(page, '26-bot-workspace-jules-refused', 'Jules (Contributor) on the bot’s workspace: Accept refused by his own role; the script card routes approval to Crumb’s Leads; the header offers “Ask Maya (its sponsor)” because a bot answers no requests');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&mode=board&group=state&arrive=never', 'light');
  await page.locator('[data-account-item="acc-env-proposal"]').scrollIntoViewIfNeeded();
  await shot(page, '26b-board-environment-proposal', 'Board as Maya (an Owner is Lead in every project): Needs you holds the instructions proposal “Crumb revision 8” from Deps bot in deps-week-48 (Review, Decline, Approve); it goes to Crumb’s Leads only');
  await page.locator('[data-account-item="acc-bot-blocked"]').scrollIntoViewIfNeeded();
  await page.waitForTimeout(300);
  await shot(page, '26d-board-bot-blocked', 'Needs you for Owners and Admins: “Support triage bot is blocked”: its sign-in is kept and refused, expires Dec 21 (30 days after) unless an Admin takes it over; they’re told again Dec 14 (Open bot, Take it over)');
  await context.close();
}
{
  const { page, context } = await open('/?as=rina&mode=board&group=state&arrive=never', 'light');
  const proposals = await page.locator('[data-account-item="acc-env-proposal"]').count();
  await shot(page, '26e-board-rina-no-proposal', `Board as Rina (Engineer in Crumb, Lead in Ledger): ${proposals ? 'ERROR: the Crumb proposal shows' : 'no Crumb environment proposal'}: proposals go to the project’s Leads only`);
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&mode=board&group=state&board=graph&arrive=never', 'light');
  await page.waitForTimeout(800);
  await shot(page, '12c-board-graph', 'Board › Graph (BoardView’s Columns / Graph toggle beside the heading): account-web’s WorkspaceGraph with every workspace as a node, stacked-on, waits-on and related edges; clicking a node opens it beside');
  await page.getByRole('button', { name: 'Columns' }).click();
  await page.waitForTimeout(500);
  await shot(page, '12d-board-columns-again', 'Columns again from the same toggle');
  await context.close();
}
{
  const { page, context } = await open('/?as=theo&open=kitchen-display-queue&arrive=never', 'light');
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-workspace-profiles]').scrollIntoViewIfNeeded();
  await page.locator('[data-workspace-profiles]').getByRole('button', { name: 'Add a profile' }).click();
  await page.waitForTimeout(300);
  await shot(page, '26c-workspace-machine-profiles', 'kitchen-display-queue’s Environment: Crumb’s machine profiles on crumb-cell-1 (Web ready, iOS not set up; placement prefers Maya’s MacBook Pro), and Add a profile offers Data for this workspace only');
  await context.close();
}

// 7. The secrets a workspace may use in the Environment, by rule, and the holders' cleared shells (the old step-ups);
// Rina drops hers.
{
  const { page, context } = await open('/?as=rina&open=slot-holds&arrive=never', 'light');
  await page.locator('[data-environment]').click();
  await page.waitForTimeout(500);
  await page.locator('[data-step-ups]').scrollIntoViewIfNeeded();
  await shot(page, '27-environment-credential-kinds', 'Environment as Rina in slot-holds: the secrets her turns may use, each with its rule, and her cleared shell AWS_SANDBOX: what it unlocks, 38 min left, not shared with Maya, Drop');
  await page.locator('[data-step-up="su-rina-aws"]').getByRole('button', { name: 'Drop' }).click();
  await page.waitForTimeout(500);
  await shot(page, '28-environment-step-up-dropped', 'Rina drops her cleared shell: gone from the Environment; Step up with a passkey offered again');
  await context.close();
}

// 8. An Admin outside a project: Theo sees Field notes only as “not a member · Join project”; joining shows in the
// project's members and in the audit log.
{
  const { page, context } = await open('/?as=theo&open=kitchen-display-queue&arrive=never', 'light');
  await page.locator('[data-joinable="field-notes"]').scrollIntoViewIfNeeded();
  await shot(page, '29-theo-sidebar-join-project', 'Sidebar as Theo (Admin): Field notes listed as “not a member” with Join project; its workspaces stay hidden');
  await page.getByRole('button', { name: 'Join project Field notes' }).click();
  await page.waitForTimeout(500);
  await shot(page, '30-theo-join-dialog', 'Join Field notes: Theo picks his project role; the join is recorded in its members and the audit log');
  await page.getByRole('dialog').getByRole('button', { name: /^Join as / }).click();
  await page.waitForTimeout(700);
  await shot(page, '31-theo-joined-field-notes', 'Joined: the dialog’s success state; Field notes and its workspaces appear in Theo’s sidebar and its members see he joined');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  await page.locator('[data-rail="projects"]').click();
  await page.waitForTimeout(500);
  await shot(page, '31b-theo-projects-after-join', 'Projects after joining: Field notes is now a card like the others');
  await page.getByRole('main').getByRole('button', { name: 'Field notes settings' }).click();
  await page.waitForTimeout(600);
  await shot(page, '32-theo-joined-member-list', 'Field notes · project settings (a full page) · Members: Theo in the member list marked “Joined just now · Admin”');
  await page.locator('[data-back]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-rail="settings"]').click();
  await page.locator('[data-settings-nav="audit"]').click();
  await page.waitForTimeout(600);
  await shot(page, '33-theo-joined-audit', 'Settings → Crumb & Co → Audit log: “Joined Field notes as Lead with Join project (Admin, wasn’t a member)” at the top');
  await context.close();
}

// 9. Notes lifecycle: the writer edits or deletes their own; a holder sends or dismisses (the writer sees “Dismissed by
// Maya”); Past notes lists sent and dismissed ones; a Lead deletes anyone's (audited); archiving closes them.
{
  const { page, context } = await open('/?as=sam&open=slot-holds&arrive=never', 'light');
  await shot(page, '34-notes-writer-edit-delete', 'Sam (no handle) on slot-holds: his note has Edit and Delete; others’ notes have no actions for him; notes don’t expire');
  await page.getByRole('button', { name: 'Edit your note' }).first().click();
  await page.getByRole('textbox', { name: 'Edit note' }).fill('The countdown sits top-right in the picker, not under Pay (Figma: “Slot picker / held”, frame 3).');
  await page.waitForTimeout(300);
  await shot(page, '35-notes-writer-editing', 'Sam edits his note in place until a holder sends it');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&open=slot-holds&arrive=never', 'light');
  await page.getByRole('button', { name: 'Dismiss Jules’s note' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-past-toggle]').first().click();
  await page.waitForTimeout(400);
  await shot(page, '36-notes-holder-dismiss-past', 'Maya (holder) dismisses Jules’s note; Past notes lists sent and dismissed ones with who: “Sent by Maya”, “Dismissed by Rina”, “Dismissed by Maya”');
  await page.locator('[data-view-as="jules"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-rail="board"]').click();
  await page.waitForTimeout(700);
  await shot(page, '37-notes-writer-sees-dismissed', 'Jules’s Inbox: “Maya dismissed your note in slot-holds” (listed, not counted), under the earlier one from Rina');
  await context.close();
}
{
  const { page, context } = await open('/?as=theo&open=slot-holds&arrive=never', 'light');
  await page.getByRole('button', { name: 'Delete Sam’s note' }).first().hover();
  await page.waitForTimeout(600);
  await shot(page, '38-notes-lead-delete', 'Theo, Lead in Crumb but not a holder of slot-holds, can delete anyone’s note: “Delete as Lead · recorded in the audit log”');
  await page.getByRole('button', { name: 'Delete Sam’s note' }).first().click();
  await page.waitForTimeout(400);
  await page.locator('[data-rail="settings"]').click();
  await page.locator('[data-settings-nav="audit"]').click();
  await page.waitForTimeout(600);
  await shot(page, '39-notes-lead-delete-audit', 'Audit log: “Deleted Sam’s note in slot-holds as Lead: …”');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&open=old-hours-banner&arrive=never', 'light');
  await shot(page, '40-notes-closed-by-archive', 'An archived workspace (old-hours-banner): its open note is closed with the workspace');
  await context.close();
}

// 10. An Admin on someone's People page: Theo opens Rina, disconnects her Slack and drops her cleared shell; both are in the
// audit log and Rina is told in her Inbox. Viewing isn't logged.
{
  const { page, context } = await open('/?as=theo&view=people&arrive=never', 'light', { width: 1600, height: 1100 });
  await page.locator('[data-people-card="rina"]').click();
  await page.waitForTimeout(500);
  await shot(page, '41-theo-opens-rina', 'People › Rina as Theo (Admin): presence, roles, admin actions, the revoke-only banner and everything she has connected');
  await page.getByRole('button', { name: 'Disconnect Rina’s Slack' }).click();
  await page.waitForTimeout(500);
  await shot(page, '42-theo-revokes-rina-slack', 'Theo disconnects Rina’s Slack: it leaves her page; the toast says she’s told and it’s in the audit log');
  await page.getByRole('button', { name: 'Drop Rina’s AWS_SANDBOX' }).click();
  await page.waitForTimeout(500);
  await shot(page, '43-theo-drops-rina-step-up', 'Theo drops Rina’s cleared shell AWS_SANDBOX');
  await page.locator('[data-rail="settings"]').click();
  await page.locator('[data-settings-nav="audit"]').click();
  await page.waitForTimeout(600);
  await shot(page, '45-revoke-audit', 'Audit log: “Dropped Rina Ortiz’s cleared shell AWS_SANDBOX in slot-holds … (as Admin)” and “Disconnected Rina Ortiz’s Slack from their scope (as Admin)”');
  await page.locator('[data-back]').click();
  await page.locator('[data-view-as="rina"]').click();
  await page.waitForTimeout(400);
  await page.locator('[data-rail="board"]').click();
  await page.waitForTimeout(700);
  await shot(page, '46-rina-notified', 'Rina’s Inbox: “Theo disconnected your Slack” and “Theo dropped your cleared shell AWS_SANDBOX …” (listed, not counted)');
  await context.close();
}
{
  const { page, context } = await open('/?as=maya&view=settings&page=bots&arrive=never', 'light');
  await page.getByRole('button', { name: 'Open Deps bot' }).first().click();
  await page.waitForTimeout(500);
  await shot(page, '47-maya-opens-deps-bot', 'Maya (Owner), Deps bot’s sponsor, opens it from Crumb & Co › Bots: “Settings for” is Deps bot, its Profile, the same pages as hers');
  await context.close();
}

await browser.close();
console.log(`\n${captions.join('\n')}`);
await Bun.write(`${OUT}/captions.txt`, `${captions.join('\n')}\n`);
console.log(problems.length ? `\nconsole problems:\n${problems.join('\n')}` : '\nno console errors or warnings');
