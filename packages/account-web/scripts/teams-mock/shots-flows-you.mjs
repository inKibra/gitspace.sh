// You pages' flows: Profile (edit, leave team), Git identity (commit author, Connect / Reconnect / Disconnect GitHub,
// Add or replace SSH key, signing), Voice, Defaults, Passkeys and devices (add, rename, remove), MCP clients (connect,
// edit slice, revoke), Secrets (set, replace, remove), and Machines at both scopes (pair a computer, Cell container,
// cloud VM, notes, remove, unpair, rotate the team SSH key), with every wizard step, error and success. Mostly as
// Maya (Owner); Jules and Rina (Members) where a refusal shows. Shots into $OUT as f-you-*.png with captions in
// f-you-captions.txt.
import { runner } from './shots-lib.mjs';

const r = await runner('f-you-captions.txt');
const settings = (query) => `view=settings&${query}`;
const PASSKEY_MS = 1700;
const flow = (page, id) => page.locator(`[data-flow="${id}"]`);
const press = (scope, name) => scope.getByRole('button', { name, exact: true }).first().click();
// An InputField's label holds its text twice (one copy sizes the label), so its accessible name is the text, repeated.
const fill = (scope, label, value) => scope.getByLabel(new RegExp(`^(?:${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}){1,2}$`)).fill(value);
// A refused action is aria-disabled: it still says why when pressed.
const refused = (page, name) => page.getByRole('button', { name, exact: true }).first().click({ force: true });
const choose = (scope, id) => scope.locator(`[data-choice="${id}"]`).click();
const outcome = (scope, id) => scope.locator(`[data-outcome="${id}"]`).click();
async function pick(page, trigger, option) {
  await page.getByRole('combobox', { name: trigger }).or(page.getByLabel(trigger, { exact: true })).first().click();
  await page.getByRole('option', { name: option }).first().click();
}

// ── Profile ──
await r.session(settings('page=profile&as=maya'), async (page, step) => {
  await press(page, 'Edit');
  const d = flow(page, 'profile-edit');
  await step('f-you-profile-01-edit', 'Edit profile: name, avatar (initials on a colour) with a live preview');
  await fill(d, 'Name', '');
  await press(d, 'Save');
  await step('f-you-profile-02-error', 'Edit profile, error: a name is required');
  await fill(d, 'Name', 'Maya O. Okafor');
  await d.getByRole('radio', { name: '#364fc7' }).click();
  await press(d, 'Save');
  await step('f-you-profile-03-saved', 'Edit profile, success: saved; the Profile row behind shows the new name and colour');
});
await r.flow(settings('page=profile&as=maya'), 'f-you-profile-04-leave-refused', 'Leave team as Maya, the only Owner: refused with the reason (make someone else Owner first)', { act: (page) => refused(page, 'Leave team') });
await r.session(settings('page=profile&as=jules'), async (page, step) => {
  await press(page, 'Leave team');
  const d = flow(page, 'leave-team');
  await step('f-you-profile-05-leave-what-goes', 'Leave Crumb & Co as Jules (Member), step 1: what goes (passkeys, MCP clients, machines, handles, bots, history)');
  await press(d, 'Continue');
  await fill(d, 'Type Crumb & Co to confirm', 'crumb and co');
  await press(d, 'Leave Crumb & Co');
  await step('f-you-profile-06-leave-mismatch', 'Leave, step 2 error: the team name must be typed exactly');
  await fill(d, 'Type Crumb & Co to confirm', 'Crumb & Co');
  await press(d, 'Leave Crumb & Co');
  await page.waitForTimeout(300);
  await step('f-you-profile-07-leave-passkey', 'Leave, step 2: confirming with Jules’s passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-you-profile-08-leave-done', 'Leave, success: Jules left; this browser is signed out');
});

// ── Git identity ──
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Edit');
  const d = flow(page, 'commit-author');
  await step('f-you-git-01-author', 'Commit author: name and email; the email is verified on @maya-okafor');
  await fill(d, 'Name', '');
  await fill(d, 'Email', 'maya@crumbco');
  await press(d, 'Save');
  await step('f-you-git-02-author-errors', 'Commit author, errors: name required; not an email address');
  await fill(d, 'Name', 'Maya Okafor');
  await fill(d, 'Email', 'maya@bakery.example');
  await step('f-you-git-03-author-unverified', 'Commit author: an email not verified on @maya-okafor is allowed, with what it means');
  await fill(d, 'Email', 'maya.okafor@mail.example');
  await press(d, 'Save');
  await step('f-you-git-04-author-saved', 'Commit author, success: from the next turn on');
});
await r.session(settings('page=git&as=jules'), async (page, step) => {
  await press(page, 'Connect GitHub');
  const d = flow(page, 'github-connect');
  await step('f-you-git-05-github-how', 'Connect GitHub as Jules, step 1: enter a code on GitHub, or open GitHub here; the scopes asked for');
  await press(d, 'Authorize on GitHub');
  await step('f-you-git-06-github-code', 'Connect GitHub, step 1: device code with its URL, expiry countdown, waiting for GitHub');
  await outcome(d, 'cancel');
  await step('f-you-git-07-github-cancelled', 'Connect GitHub, error: cancelled on GitHub; nothing connected; Start again');
  await press(d, 'Start again');
  await outcome(d, 'approve');
  await step('f-you-git-08-github-account', 'Connect GitHub, step 2: the account (@jmoreau) and the commit email; Jules’s author email is unverified there');
  await press(d, 'Connect');
  await step('f-you-git-09-github-unverified', 'Connect GitHub, error: jules@crumbco.example isn’t verified on @jmoreau; verify it on GitHub, then Check again');
  await press(d, 'Check again');
  await press(d, 'Connect');
  await page.waitForTimeout(1200);
  await step('f-you-git-10-github-connected', 'Connect GitHub, success: connected as @jmoreau, commit email, SSH key added for pushing and signing');
});
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Reconnect');
  const d = flow(page, 'github-connect');
  await choose(d, 'redirect');
  await press(d, 'Authorize on GitHub');
  await step('f-you-git-11-reconnect-redirect', 'Reconnect GitHub as Maya: GitHub opened in a new tab; waiting for approval');
  await outcome(d, 'approve');
  await choose(d, 'crumb-maya');
  await step('f-you-git-12-reconnect-accounts', 'Reconnect, step 2: two accounts on Maya’s GitHub sign-in; picking @crumb-maya switches its emails');
});
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Disconnect');
  const d = flow(page, 'github-disconnect');
  await step('f-you-git-13-disconnect', 'Disconnect @maya-okafor: what stops, what keeps working');
  await press(d, 'Disconnect');
  await step('f-you-git-14-disconnected', 'Disconnect, success: token revoked; the row behind says Not connected');
});
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Replace key');
  const d = flow(page, 'ssh-key');
  await step('f-you-git-15-ssh-source', 'Replace SSH key, step 1: generate on this machine, or paste a public key');
  await choose(d, 'pasted');
  await press(d, 'Continue');
  const pem = ['PRIVATE', 'KEY'].join(' ');
  await d.getByLabel('Public key (.pub)').fill(`-----BEGIN OPENSSH ${pem}-----\n${'x'.repeat(70)}\n-----END OPENSSH ${pem}-----`);
  await press(d, 'Continue');
  await step('f-you-git-16-ssh-private', 'Replace SSH key, error: “That’s a private key; paste the .pub”');
  await d.getByLabel('Public key (.pub)').fill('ssh-dss AAAAB3NzaC1kc3MAAACBAP maya@mbp');
  await press(d, 'Continue');
  await step('f-you-git-17-ssh-format', 'Replace SSH key, error: not a public key format GitSpace takes (ssh-ed25519, ssh-rsa, ecdsa-sha2-…)');
  await fill(d, 'Name', 'maya mbp');
  await d.getByLabel('Public key (.pub)').fill('ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIGq7Lx2mN0b9Rk3TzWcHf1sYeA6uJ9dGiO5nXc0LkQpZ maya@mbp');
  await press(d, 'Continue');
  await step('f-you-git-18-ssh-name', 'Replace SSH key, error: the name can’t have spaces');
  await fill(d, 'Name', 'maya-mbp');
  await press(d, 'Continue');
  await step('f-you-git-19-ssh-confirm', 'Replace SSH key, step 3: the new key, the old fingerprint retired, which of Maya’s machines get it, GitHub; passkey');
  await press(d, 'Confirm with passkey');
  await page.waitForTimeout(300);
  await step('f-you-git-20-ssh-passkey', 'Replace SSH key: confirming with Maya’s passkey');
  await page.waitForTimeout(PASSKEY_MS);
  await step('f-you-git-21-ssh-done', 'Replace SSH key, success: the new fingerprint, where it is now, its public key to copy');
});
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Replace key');
  const d = flow(page, 'ssh-key');
  await press(d, 'Continue');
  await step('f-you-git-22-ssh-generate', 'Replace SSH key, generate path, step 2: name it; the new ed25519 public key and fingerprint');
});
await r.session(settings('page=git&as=maya'), async (page, step) => {
  await press(page, 'Change');
  const d = flow(page, 'signing');
  await step('f-you-git-23-signing', 'Commit signing: sign with the SSH key, or don’t sign');
  await choose(d, 'off');
  await press(d, 'Save');
  await step('f-you-git-24-signing-saved', 'Commit signing, success: commits aren’t signed; the row behind says so');
});

// ── Voice and Defaults ──
await r.session(settings('page=voice&as=maya'), async (page, step) => {
  await page.getByRole('combobox', { name: 'Dictation language' }).or(page.getByLabel('Dictation language', { exact: true })).first().click();
  await step('f-you-voice-01-languages', 'Voice: dictation language, English (US) the default; six languages');
  await page.getByRole('option', { name: 'French' }).click();
  await step('f-you-voice-02-saved', 'Voice: French saved at once, said in a toast; Spoken replies and Push to talk work the same');
});
await r.session(settings('page=defaults&as=maya'), async (page, step) => {
  await pick(page, 'Model role', 'Thorough');
  await step('f-you-defaults-01-role', 'Defaults: model role Thorough saved, with what it means; workspace mode and notifications the same');
});

// ── Passkeys and devices ──
await r.session(settings('page=passkeys&as=maya'), async (page, step) => {
  await press(page, 'Add passkey');
  const d = flow(page, 'passkey-add');
  await step('f-you-passkeys-01-where', 'Add a passkey, step 1: this device (refused: it already has one), a security key, or a phone via QR');
  await press(d, 'Continue');
  await fill(d, 'Name', 'YubiKey 5C');
  await press(d, 'Continue');
  await step('f-you-passkeys-02-name-taken', 'Add a passkey, step 2 error: Maya already has a passkey with that name');
  await fill(d, 'Name', 'Spare YubiKey');
  await press(d, 'Continue');
  await step('f-you-passkeys-03-create', 'Add a passkey, step 3: first confirm it’s Maya with her current passkey');
  await press(d, 'Create passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-passkeys-04-touch-key', 'Add a passkey: insert the security key and touch it');
  await outcome(d, 'cancel');
  await step('f-you-passkeys-05-cancelled', 'Add a passkey, error: the prompt was cancelled or timed out; nothing added; Try again');
  await press(d, 'Try again');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await outcome(d, 'dup');
  await step('f-you-passkeys-06-duplicate', 'Add a passkey, error: this security key already holds Maya’s passkey (YubiKey 5C)');
  await press(d, 'Try again');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await outcome(d, 'ok');
  await step('f-you-passkeys-07-added', 'Add a passkey, success: Spare YubiKey added; in the audit log; listed behind');
});
await r.session(settings('page=passkeys&as=maya'), async (page, step) => {
  await press(page, 'Add passkey');
  const d = flow(page, 'passkey-add');
  await choose(d, 'phone');
  await press(d, 'Continue');
  await press(d, 'Continue');
  await press(d, 'Create passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-passkeys-08-phone-qr', 'Add a passkey from a phone: scan the QR code with its camera; waiting for the phone');
}, { height: 1100 });
await r.session(settings('page=passkeys&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Rename', exact: true }).nth(1).click();
  const d = flow(page, 'device-rename');
  await fill(d, 'Name', 'MacBook Pro');
  await press(d, 'Save');
  await step('f-you-passkeys-09-rename-error', 'Rename iPhone, error: another passkey has that name');
  await fill(d, 'Name', 'iPhone 16');
  await press(d, 'Save');
  await step('f-you-passkeys-10-renamed', 'Rename, success: iPhone 16; the passkey itself is unchanged');
});
await r.session(settings('page=passkeys&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Remove', exact: true }).nth(2).click();
  const d = flow(page, 'device-remove');
  await step('f-you-passkeys-11-remove', 'Remove YubiKey 5C: it can’t sign in any more; Maya’s other passkeys; passkey to confirm');
  await press(d, 'Remove passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-passkeys-12-removed', 'Remove, success: gone from the list behind; in the audit log');
});
await r.session(settings('page=passkeys&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Remove', exact: true }).nth(0).click();
  await step('f-you-passkeys-13-remove-current', 'Remove the passkey in use (MacBook Pro): it signs this browser out; Sign out and remove');
});
await r.session(settings('page=passkeys&as=jules'), async (page, step) => {
  await press(page, 'Remove');
  await step('f-you-passkeys-14-last-refused', 'Remove as Jules, refused: it’s his only passkey; Add a passkey first');
});

// ── MCP clients ──
await r.session(settings('page=mcp&as=maya'), async (page, step) => {
  await press(page, 'Connect a client');
  const d = flow(page, 'mcp-connect');
  await step('f-you-mcp-01-client', 'Connect an MCP client, step 1: Claude Code, Cursor, Codex or another client');
  await choose(d, 'other');
  await fill(d, 'Redirect URL', 'ftp://zed.example/callback');
  await press(d, 'Continue');
  await step('f-you-mcp-02-other-errors', 'Another client, errors: name required; the redirect URL must be https:// or http://localhost');
  await choose(d, 'claude-code');
  await press(d, 'Continue');
  await step('f-you-mcp-03-slice', 'Step 2, the slice: projects Maya is in (Lead in each), capabilities within her roles, expiry');
  await d.getByRole('button', { name: 'Crumb · Lead' }).click();
  await d.getByRole('button', { name: 'read', exact: true }).click();
  await d.getByRole('button', { name: 'comment', exact: true }).click();
  await d.getByRole('button', { name: 'prompt', exact: true }).click();
  await press(d, 'Continue');
  await step('f-you-mcp-04-slice-errors', 'Slice, errors: at least one project and one capability');
  await d.getByRole('button', { name: 'Crumb · Lead' }).click();
  await d.getByRole('button', { name: 'Ledger · Lead' }).click();
  await d.getByRole('button', { name: 'read', exact: true }).click();
  await d.getByRole('button', { name: 'prompt', exact: true }).click();
  await d.getByRole('button', { name: 'take the handle', exact: true }).click();
  await pick(page, 'Expires', 'In 7 days');
  await press(d, 'Continue');
  await step('f-you-mcp-05-code', 'Step 3: the command to run in Claude Code and the code to enter, expiry countdown, waiting for the client');
  await outcome(d, 'expired');
  await step('f-you-mcp-06-expired', 'Step 3, error: the code expired before Claude Code used it; New code');
  await press(d, 'New code');
  await outcome(d, 'used');
  await step('f-you-mcp-07-used', 'Step 3: Claude Code used the code from claude.ai');
  await press(d, 'Continue');
  await step('f-you-mcp-08-approve', 'Step 4: approve “Maya via Claude Code” with its slice; passkey');
  await press(d, 'Approve with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-mcp-09-connected', 'Connect, success: Maya via Claude Code · Crumb (Lead), Ledger (Lead) · read, prompt, take the handle · 7 days; listed behind');
}, { height: 1000 });
await r.session(settings('page=mcp&as=jules'), async (page, step) => {
  await press(page, 'Connect a client');
  const d = flow(page, 'mcp-connect');
  await choose(d, 'cursor');
  await press(d, 'Continue');
  await step('f-you-mcp-10-member-slice', 'Jules (Contributor in Crumb): take the handle and approve environment are struck out, each with the role that refuses it');
});
await r.session(settings('page=mcp&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Edit slice', exact: true }).nth(1).click();
  const d = flow(page, 'mcp-edit');
  await step('f-you-mcp-11-edit', 'Edit slice of Claude Code: its projects, capabilities and expiry');
  await d.getByRole('button', { name: 'Ledger · Lead' }).click();
  await step('f-you-mcp-12-edit-widen', 'Edit slice: adding Ledger widens it, so it asks for Maya’s passkey');
  await press(d, 'Save with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-mcp-13-edit-saved', 'Edit slice, success: from the client’s next call; the slice behind shows Ledger on');
});
await r.session(settings('page=mcp&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Revoke', exact: true }).nth(0).click();
  const d = flow(page, 'mcp-revoke');
  await step('f-you-mcp-14-revoke', 'Revoke Claude Desktop: it stops at once; prompts already sent stay');
  await press(d, 'Revoke');
  await step('f-you-mcp-15-revoked', 'Revoke, success: gone from the list behind');
});

// ── Secrets ──
await r.session(settings('page=my-secrets&as=maya'), async (page, step) => {
  await press(page, 'Add a value');
  const d = flow(page, 'personal-value');
  await step('f-you-secrets-01-request', 'Add a value, step 1: the requests projects make of Maya (FIGMA_TOKEN missing, STAGING_LOGIN set)');
  await press(d, 'Continue');
  await fill(d, 'Figma token', ['ghp', '1234567890abcdefghijklmnop'].join('_'));
  await press(d, 'Check with Figma');
  await step('f-you-secrets-02-prefix', 'Step 2, error: Figma tokens start with figd_; masked input; where to make one');
  await fill(d, 'Figma token', 'figd_old_Q2xS8vN0r4LkTz7WcHf1sYeA6uJ9dGi');
  await press(d, 'Check with Figma');
  await page.waitForTimeout(1200);
  await step('f-you-secrets-03-revoked', 'Step 2, error: Figma says the token was revoked or expired (401); make a new one');
  await fill(d, 'Figma token', ['figd', 'x'.repeat(40)].join('_'));
  await press(d, 'Check with Figma');
  await page.waitForTimeout(1200);
  await step('f-you-secrets-04-reach', 'Step 3: where it reaches (Crumb workspaces Maya holds), as what, and never');
  await press(d, 'Save value');
  await step('f-you-secrets-05-saved', 'Add a value, success: FIGMA_TOKEN set for Crumb; the row behind says Set');
});
await r.session(settings('page=my-secrets&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Replace', exact: true }).first().click();
  const d = flow(page, 'personal-value');
  await fill(d, 'Password', 'short');
  await press(d, 'Check with staging.crumb.example');
  await step('f-you-secrets-06-login-errors', 'Replace STAGING_LOGIN (from its row, step 2): username required; password too short');
  await fill(d, 'Username', 'maya');
  await fill(d, 'Password', 'wrong-password-1');
  await press(d, 'Check with staging.crumb.example');
  await page.waitForTimeout(1200);
  await step('f-you-secrets-07-login-refused', 'Replace, error: staging.crumb.example refused the login; check it there first');
  await fill(d, 'Password', 'correct-horse-battery');
  await press(d, 'Check with staging.crumb.example');
  await page.waitForTimeout(1200);
  await press(d, 'Save value');
  await step('f-you-secrets-08-replaced', 'Replace, success: STAGING_LOGIN saved for Crumb');
});
await r.session(settings('page=my-secrets&as=maya'), async (page, step) => {
  await press(page, 'Remove');
  const d = flow(page, 'personal-value-remove');
  await step('f-you-secrets-09-remove', 'Remove STAGING_LOGIN: which workspaces it leaves; setup steps that need it fail there');
  await press(d, 'Remove value');
  await step('f-you-secrets-10-removed', 'Remove, success: the row behind says Missing');
});

// ── Machines: pair a computer ──
await r.session(settings('page=my-machines&as=maya'), async (page, step) => {
  await press(page, 'Physical computer');
  const d = flow(page, 'add-computer');
  await step('f-you-machines-01-whose', 'Add a computer, step 1: mine or the team’s');
  await press(d, 'Continue');
  await step('f-you-machines-02-install-mac', 'Step 2, macOS: installer or the command, the pairing code, expiry countdown');
  await choose(d, 'windows');
  await step('f-you-machines-03-install-windows', 'Step 2, Windows: .msi or PowerShell');
  await press(d, 'I ran it');
  await step('f-you-machines-04-waiting', 'Step 3: waiting for the machine to connect');
  await outcome(d, 'expired');
  await step('f-you-machines-05-expired', 'Step 3, error: the pairing code expired; New code');
  await press(d, 'New code');
  await press(d, 'I ran it');
  await outcome(d, 'elsewhere');
  await step('f-you-machines-06-elsewhere', 'Step 3, error: already paired with another team; unpair it there first');
  await press(d, 'New code');
  await press(d, 'I ran it');
  await outcome(d, 'computer');
  await fill(d, 'Name', 'Maya’s MacBook Pro');
  await press(d, 'Add machine');
  await step('f-you-machines-07-name-taken', 'Step 4: it appeared (physical computer, macOS, M3 Pro); error: that name is taken');
  await fill(d, 'Name', 'Maya’s Mac Studio');
  await press(d, 'Add machine');
  await step('f-you-machines-08-paired', 'Add a computer, success: Maya’s Mac Studio paired; listed behind');
});
await r.session(settings('page=machines&as=maya'), async (page, step) => {
  await press(page, 'Physical computer');
  const d = flow(page, 'add-computer');
  await press(d, 'Continue');
  await choose(d, 'linux');
  await press(d, 'I ran it');
  await outcome(d, 'vm');
  await press(d, 'Add with passkey');
  await step('f-you-machines-09-team-projects', 'Team computer, step 4: a cloud VM detected; error: pick the projects that may use it; passkey');
  await d.getByRole('button', { name: 'Crumb', exact: true }).click();
  await press(d, 'Add with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-machines-10-team-paired', 'Team computer, success: crumb-build-1 for Crumb; in the audit log');
});
await r.session(settings('page=my-machines&as=jules'), async (page, step) => {
  await press(page, 'Physical computer');
  await step('f-you-machines-11-member-whose', 'Add a computer as Jules (Member): the team’s option is refused with the reason');
});
await r.session('view=machines&page=add&as=maya', async (page, step) => {
  await step('f-you-machines-12-live-add', 'Machines page › Add a computer opens the same wizard');
});

// ── Machines: Cell container and cloud VM ──
await r.session(settings('page=my-machines&as=maya'), async (page, step) => {
  await press(page, 'Cell container');
  const d = flow(page, 'cell-container');
  await step('f-you-machines-13-cell-size', 'New Cell container, step 1: name, size with cost, sleep when idle');
  await fill(d, 'Name', 'Maya Cell');
  await press(d, 'Continue');
  await step('f-you-machines-14-cell-name', 'Step 1, error: lower-case letters, digits and dashes');
  await fill(d, 'Name', 'maya-gpu');
  await press(d, 'Continue');
  await step('f-you-machines-15-cell-taken', 'Step 1, error: a machine already has that name');
  await fill(d, 'Name', 'maya-cell');
  await press(d, 'Continue');
  await step('f-you-machines-16-cell-image', 'Step 2: image (gitspace/web or gitspace/data, each with its machine profile built in, or Ubuntu) and services baked in');
  await press(d, 'Continue');
  await step('f-you-machines-17-cell-review', 'Step 3: review');
  await press(d, 'Create container');
  await page.waitForTimeout(1500);
  await step('f-you-machines-18-cell-done', 'New Cell container, success: maya-cell ready; listed behind');
});
await r.session(settings('page=machines&as=theo'), async (page, step) => {
  await press(page, 'Cloud VM');
  const d = flow(page, 'cloud-vm');
  await step('f-you-machines-19-vm-provider', 'Connect a cloud VM as Theo (Admin), step 1: AWS EC2, Google Compute Engine, Azure');
  await press(d, 'Continue');
  await fill(d, 'Role ARN', 'arn:aws:iam::4319:role');
  await press(d, 'Check access');
  await step('f-you-machines-20-vm-arn', 'Step 2, error: not a role ARN; the external ID and what the role needs');
  await fill(d, 'Role ARN', 'arn:aws:iam::210987654321:role/GitSpaceReadonly');
  await press(d, 'Check access');
  await page.waitForTimeout(1300);
  await step('f-you-machines-21-vm-denied', 'Step 2, error: the role can’t launch instances (ec2:RunInstances denied); attach the policy');
  await fill(d, 'Role ARN', 'arn:aws:iam::210987654321:role/GitSpaceMachines');
  await press(d, 'Check access');
  await page.waitForTimeout(1300);
  await fill(d, 'Machines in the fleet', '40');
  await press(d, 'Continue');
  await step('f-you-machines-22-vm-fleet', 'Step 3, error: a fleet has 1 to 10 machines; region and instance type');
  await fill(d, 'Machines in the fleet', '3');
  await press(d, 'Continue');
  await d.getByRole('button', { name: 'Ledger', exact: true }).click();
  await step('f-you-machines-23-vm-projects', 'Step 4: projects Theo is in (Crumb, Ledger) and a passkey');
  await press(d, 'Connect with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-machines-24-vm-done', 'Connect a cloud VM, success: crumb-loadtest fleet, 3 × c7g.xlarge, for Ledger; in the audit log');
});
await r.flow(settings('page=machines&as=rina'), 'f-you-machines-25-member-refused', 'Team machines as Rina (Member): read only; Cell container refused with the reason', { act: (page) => refused(page, 'Cell container') });

// ── Machines: unpair, notes, remove, attach, team key ──
await r.session(settings('page=my-machines&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Unpair maya-gpu' }).click();
  const d = flow(page, 'machine-unpair');
  await step('f-you-machines-26-unpair', 'Unpair maya-gpu: no workspace uses it again; keys wiped; running processes stay, detached');
  await press(d, 'Unpair');
  await step('f-you-machines-27-unpaired', 'Unpair, success');
});
await r.session(settings('page=machines&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Notes', exact: true }).nth(3).click();
  const d = flow(page, 'machine-notes');
  await d.getByLabel('Notes').fill('At the shop · receipt printer and kitchen display attached. '.repeat(4));
  await step('f-you-machines-28-notes-error', 'Notes on Back-office Mac mini, error: at most 200 characters');
  await d.getByLabel('Notes').fill('At the shop · receipt printer, kitchen display and the card reader test terminal attached');
  await press(d, 'Save');
  await step('f-you-machines-29-notes-saved', 'Notes, success; in the audit log');
});
await r.session(settings('page=machines&as=maya'), async (page, step) => {
  await page.getByRole('button', { name: 'Remove', exact: true }).nth(2).click();
  const d = flow(page, 'machine-remove');
  await step('f-you-machines-30-remove', 'Remove crumb-ec2 fleet: checkout-apple-pay runs on it and moves to the default Cell container; passkey');
  await press(d, 'Remove with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-machines-31-removed', 'Remove, success; in the audit log');
});
await r.flow(settings('page=machines&as=maya'), 'f-you-machines-32-attach-off', 'Agents may attach, off for crumb-cell-1: saved, said in a toast, marked on the row', {
  act: (page) => page.getByRole('switch', { name: 'Agents may attach' }).first().click(),
});
await r.session(settings('page=machines&as=maya'), async (page, step) => {
  await press(page, 'Rotate');
  const d = flow(page, 'team-key-rotate');
  await fill(d, 'Name', 'crumb-team');
  await press(d, 'Make key with passkey');
  await step('f-you-machines-33-rotate-name', 'Rotate the team SSH key, step 1 error: that’s the current key’s name');
  await fill(d, 'Name', 'crumb-team-2');
  await press(d, 'Make key with passkey');
  await page.waitForTimeout(PASSKEY_MS + 200);
  await step('f-you-machines-34-rotate-register', 'Step 2: the new public key; mark each place the old key is registered once the new one is added');
  await d.getByRole('switch').first().click();
  await press(d, 'Continue');
  await step('f-you-machines-35-rotate-retire-refused', 'Step 3: retiring the old key is refused until the new key is at every place; keep both for now');
  await press(d, 'Back');
  await d.getByRole('switch').nth(1).click();
  await press(d, 'Continue');
  await choose(d, 'retire');
  await press(d, 'Retire old key');
  await step('f-you-machines-36-rotate-done', 'Rotate, success: crumb-team-2 is the team key; the old one is wiped from team machines');
});

await r.finish();
