// Round 8 · MCP servers hosted on machines: the "Hosted on machines" section of You › Plugins and Crumb & Co › Plugins
// (with the offline connection), the Add MCP server wizard (each step; errors: machine offline, command not found,
// exited at start with the stderr tail, a GitSpace secret its rule refuses; a Member refused team machines; success,
// personal and team), the project Plugins toggle, the workspace's tool list in the Environment popover (offline tools
// and the relay note), the live Machines panels and Sessions.
// Shots into $OUT as r8-mcp-*.png with captions in r8-mcp-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('r8-mcp-captions.txt');
const settings = (as, page) => `as=${as}&view=settings&page=${page}`;
const flow = (page) => page.locator('[data-flow="machine-mcp"]');
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
const fill = (scope, label, value) => scope.getByRole('textbox', { name: label, exact: true }).first().fill(value);
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
async function pick(page, scope, trigger, option) {
  await scope.getByRole('combobox', { name: trigger }).first().click();
  await page.getByRole('option', { name: option }).first().click();
}
const scrollTo = (page, selector) => page.locator(selector).first().evaluate((element) => element.scrollIntoView({ block: 'start' }));
const H = { height: 1000 };

// ── Plugins pages ──
await r.session(settings('maya', 'my-plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-figma-desktop"]');
  await page.mouse.wheel(0, -160);
  await step('r8-mcp-my-plugins-01-maya', 'You › Plugins › Custom MCP as Maya: new “Hosted on machines · You” section with Add MCP server. Figma Desktop MCP on Maya’s MacBook Pro (local URL, running, 4 tools, 23 calls in the last hour) and xcodebuild MCP (stopped); each says only her workspaces and agents use it, that credentials stay on the machine (APPLE_TEAM_ID from its own store, no value shown), and that calls go through the relay to the MacBook');
}, { height: 1100 });
await r.session(settings('maya', 'plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-kitchen-printer"]');
  await page.mouse.wheel(0, -160);
  await step('r8-mcp-plugins-02-team', 'Crumb & Co › Plugins › Custom MCP as Maya (Owner): “Hosted on machines · Team”: kitchen-printer MCP on the Back-office Mac mini (on in Crumb), ledger-fixtures MCP on ledger-cloud-2 (Unavailable), crumb-db-inspector on crumb-cell-1 (on in Crumb, 64 calls in the last hour); each with where its credentials come from and the relay note');
  await scrollTo(page, '[data-machine-mcp="mcp-ledger-fixtures"]');
  await page.mouse.wheel(0, -60);
  await step('r8-mcp-plugins-03-offline-connection', 'The offline connection: ledger-fixtures MCP stays listed, marked Unavailable, with “Unavailable: ledger-cloud-2 is offline · its 3 tools stay listed” and its tools dimmed; Start/Stop dimmed with the reason; FIXTURES_TOKEN from the machine’s store, AWS_REGION from GitSpace secrets, values never shown');
}, { height: 1100 });
await r.session(settings('rina', 'plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-kitchen-printer"]');
  await page.mouse.wheel(0, -260);
  const add = page.getByRole('button', { name: 'Add MCP server', exact: true });
  await add.hover();
  await page.waitForTimeout(500);
  await step('r8-mcp-plugins-04-member-refused', 'Crumb & Co › Plugins as Rina (Member): the team section is Read only; Add MCP server is dimmed and says why (“Your account role (Member) can’t manage team plugins and skills”); pressing it says so too');
  await add.click({ force: true });
  await step('r8-mcp-plugins-05-member-refused-toast', 'Rina presses Add MCP server on the team page: refused with the same reason; nothing opens');
}, H);

// ── Wizard, personal (Maya from You › Plugins): each step and every error ──
await r.session(settings('maya', 'my-plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-figma-desktop"]');
  await page.mouse.wheel(0, -260);
  await press(page, 'Add MCP server');
  const d = flow(page);
  await step('r8-mcp-wizard-01-where', 'Add an MCP server on a machine, step 1 Where it runs (Maya, Owner): her own machines (MacBook Pro online, maya-gpu offline) and the team’s (crumb-cell-1, ledger-cloud-2 offline, crumb-ec2 fleet, Back-office Mac mini), each with its kind, state and how many servers it hosts');
  await choose(d, 'maya-vm');
  await press(d, 'Continue');
  await step('r8-mcp-wizard-02-how', 'Step 2 How it starts: name, Run a command or A local URL, command and arguments (npx -y ios-simulator-mcp), and its environment: APPLE_TEAM_ID from the machine’s own store, or a GitSpace secret; the machine’s store names are listed, never values');
  await press(d, 'Continue');
  await press(d, 'Start it and list its tools');
  await page.waitForTimeout(1700);
  await step('r8-mcp-wizard-03-machine-offline', 'Step 3 Test, error “machine offline”: maya-gpu is offline (last heartbeat stopped yesterday), so nothing started; start it from Machines or go Back and pick one that’s online');
  await press(d, 'Back');
  await press(d, 'Back');
  await choose(d, 'maya-mbp');
  await press(d, 'Continue');
  await fill(d, 'Command', 'ios-sim-mcp');
  await press(d, 'Continue');
  await press(d, 'Start it and list its tools');
  await page.waitForTimeout(1700);
  await step('r8-mcp-wizard-04-command-not-found', 'Test, error “command not found”: ios-sim-mcp isn’t on Maya’s MacBook Pro’s PATH; install it there or use one it has (npx, bunx, uvx, node …)');
  await press(d, 'Back');
  await fill(d, 'Command', 'npx');
  await fill(d, 'Variable 1', 'SIM_DEVICE');
  await step('r8-mcp-wizard-05-not-in-store', 'How it starts: SIM_DEVICE from the machine’s store isn’t there yet: the hint says to set it on the machine with gitspace machine secret set SIM_DEVICE; the value never leaves the machine');
  await press(d, 'Continue');
  await press(d, 'Start it and list its tools');
  await page.waitForTimeout(1700);
  await step('r8-mcp-wizard-06-exited-at-start', 'Test, error “exited at start”: code 1, with the tail of its stderr (Error: SIM_DEVICE is not set … process exited with code 1 after 0.4 s) and what to do');
  await press(d, 'Back');
  await fill(d, 'Variable 1', 'APPLE_TEAM_ID');
  await press(d, 'Add variable');
  await fill(d, 'Variable 2', 'NPM_TOKEN');
  await pick(page, d, 'Source of variable 2', 'GitSpace secret');
  await pick(page, d, 'Secret for variable 2', 'CLOUDFLARE_API_TOKEN · team');
  await press(d, 'Continue');
  await scrollTo(page, '[data-env-row="1"]');
  await step('r8-mcp-wizard-07-secret-refused', 'How it starts, error: a GitSpace secret under its rule: CLOUDFLARE_API_TOKEN is a team secret, and team secrets go only to servers on team machines');
  await pick(page, d, 'Secret for variable 2', 'NPM_TOKEN · yours');
  await scrollTo(page, '[data-env-row="1"]');
  await step('r8-mcp-wizard-08-secret-ok', 'Her own NPM_TOKEN (its rule isn’t limited to approved scripts): GitSpace hands it to the process at start; the value is never shown here or to agents');
  await press(d, 'Continue');
  await press(d, 'Start it and list its tools');
  await page.waitForTimeout(1700);
  await step('r8-mcp-wizard-09-tools', 'Test passes: started on Maya’s MacBook Pro in 0.8 s, MCP 2025-06-18, and its tool list: boot_simulator, install_app, tap, screenshot, record_video, each with what it does');
  await press(d, 'Continue');
  await step('r8-mcp-wizard-10-who-personal', 'Step 4 Who can use it, personal: only Maya (workspaces she holds, her agents’ turns, in projects that allow holders’ own plugins); summary with credentials staying on the MacBook and calls through the relay');
  await press(d, 'Add server');
  await step('r8-mcp-wizard-11-success-personal', 'Success: ios-simulator MCP is running on Maya’s MacBook Pro; only her workspaces and agents use it; credentials stay there; calls go through the relay to it');
  await press(d, 'Done');
  await scrollTo(page, '[data-machine-mcp="mcp-figma-desktop"]');
  await page.mouse.wheel(0, 200);
  await step('r8-mcp-wizard-12-new-row', 'You › Plugins after: the new ios-simulator MCP row (running, 5 tools, APPLE_TEAM_ID from the machine’s store and NPM_TOKEN from GitSpace secrets, relay note)');
}, { height: 1100 });

// ── Wizard, team (Maya from Crumb & Co › Plugins) ──
await r.session(settings('maya', 'plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-kitchen-printer"]');
  await page.mouse.wheel(0, -260);
  await press(page, 'Add MCP server');
  const d = flow(page);
  await choose(d, 'counter-mini');
  await step('r8-mcp-team-01-where', 'Add MCP server from the team page (Maya, Owner): the Back-office Mac mini (team) picked; it hosts 1 server already');
  await press(d, 'Continue');
  await step('r8-mcp-team-02-how', 'How it starts on the Mac mini: uvx label-printer-mcp --printer QL-820NWB with PRINTER_TOKEN from the machine’s own store (it’s there: the value stays on the machine)');
  await pick(page, d, 'Source of variable 1', 'GitSpace secret');
  await pick(page, d, 'Secret for variable 1', 'SENTRY_DSN · team');
  await press(d, 'Continue');
  await scrollTo(page, '[data-env-row="0"]');
  await step('r8-mcp-team-03-secret-rule', 'Team server, error under the secret’s rule: SENTRY_DSN’s rule hands it only to approved scripts; change its rule in Secrets, or keep the value in the machine’s own store');
  await pick(page, d, 'Secret for variable 1', 'SQUARE_ACCESS_TOKEN · team');
  await press(d, 'Continue');
  await scrollTo(page, '[data-env-row="0"]');
  await step('r8-mcp-team-03b-holder-refused', 'Team server, error: SQUARE_ACCESS_TOKEN’s rule gives it only while someone holds the workspace’s handle, and a team server has no holder, so a team server never takes it');
  await pick(page, d, 'Source of variable 1', 'Machine’s own store');
  await press(d, 'Continue');
  await press(d, 'Start it and list its tools');
  await page.waitForTimeout(1700);
  await step('r8-mcp-team-04-tools', 'Test passes on the Mac mini: print_label, list_templates, printer_status');
  await press(d, 'Continue');
  await step('r8-mcp-team-05-who', 'Who can use it, team: the projects that turn it on (Crumb picked; Leads change it in project settings › Plugins); each person uses its tools within their role');
  await press(d, 'Add server');
  await step('r8-mcp-team-06-success', 'Success: label-printer MCP is running on the Back-office Mac mini, on in Crumb; credentials stay there; in the audit log');
}, { height: 1100 });

// ── A Member's wizard: team machines refused ──
await r.session(settings('rina', 'my-plugins'), async (page, step) => {
  await scrollTo(page, '[data-machine-mcp="mcp-postgres-local"]');
  await page.mouse.wheel(0, -260);
  await step('r8-mcp-my-plugins-06-rina', 'You › Plugins as Rina (Member): postgres-local on rina-workstation, running, 41 calls in the last hour; DATABASE_URI from the machine’s store and her AWS_SANDBOX from GitSpace secrets');
  await press(page, 'Add MCP server');
  await step('r8-mcp-wizard-13-member-team-refused', 'Rina (Member) opens Add MCP server: her own machines are open; every team machine is closed with “Only Owners and Admins add a server to a team machine”');
}, H);

// ── Project settings › Plugins ──
await r.session('as=maya&view=project-settings&project=crumb&page=plugins', async (page, step) => {
  await scrollTo(page, '[data-project-machine-mcp="mcp-kitchen-printer"]');
  await page.mouse.wheel(0, -160);
  await step('r8-mcp-project-01-toggles', 'Crumb › Project settings › Plugins: new “Hosted on machines” section: kitchen-printer MCP and crumb-db-inspector on, ledger-fixtures MCP off and marked “Unavailable: ledger-cloud-2 is offline” with its tools still listed; each with the relay note');
  await page.getByRole('switch', { name: 'ledger-fixtures MCP on in Crumb' }).click();
  await step('r8-mcp-project-02-toggle-offline', 'Turning ledger-fixtures MCP on in Crumb: its tools join Crumb’s workspaces at their next turn, each person within their role; ledger-cloud-2 is offline now, so they show as unavailable until it’s back');
  await press(page.locator('[data-flow="machine-mcp-toggle"]'), 'Turn on');
  await step('r8-mcp-project-03-toggle-done', 'Done: ledger-fixtures MCP is on in Crumb; in the audit log under Maya');
}, H);
await r.flow('as=sam&view=project-settings&project=crumb&page=plugins', 'r8-mcp-project-04-sam-read-only', 'Crumb › Plugins as Sam (Designer): Hosted on machines is Read only; the switches are disabled', { height: 1000, act: async (page) => { await scrollTo(page, '[data-project-machine-mcp="mcp-kitchen-printer"]'); await page.mouse.wheel(0, -160); } });

// ── The workspace's tool list ──
await r.session('as=theo&open=bank-feed-sync&arrive=never&env=open', async (page, step) => {
  await scrollTo(page, '[data-machine-tools]');
  await page.locator('[data-environment-popup]').evaluate((element) => { element.scrollTop -= 60; });
  await page.mouse.move(700, 600);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await step('r8-mcp-workspace-01-offline-tools', 'bank-feed-sync (Ledger) as Theo, Environment popover: “Tools from MCP servers on machines”: ledger-fixtures MCP (team, on in Ledger) marked “Unavailable: ledger-cloud-2 is offline”, its tools listed with the same reason instead of disappearing; Rina’s postgres-local (hers, while she holds), only her turns; each with its relay note');
}, H);
await r.session('as=maya&open=slot-holds&arrive=never&env=open', async (page, step) => {
  await scrollTo(page, '[data-machine-tools]');
  await page.locator('[data-environment-popup]').evaluate((element) => { element.scrollTop -= 60; });
  await page.mouse.move(700, 600);
  await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
  await step('r8-mcp-workspace-02-relay-note', 'slot-holds (Crumb) as Maya: kitchen-printer MCP and crumb-db-inspector (team, on in Crumb) with “calls go through the relay to crumb-cell-1”; her own Figma Desktop and xcodebuild (stopped) MCPs, and Rina’s postgres-local (only Rina’s turns)');
}, H);

// ── Live ──
await r.session('as=maya&view=machines', async (page, step) => {
  await scrollTo(page, '[data-panel="crumb-cloud-1"]');
  await page.mouse.wheel(0, -60);
  await step('r8-mcp-machines-01-team', 'Live Machines (full width), team machines: each panel lists the MCP servers it hosts: crumb-cell-1 crumb-db-inspector running, 64 calls in the last hour; ledger-cloud-2 ledger-fixtures MCP Unavailable (tools listed, no calls while offline); Back-office Mac mini kitchen-printer MCP running');
  await scrollTo(page, '[data-panel="maya-mbp"]');
  await page.mouse.wheel(0, -60);
  await step('r8-mcp-machines-02-people', 'People’s machines: Maya’s MacBook Pro hosts Figma Desktop MCP (running, 23 calls) and xcodebuild MCP (stopped); rina-workstation hosts postgres-local (running, 41 calls)');
}, { width: 1600, height: 1500 });
await r.session('as=rina&view=machines', async (page, step) => {
  await scrollTo(page, '[data-panel="ledger-cloud-2"]');
  await page.mouse.wheel(0, -60);
  await step('r8-mcp-machines-03-lead', 'Live Machines as Rina (Member; Lead in Ledger): a project’s Leads see that project’s team MCP servers: ledger-cloud-2 with ledger-fixtures MCP, on in Ledger (Unavailable while offline)');
}, { width: 1600, height: 1500 });
await r.session('as=maya&view=sessions&who=everyone', async (page, step) => {
  await step('r8-mcp-sessions-01-stat', 'Sessions, Everyone: new stat “MCP servers on machines”: 5 sessions on 4 servers, with their calls');
  await page.getByRole('heading', { name: 'MCP servers on machines' }).evaluate((element) => element.scrollIntoView({ block: 'start' }));
  await step('r8-mcp-sessions-02-panel', 'Sessions › MCP servers on machines: active sessions per server (crumb-db-inspector: Maya in slot-holds, Deps bot in deps-week-48; kitchen-printer: Theo; Figma Desktop: Maya; postgres-local: Rina), with since, calls and the relay note');
}, H);

await r.finish();
