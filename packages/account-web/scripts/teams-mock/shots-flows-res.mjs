// Screenshots of the resource pages' dialogs and wizards (Inference, Plugins, Browsers, my own secrets, Skills;
// the team's as Maya, the You pages as Maya or Rina, refusals as Sam): one shot per step, each error state and each
// success, into OUT with captions in f-res-captions.txt. Reports console errors and warnings.
import { runner } from './shots-lib.mjs';

const r = await runner('f-res-captions.txt');
const S = (query) => `view=settings&${query}`;
const dlg = (page, id) => page.locator(`[data-flow="${id}"]`);
const btn = (scope, name) => scope.getByRole('button', { name, exact: true }).first();
/** An InputField's label repeats its text in an aria-hidden sizing span, so it's found by that span; a TextArea by its label. */
async function fill(scope, label, value) {
  const exact = new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  const field = scope.locator('label').filter({ has: scope.page().locator('span[aria-hidden="true"]', { hasText: exact }) }).first();
  if (await field.count()) await scope.locator(`[id="${await field.getAttribute('for')}"]`).fill(value);
  else await scope.getByLabel(label, { exact: true }).fill(value);
}
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
async function select(page, label, option) {
  await page.getByRole('combobox', { name: label }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}
const wait = (page, ms) => page.waitForTimeout(ms);
const H = { height: 1000 };

// ── Crumb & Co › Inference ──
await r.session(S('as=maya&page=inference'), async (page, step) => {
  await btn(page, 'Add provider').click();
  const d = dlg(page, 'add-provider');
  await step('f-res-inference-01-add-provider-pick', 'Team › Inference › Add provider, step 1: API keys, AWS Bedrock or a local model; Claude and ChatGPT subscriptions are disabled with why (always someone’s own)');
  await btn(d, 'Continue').click();
  await fill(d, 'API key', 'abc123');
  await btn(d, 'Check key').click();
  await step('f-res-inference-02-add-provider-key-format', 'Step 2, Key: a key without the sk-ant- prefix is refused before it’s sent');
  await fill(d, 'API key', 'sk-ant-api03-short');
  await btn(d, 'Check key').click();
  await wait(page, 1300);
  await step('f-res-inference-03-add-provider-key-rejected', 'Key rejected by Anthropic (401), with where to copy the whole key again');
  await fill(d, 'API key', 'sk-ant-api03-Vq8m2LxR0bT5nYw3Zc7Hk1Pd9Fs4Ga6Jo2Ue8Ri0Nl5Mb3Xt7Ay');
  await btn(d, 'Check key').click();
  await wait(page, 1400);
  await step('f-res-inference-04-add-provider-name-profiles', 'Step 3: name it, the profiles it joins (last in their fallback order) and an optional daily cap');
  await fill(d, 'Daily spend cap in USD (optional)', 'forty');
  await btn(d, 'Save with passkey').click();
  await step('f-res-inference-05-add-provider-cap-error', 'A daily cap must be dollars');
  await fill(d, 'Daily spend cap in USD (optional)', '40');
  await btn(d, 'Save with passkey').click();
  await step('f-res-inference-06-add-provider-passkey', 'Saving a team provider asks Maya’s passkey');
  await wait(page, 1600);
  await step('f-res-inference-07-add-provider-done', 'Success: Team Anthropic key is last in Default’s fallback order; in the audit log');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await btn(page, 'Add provider').click();
  const d = dlg(page, 'add-provider');
  await choose(d, 'bedrock');
  await btn(d, 'Continue').click();
  await fill(d, 'Role ARN', 'arn:aws:iam::482193005512:role/gitspace-bedrock');
  await select(page, 'Region', 'us-west-2');
  await btn(d, 'Check role').click();
  await wait(page, 1300);
  await step('f-res-inference-08-add-bedrock-denied', 'AWS Bedrock: the role, region and external ID; Claude isn’t enabled in us-west-2, with how to request model access');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await btn(page, 'Add provider').click();
  const d = dlg(page, 'add-provider');
  await choose(d, 'local');
  await btn(d, 'Continue').click();
  await select(page, 'Machine', 'Back-office Mac mini · online');
  await fill(d, 'Endpoint on that machine', 'http://localhost:11500');
  await btn(d, 'Fetch models').click();
  await wait(page, 1200);
  await step('f-res-inference-09-add-local-unreachable', 'Local model: Ollama on the Back-office Mac mini; nothing answered on port 11500, with how to start Ollama');
  await fill(d, 'Endpoint on that machine', 'http://localhost:11434');
  await btn(d, 'Fetch models').click();
  await wait(page, 1200);
  await step('f-res-inference-10-add-local-models', 'Four models found; the ones to offer are picked');
  await btn(d, 'Continue').click();
  await step('f-res-inference-11-add-local-name', 'Step 3: its name and the profiles that may map roles to it');
  await btn(d, 'Save with passkey').click();
  await wait(page, 1700);
  await step('f-res-inference-12-add-local-done', 'Success: Ollama on the Back-office Mac mini, not billed');
  await btn(d, 'Done').click();
  await page.locator('[data-local-model]').first().scrollIntoViewIfNeeded();
  await step('f-res-inference-13-local-row', 'Team providers list the new key and the local model');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await btn(page, 'New profile').click();
  const d = dlg(page, 'new-profile');
  await btn(d, 'Continue').click();
  await step('f-res-inference-14-profile-name-error', 'New profile, step 1: a name is required');
  await fill(d, 'Profile name', 'Default');
  await btn(d, 'Continue').click();
  await step('f-res-inference-15-profile-name-taken', 'A name already used is refused');
  await fill(d, 'Profile name', 'Field notes (cheap)');
  await btn(d, 'Continue').click();
  await btn(d, 'Team OpenAI API key').click();
  await btn(d, 'Move Team OpenAI API key up').click();
  await d.getByRole('group', { name: 'Holders’ own providers' }).getByRole('button', { name: 'Anthropic subscription' }).click();
  await step('f-res-inference-16-profile-providers', 'Step 2: team providers in fallback order (OpenAI moved first) and which holders’ own kinds may pay');
  await btn(d, 'Remove').first().click();
  await btn(d, 'Remove').first().click();
  await btn(d, 'Continue').click();
  await step('f-res-inference-17-profile-providers-error', 'With no team provider the profile is refused, with why');
  await btn(d, 'Team OpenAI API key').click();
  await btn(d, 'Continue').click();
  await step('f-res-inference-18-profile-models', 'Step 3: a model per role from the profile’s providers, cheap ones suggested for smol and commit');
  await btn(d, 'Continue').click();
  await d.getByRole('group', { name: 'Projects' }).getByRole('button', { name: 'Field notes' }).click();
  await step('f-res-inference-19-profile-projects', 'Step 4: the projects that apply it (Field notes moves from Default) and the budget it’s linked to');
  await btn(d, 'Continue').click();
  await step('f-res-inference-20-profile-review', 'Step 5: review');
  await btn(d, 'Create profile').click();
  await step('f-res-inference-21-profile-done', 'Success: Field notes uses it from the next turn; in the audit log');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await page.getByRole('button', { name: 'Change the model for smol' }).click();
  const d = dlg(page, 'change-model');
  await choose(d, 'openai/gpt-6-mini');
  await step('f-res-inference-22-change-model', 'Models › Change: the models this profile’s providers offer');
  await btn(d, 'Save model').click();
  await step('f-res-inference-23-change-model-done', 'Success: smol now uses openai/gpt-6-mini');
}, H);

await r.flow(S('as=maya&page=inference&profile=ledger&ptab=providers'), 'f-res-inference-24-out-of-profile-refused', 'Ledger’s only team provider can’t leave the profile: the reason and the fix', {
  act: async (page) => { await page.getByRole('button', { name: 'Remove AWS Bedrock (crumb-prod) from Ledger (team keys only)' }).click(); },
});

await r.session(S('as=maya&page=inference&ptab=advanced'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit Compaction' }).click();
  const d = dlg(page, 'advanced');
  await fill(d, 'Compaction', '');
  await btn(d, 'Save').click();
  await step('f-res-inference-25-advanced-error', 'Advanced › Edit: a value is required');
  await fill(d, 'Compaction', 'At 70% of context');
  await btn(d, 'Save').click();
  await step('f-res-inference-26-advanced-done', 'Success: Compaction at 70%');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await page.getByRole('button', { name: 'Replace Team Anthropic API key' }).click();
  const d = dlg(page, 'replace-provider');
  await fill(d, 'New API key', 'sk-ant-api03-tooshort');
  await btn(d, 'Check and replace').click();
  await wait(page, 1300);
  await step('f-res-inference-27-replace-rejected', 'Replace: the new key is checked with Anthropic first; rejected, with the fix');
  await fill(d, 'New API key', 'sk-ant-api03-Vq8m2LxR0bT5nYw3Zc7Hk1Pd9Fs4Ga6Jo2Ue8Ri0Nl5Mb3Xt7Ay');
  await btn(d, 'Check and replace').click();
  await wait(page, 1250);
  await step('f-res-inference-28-replace-passkey', 'Accepted; replacing asks the passkey');
  await wait(page, 1600);
  await step('f-res-inference-29-replace-done', 'Success: turns from now pay with the new key');
}, H);

await r.flow(S('as=maya&page=inference'), 'f-res-inference-30-remove-refused', 'Remove AWS Bedrock: refused, Ledger has no other team provider; how to fix', {
  act: async (page) => { await page.getByRole('button', { name: 'Remove AWS Bedrock (crumb-prod)' }).click(); },
});
await r.session(S('as=maya&page=inference'), async (page, step) => {
  await page.getByRole('button', { name: 'Remove Team OpenAI API key' }).click();
  const d = dlg(page, 'remove-provider');
  await step('f-res-inference-31-remove-confirm', 'Remove Team OpenAI API key: its spend, last use and profiles; confirmed with a passkey');
  await btn(d, 'Remove with passkey').click();
  await wait(page, 1700);
  await step('f-res-inference-32-remove-done', 'Success: it left Default; in the audit log');
}, H);

await r.session(S('as=maya&page=inference'), async (page, step) => {
  await btn(page, 'Add budget').click();
  const d = dlg(page, 'budget');
  await select(page, 'Project', 'Crumb');
  await btn(d, 'Continue').click();
  await step('f-res-inference-33-budget-exists', 'Add budget (New, not in GitSpace yet), step 1: Crumb has a budget already: edit that one');
  await select(page, 'Project', 'Field notes');
  await btn(d, 'Continue').click();
  await fill(d, 'Amount (USD)', '2000');
  await btn(d, 'Continue').click();
  await step('f-res-inference-34-budget-over-team', 'Step 2: more than the team’s whole $1,500 a month is refused');
  await fill(d, 'Amount (USD)', '25.555');
  await btn(d, 'Continue').click();
  await step('f-res-inference-35-budget-format', 'Amounts are dollars with up to two decimals');
  await fill(d, 'Amount (USD)', '50');
  await select(page, 'Period', 'a week');
  await btn(d, 'Continue').click();
  await choose(d, 'stop');
  await d.getByRole('group', { name: 'Who’s told' }).getByRole('button', { name: 'Slack #releases' }).click();
  await step('f-res-inference-36-budget-limit', 'Step 3: stop new turns at the limit (holders’ own providers still pay), and who’s told');
  await btn(d, 'Continue').click();
  await step('f-res-inference-37-budget-review', 'Step 4: review, with the monthly equivalent');
  await btn(d, 'Save budget').click();
  await step('f-res-inference-38-budget-done', 'Success: $50 a week for Field notes');
  await btn(d, 'Done').click();
  await page.locator('[data-budget]').last().scrollIntoViewIfNeeded();
  await step('f-res-inference-39-budget-row', 'The new budget is listed, marked Stops new turns');
  await page.getByRole('button', { name: 'Edit the Ledger budget' }).click();
  await step('f-res-inference-40-budget-edit', 'Edit opens the same wizard at Amount, prefilled');
}, H);

await r.flow(S('as=sam&page=inference'), 'f-res-inference-41-member-refused', 'As Sam (Member): Add provider stays visible but dimmed, and says why', {
  act: async (page) => { await btn(page, 'Add provider').hover(); await wait(page, 600); },
});

// ── You › Inference ──
await r.session(S('as=theo&page=my-inference'), async (page, step) => {
  await btn(page, 'Connect a provider').click();
  const d = dlg(page, 'add-provider');
  await step('f-res-my-inference-01-pick', 'You › Inference › Connect a provider, step 1: Claude Pro or Max, ChatGPT, API keys or a local model');
  await btn(d, 'Continue').click();
  await step('f-res-my-inference-02-signin-start', 'Step 2, Sign in: the sign-in URL and Open sign-in page, as account-web’s sign-in flow');
  await btn(d, 'Open sign-in page').click();
  await step('f-res-my-inference-03-signin-tab', 'The provider’s page (a new tab): pick the account, Allow or Cancel');
  await btn(d, 'Cancel').click();
  await step('f-res-my-inference-04-signin-cancelled', 'Cancelled on claude.ai: nothing was connected; open it again');
  await btn(d, 'Open sign-in page again').click();
  await choose(d, 'personal');
  await btn(d, 'Allow').click();
  await step('f-res-my-inference-05-signin-waiting', 'Waiting for authorization');
  await wait(page, 1300);
  await step('f-res-my-inference-06-signin-wrong-account', 'Wrong account: a Claude Free account can’t be used; sign in with the Max account');
  await btn(d, 'Open sign-in page again').click();
  await choose(d, 'work');
  await btn(d, 'Allow').click();
  await wait(page, 1400);
  await step('f-res-my-inference-07-signin-done', 'Signed in to claude.ai as theo@crumbco.example');
  await btn(d, 'Continue').click();
  await step('f-res-my-inference-08-name-where', 'Step 3 (as Theo): name it; it may pay in Crumb (Default allows Anthropic subscriptions), not in Ledger (team keys only), and the holder rules');
  await btn(d, 'Connect').click();
  await step('f-res-my-inference-09-done', 'Success: Theo’s Claude Max is signed in');
}, H);

await r.session(S('as=rina&page=my-inference'), async (page, step) => {
  await btn(page, 'Connect a provider').click();
  const d = dlg(page, 'add-provider');
  await choose(d, 'chatgpt');
  await btn(d, 'Continue').click();
  await step('f-res-my-inference-10-chatgpt-device-code', 'As Rina: ChatGPT signs in with a device code at auth.openai.com');
}, H);

await r.session(S('as=maya&page=my-inference'), async (page, step) => {
  await btn(page, 'Connect a provider').click();
  const d = dlg(page, 'add-provider');
  await choose(d, 'local');
  await btn(d, 'Continue').click();
  await select(page, 'Machine', 'maya-gpu · sleeping');
  await btn(d, 'Fetch models').click();
  await wait(page, 1200);
  await step('f-res-my-inference-11-local-asleep', 'Local model on maya-gpu: it’s sleeping, wake it in Machines first');
}, H);

await r.session(S('as=maya&page=my-inference'), async (page, step) => {
  await page.getByRole('button', { name: 'Sign out Maya’s Claude Max' }).click();
  const d = dlg(page, 'sign-out-provider');
  await step('f-res-my-inference-12-sign-out', 'Sign out: what changes');
  await btn(d, 'Sign out').click();
  await step('f-res-my-inference-13-sign-out-done', 'Signed out');
}, H);

// ── Crumb & Co › Plugins ──
await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await btn(page, 'Add an MCP server').click();
  const d = dlg(page, 'team-plugin');
  await step('f-res-plugins-01-team-pick', 'Team › Plugins › Add an MCP server: GitHub, Linear, Sentry, the Slack app (installed: disabled with why) or a custom URL');
  await btn(d, 'Continue').click();
  await step('f-res-plugins-02-team-auth', 'Step 2: GitHub signs in as the team (install the app on crumb-co) or with a token');
  await btn(d, 'Open sign-in page').click();
  await choose(d, 'me');
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await step('f-res-plugins-03-team-wrong-account', 'Installed on Maya’s personal account: refused, pick the crumb-co organisation');
  await btn(d, 'Open sign-in page again').click();
  await choose(d, 'org');
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await step('f-res-plugins-04-team-signed-in', 'Signed in as the crumb-co organisation');
  await btn(d, 'Continue').click();
  await d.getByRole('group', { name: 'Projects' }).getByRole('button', { name: 'Ledger' }).click();
  await step('f-res-plugins-05-team-projects', 'Step 3: the projects it’s on in');
  await btn(d, 'Continue').click();
  await step('f-res-plugins-06-team-review', 'Step 4: review, acting as Crumb & Co');
  await btn(d, 'Connect').click();
  await step('f-res-plugins-07-team-done', 'Success: GitHub is on in Crumb and Ledger; in the audit log');
}, H);

await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await btn(page, 'Add an MCP server').click();
  const d = dlg(page, 'team-plugin');
  await choose(d, 'sentry');
  await btn(d, 'Continue').click();
  await fill(d, 'Sentry token', 'abc_123');
  await btn(d, 'Check token').click();
  await step('f-res-plugins-08-sentry-prefix', 'Sentry takes a token: one without the sntrys_ prefix is refused');
  await fill(d, 'Sentry token', ['sntrys', 'x'.repeat(49)].join('_'));
  await btn(d, 'Check token').click();
  await wait(page, 1300);
  await step('f-res-plugins-09-sentry-scope', 'The token is missing org:read: add it on sentry.io and check again (the token stays the same)');
  await btn(d, 'Check again').click();
  await wait(page, 1300);
  await step('f-res-plugins-10-sentry-ok', 'Token works with every scope');
}, H);

await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await btn(page, 'Add an MCP server').click();
  const d = dlg(page, 'team-plugin');
  await choose(d, 'custom');
  await btn(d, 'Continue').click();
  await fill(d, 'Server URL', 'http://mcp.crumb.example/mcp');
  await btn(d, 'Check server').click();
  await step('f-res-plugins-11-custom-https', 'Custom MCP URL: HTTPS only');
  await fill(d, 'Server URL', 'https://orders.crumb.internal/mcp');
  await btn(d, 'Check server').click();
  await wait(page, 1400);
  await step('f-res-plugins-12-custom-no-answer', 'The server didn’t answer from Cloudflare: put it behind a tunnel or a public address');
  await fill(d, 'Server URL', 'https://mcp.suppliers.crumbco.example/mcp');
  await btn(d, 'Check server').click();
  await wait(page, 1400);
  await choose(d, 'none');
  await step('f-res-plugins-13-custom-ok', 'It answered: 12 tools; sign in as the team, a token, or no sign-in');
}, H);

await r.session(S('as=maya&page=plugins&tab=composio'), async (page, step) => {
  await btn(page, 'Connect a toolkit as the team').click();
  const d = dlg(page, 'team-plugin');
  await step('f-res-plugins-14-composio-off', 'Composio › Connect a toolkit as the team: refused while the team’s Composio account is off, with the switch');
  await btn(d, 'Turn on the team Composio account').click();
  await choose(d, 'hubspot');
  await btn(d, 'Continue').click();
  await btn(d, 'Open sign-in page').click();
  await choose(d, 'test');
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await step('f-res-plugins-15-composio-wrong-portal', 'HubSpot signed in to the test portal: refused, pick the Crumb & Co portal');
}, H);

await r.session(S('as=maya&page=plugins&tab=composio'), async (page, step) => {
  await page.getByRole('switch', { name: 'Team Composio account' }).click().catch(async () => { await page.getByLabel('Team Composio account').click(); });
  const d = dlg(page, 'team-composio');
  await step('f-res-plugins-16-composio-switch', 'The Composio account switch asks first');
  await btn(d, 'Turn on').click();
  await step('f-res-plugins-17-composio-on', 'It’s on; in the audit log');
}, H);

await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await page.getByRole('button', { name: 'Configure Jira' }).click();
  const d = dlg(page, 'configure-plugin');
  await fill(d, 'Replace service token (optional)', 'short');
  await btn(d, 'Save').click();
  await step('f-res-plugins-18-configure-error', 'Configure Jira: replace its service token and its projects; a partial token is rejected');
  await fill(d, 'Replace service token (optional)', '');
  await d.getByRole('group', { name: 'Projects' }).getByRole('button', { name: 'Field notes' }).click();
  await btn(d, 'Save').click();
  await wait(page, 400);
  await step('f-res-plugins-19-configure-done', 'Success: Jira on in Crumb, Ledger and Field notes');
}, H);

await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await page.getByRole('button', { name: 'Configure Slack app' }).click();
  const d = dlg(page, 'slack-app');
  await step('f-res-plugins-20-slack-channels', 'The Slack app (installed once by Theo): each channel and the projects posting to it');
  await fill(d, 'Add a channel', '#field-notes');
  await btn(d, 'Add').click();
  await step('f-res-plugins-21-slack-not-invited', 'GitSpace isn’t in #field-notes: /invite @GitSpace first');
  await fill(d, 'Add a channel', '#design');
  await btn(d, 'Add').click();
  await d.getByRole('group', { name: 'Projects posting to #design' }).getByRole('button', { name: 'Field notes' }).click();
  await step('f-res-plugins-22-slack-added', '#design added, posting Field notes');
  await btn(d, 'Save channels').click();
  await step('f-res-plugins-23-slack-done', 'Success; in the audit log');
}, H);

await r.session(S('as=maya&page=plugins'), async (page, step) => {
  await page.getByRole('button', { name: 'Disconnect Crumb internal MCP' }).click();
  const d = dlg(page, 'disconnect-team-plugin');
  await step('f-res-plugins-24-disconnect', 'Disconnect a team plugin: the projects that lose it');
  await btn(d, 'Disconnect').click();
  await step('f-res-plugins-25-disconnect-done', 'Disconnected; in the audit log');
}, H);

await r.flow(S('as=sam&page=plugins'), 'f-res-plugins-26-member-refused', 'As Sam (Member): Add an MCP server is refused, with why', {
  act: async (page) => { await btn(page, 'Add an MCP server').hover(); await wait(page, 600); },
});

// ── Browsers (team and You) ──
await r.session(S('as=maya&page=my-plugins&tab=browsers'), async (page, step) => {
  await btn(page, 'Pair a Chrome').click();
  const d = dlg(page, 'pair-chrome');
  await step('f-res-browsers-01-install', 'You › Plugins › Pair a Chrome, step 1: install the extension (command, chrome://extensions, download)');
  await btn(d, 'It’s installed').click();
  await step('f-res-browsers-02-get-code', 'Step 2: get a pairing code');
  await btn(d, 'Get pairing code').click();
  await fill(d, 'Pairing code', 'K7P-000');
  await btn(d, 'Pair').click();
  await step('f-res-browsers-03-code-wrong', 'The code with its countdown; typed wrong in the extension’s popup');
  await fill(d, 'Pairing code', 'k7p-2qx');
  await btn(d, 'Pair').click();
  await wait(page, 1100);
  await step('f-res-browsers-04-fingerprint', 'Step 3: a Chrome answered; check the fingerprint matches its popup');
  await btn(d, 'It doesn’t match').click();
  await step('f-res-browsers-05-mismatch', 'It doesn’t match: GitSpace forgot that Chrome; start again');
  await btn(d, 'Start again').click();
  await fill(d, 'Pairing code', 'M4R-8TZ');
  await btn(d, 'Pair').click();
  await wait(page, 1100);
  await btn(d, 'It matches').click();
  await fill(d, 'Name this Chrome', 'Maya’s Chrome');
  await btn(d, 'Finish').click();
  await step('f-res-browsers-06-name-taken', 'Step 4: name it and approve it for projects; the name is taken');
  await fill(d, 'Name this Chrome', 'Maya’s work Chrome');
  await btn(d, 'Finish').click();
  await step('f-res-browsers-07-done', 'Success: paired, approved in Crumb');
}, H);

{
  const { page, context } = await r.open(S('as=maya&page=my-plugins&tab=browsers'));
  try {
    await page.clock.install();
    await page.reload({ waitUntil: 'networkidle' });
    await wait(page, 600);
    await btn(page, 'Pair a Chrome').click();
    const d = dlg(page, 'pair-chrome');
    await btn(d, 'It’s installed').click();
    await btn(d, 'Get pairing code').click();
    await page.clock.fastForward('05:02');
    await r.snap(page, 'f-res-browsers-08-code-expired', 'The code expired before a Chrome answered: get a new one');
  } catch (error) { console.error(`browsers expired: ${error.message.split('\n')[0]}`); }
  await context.close();
}

await r.session(S('as=maya&page=plugins&tab=browsers'), async (page, step) => {
  await btn(page, 'Pair a Chrome').click();
  const d = dlg(page, 'pair-chrome');
  await btn(d, 'It’s installed').click();
  await btn(d, 'Get pairing code').click();
  await fill(d, 'Pairing code', 'K7P2QX');
  await btn(d, 'Pair').click();
  await wait(page, 1100);
  await btn(d, 'It matches').click();
  await step('f-res-browsers-09-team-name', 'Team › Plugins › Browsers › Pair a Chrome for the team: name it and approve it for projects');
  await btn(d, 'Finish').click();
  await step('f-res-browsers-10-team-done', 'Success; in the audit log');
  await btn(d, 'Done').click();
  await page.getByRole('button', { name: 'Projects of Back-office Chrome' }).click();
  const p = dlg(page, 'browser-projects');
  await p.getByRole('group', { name: 'Approved in' }).getByRole('button', { name: 'Ledger' }).click();
  await step('f-res-browsers-11-projects', 'Projects: which projects a team Chrome is approved in');
  await btn(p, 'Save').click();
  await step('f-res-browsers-12-projects-done', 'Approved in Crumb and Ledger');
  await btn(p, 'Done').click();
  await page.getByRole('button', { name: 'Unpair Back-office Chrome' }).click();
  const u = dlg(page, 'unpair-browser');
  await step('f-res-browsers-13-unpair', 'Unpair a team Chrome');
  await btn(u, 'Unpair').click();
  await step('f-res-browsers-14-unpair-done', 'Unpaired; in the audit log');
}, H);

// ── You › Plugins ──
await r.session(S('as=maya&page=my-plugins&tab=composio'), async (page, step) => {
  await btn(page, 'Link a Composio toolkit').click();
  const d = dlg(page, 'personal-plugin');
  await choose(d, 'gcal');
  await step('f-res-my-plugins-01-pick', 'You › Plugins › Link a Composio toolkit: Google Drive and Notion are linked already');
  await btn(d, 'Continue').click();
  await btn(d, 'Open sign-in page').click();
  await choose(d, 'personal');
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await step('f-res-my-plugins-02-wrong-account', 'Signed in with a personal Google account: pick maya@crumbco.example');
  await btn(d, 'Open sign-in page again').click();
  await choose(d, 'work');
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await btn(d, 'Continue').click();
  await step('f-res-my-plugins-03-where', 'Step 3: where it joins workspaces (projects allowing holders’ own plugins) and the holder rules');
  await btn(d, 'Connect').click();
  await step('f-res-my-plugins-04-done', 'Success: Google Calendar connected');
}, H);

await r.session(S('as=maya&page=my-plugins'), async (page, step) => {
  await btn(page, 'Sign in to an MCP server').click();
  const d = dlg(page, 'personal-plugin');
  await choose(d, 'figma');
  await btn(d, 'Continue').click();
  await btn(d, 'Open sign-in page').click();
  await btn(d, 'Cancel').click();
  await step('f-res-my-plugins-05-cancelled', 'Sign in to an MCP server › Figma: cancelled on figma.com');
}, H);

await r.session(S('as=rina&page=my-plugins&tab=composio'), async (page, step) => {
  await page.getByRole('button', { name: 'Reconnect Google Calendar' }).click();
  const d = dlg(page, 'personal-plugin');
  await step('f-res-my-plugins-06-reconnect', 'As Rina: Reconnect Google Calendar (sign-in required) starts at Sign in');
  await btn(d, 'Open sign-in page').click();
  await btn(d, 'Allow').click();
  await wait(page, 1300);
  await btn(d, 'Continue').click();
  await btn(d, 'Reconnect').click();
  await step('f-res-my-plugins-07-reconnect-done', 'Reconnected');
}, H);

await r.session(S('as=maya&page=my-plugins'), async (page, step) => {
  await page.getByRole('button', { name: 'Disconnect Linear' }).click();
  const d = dlg(page, 'disconnect-plugin');
  await step('f-res-my-plugins-08-disconnect', 'Disconnect your own sign-in');
  await btn(d, 'Disconnect').click();
  await step('f-res-my-plugins-09-disconnect-done', 'Disconnected');
}, H);

// ── You › My secrets: my own (the old step-ups) ──
await r.session(S('as=maya&page=my-secrets'), async (page, step) => {
  await btn(page, 'Add').click();
  const d = dlg(page, 'add-own-secret');
  await choose(d, 'stripe');
  await step('f-res-step-ups-01-what', 'Add one of my own secrets, step 1: what it unlocks (production DB read, Stripe live, App Store Connect, AWS SSO)');
  await btn(d, 'Continue').click();
  await fill(d, 'Restricted key', ['sk', 'live', 'x'.repeat(5)].join('_'));
  await btn(d, 'Check with Stripe').click();
  await step('f-res-step-ups-02-stripe-full-key', 'Step 2: a full live secret key (sk_…) is refused; make a restricted key');
  await fill(d, 'Restricted key', 'rk_test_51Hx9');
  await btn(d, 'Check with Stripe').click();
  await step('f-res-step-ups-03-stripe-test-key', 'A test-mode key is refused: this secret is for live mode; test keys belong in project secrets');
  await fill(d, 'Restricted key', ['rk', 'live', 'x'.repeat(29)].join('_'));
  await btn(d, 'Check with Stripe').click();
  await wait(page, 1300);
  await step('f-res-step-ups-04-stripe-ok', 'Stripe accepted it: live mode, charges and refunds read');
  await btn(d, 'Continue').click();
  await fill(d, 'Name agents and approved scripts ask for it by', 'stripe-key');
  await btn(d, 'Continue').click();
  await step('f-res-step-ups-05-policy', 'Step 3, Rule: minutes in a cleared shell after each passkey (1–60), what it unlocks, its name (error: capitals, digits and _), and the fixed rules (only you, only while holding, closed on Let go)');
  await fill(d, 'Name agents and approved scripts ask for it by', 'STRIPE_LIVE_KEY');
  await btn(d, 'Continue').click();
  await step('f-res-step-ups-06-passkey', 'Step 4: review (Only you · only while holding · in a cleared shell for 30 min with a passkey) and confirm with the passkey');
  await btn(d, 'Save with passkey').click();
  await step('f-res-step-ups-07-passkey-waiting', 'Waiting for Maya’s passkey');
  await wait(page, 1600);
  await step('f-res-step-ups-08-done', 'Success; in the audit log');
}, H);

await r.session(S('as=maya&page=my-secrets'), async (page, step) => {
  await btn(page, 'Add').click();
  const d = dlg(page, 'add-own-secret');
  await choose(d, 'db');
  await btn(d, 'Continue').click();
  await fill(d, 'Connection string', 'postgres://crumb_app:Xq83nd02kd@replica.crumb-prod.internal:5432/crumb');
  await btn(d, 'Test connection').click();
  await wait(page, 1400);
  await step('f-res-step-ups-09-db-writable', 'Production database: the role can write, so it’s refused; use a read-only role');
  await fill(d, 'Connection string', 'postgres://crumb_readonly:short@replica.crumb-prod.internal:5432/crumb');
  await btn(d, 'Test connection').click();
  await wait(page, 1400);
  await step('f-res-step-ups-10-db-auth-failed', 'Password authentication failed');
  await fill(d, 'Connection string', 'postgres://crumb_readonly:Xq83nd02kd@replica.crumb-prod.internal:5432/crumb');
  await btn(d, 'Test connection').click();
  await wait(page, 1400);
  await step('f-res-step-ups-11-db-ok', 'Connected as crumb_readonly, SELECT only');
}, H);

await r.session(S('as=maya&page=my-secrets'), async (page, step) => {
  await btn(page, 'Add').click();
  const d = dlg(page, 'add-own-secret');
  await choose(d, 'appstore');
  await btn(d, 'Continue').click();
  await fill(d, 'Issuer ID', 'not-a-uuid');
  await btn(d, 'Check with Apple').click();
  await step('f-res-step-ups-12-appstore-issuer', 'App Store Connect: Issuer ID, Key ID and the .p8; a bad Issuer ID says where to find it');
  await page.keyboard.press('Escape');
  await wait(page, 400);
  await btn(page, 'Add').click();
  const e = dlg(page, 'add-own-secret');
  await choose(e, 'aws');
  await btn(e, 'Continue').click();
  await btn(e, 'Open sign-in page').click();
  await choose(e, 'admin');
  await btn(e, 'Allow').click();
  await wait(page, 1300);
  await step('f-res-step-ups-13-aws-admin', 'AWS SSO with a device code: AdministratorAccess is refused, pick ReadOnlyAccess');
}, H);

await r.session(S('as=maya&page=my-secrets'), async (page, step) => {
  await page.getByRole('button', { name: 'Step up GITHUB_ADMIN_TOKEN' }).click();
  const d = dlg(page, 'step-up-now');
  await step('f-res-step-ups-14-step-up', 'Step up GITHUB_ADMIN_TOKEN: a cleared shell for 15 min; pick a workspace you hold');
  await btn(d, 'Unlock with passkey').click();
  await step('f-res-step-ups-15-step-up-passkey', 'Passkey challenge');
  await wait(page, 1600);
  await step('f-res-step-ups-16-step-up-done', 'Open for 15 min, your turns only');
  await btn(d, 'Done').click();
  await page.getByRole('button', { name: 'Drop NPM_TOKEN in checkout-apple-pay' }).click();
  const x = dlg(page, 'drop-step-up');
  await step('f-res-step-ups-17-drop', 'Drop an open cleared shell early');
  await btn(x, 'Drop').click();
  await step('f-res-step-ups-18-drop-done', 'Dropped');
}, H);

// ── Skills ──
await r.session(S('as=maya&page=skills'), async (page, step) => {
  await btn(page, 'New skill').click();
  const d = dlg(page, 'new-skill');
  await choose(d, 'import');
  await fill(d, 'Repository path', 'github.com/vercel/skills/tree/main/next-cache');
  await btn(d, 'Import').click();
  await wait(page, 1300);
  await step('f-res-skills-01-import-not-installed', 'Team › Skills › New skill › Import: the GitHub app isn’t installed on that organisation');
  await fill(d, 'Repository path', 'github.com/crumb-co/skills/tree/main/menu-photos');
  await btn(d, 'Import').click();
  await wait(page, 1300);
  await step('f-res-skills-02-import-ok', 'Found menu-photos/SKILL.md');
  await btn(d, 'Continue').click();
  await fill(d, 'Name', 'Menu Photos');
  await btn(d, 'Continue').click();
  await step('f-res-skills-03-name-error', 'Step 2: names are lowercase words joined by -');
  await fill(d, 'Name', 'menu-photos');
  await fill(d, 'Description (when agents should use it)', 'Use when shooting or editing menu photos: sizes, light, file names');
  await btn(d, 'Continue').click();
  await step('f-res-skills-04-projects', 'Step 3: the projects it’s on in');
  await btn(d, 'Add skill').click();
  await step('f-res-skills-05-done', 'Success; in the audit log');
  await btn(d, 'Done').click();
  await page.getByRole('button', { name: 'Edit release-checklist' }).click();
  const e = dlg(page, 'edit-skill');
  await fill(e, 'Description (when agents should use it)', '');
  await btn(e, 'Save').click();
  await step('f-res-skills-06-edit-error', 'Edit a team skill: its description, SKILL.md and projects; the description is required');
  await fill(e, 'Description (when agents should use it)', 'The Friday release: freeze, changelog, tag, deploy order, rollback');
  await btn(e, 'Save').click();
  await step('f-res-skills-07-edit-done', 'Saved');
}, H);

await r.session(S('as=maya&page=my-skills'), async (page, step) => {
  await btn(page, 'New skill').click();
  const d = dlg(page, 'new-skill');
  await choose(d, 'paste');
  await d.locator('textarea').fill('name: maya-pr-titles\nTitles like: area: what changed');
  await btn(d, 'Continue').click();
  await btn(d, 'Continue').click();
  await step('f-res-skills-08-paste-error', 'You › Skills › New skill › Paste a SKILL.md: front matter and a description are required');
  await d.locator('textarea').fill('---\nname: maya-pr-titles\ndescription: Use when writing pull request titles\n---\n\nTitles read “area: what changed”.');
  await fill(d, 'Name', 'maya-pr-titles');
  await fill(d, 'Description (when agents should use it)', 'Use when writing pull request titles');
  await btn(d, 'Continue').click();
  await step('f-res-skills-09-where', 'Step 3: it travels with you into workspaces you hold');
  await btn(d, 'Add skill').click();
  await step('f-res-skills-10-done', 'Success');
}, H);

await r.flow(S('as=sam&page=skills'), 'f-res-skills-11-member-refused', 'As Sam (Member): New team skill is refused, with why', {
  act: async (page) => { await btn(page, 'New skill').hover(); await wait(page, 600); },
});

await r.finish();
