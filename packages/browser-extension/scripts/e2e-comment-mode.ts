// End-to-end check of the in-page comment tool in a real Chrome, with the extension built from this checkout and a
// profile already paired with an account (Plugins → Browsers) and approved in a project that has an active workspace.
// Chrome names an unpacked extension by its folder, so the build is written to the folder that profile paired
// (`--extension`), replacing what is there.
// It drives the page as you do (real keys and clicks, elements found by their visible labels) through three ways a
// tab gets into trouble in a Chrome you use: a plain session; the extension's service worker restarted under a tab in
// comment mode, as Chrome stops an idle MV3 worker; and a toolbar an earlier session left on the page, as after an
// extension update. Each scenario checks that Esc leaves comment mode, that Done leaves it, and that a comment posts.
//
//   bun scripts/e2e-comment-mode.ts --chrome <chrome binary> --profile <paired profile dir> --extension <its unpacked extension dir> --account https://<you>.gitspace.sh [--workspace <name part>]
//
// Chrome must not already run on that profile. Posting writes real comments to the workspace's page comments on
// https://httpbin.org/, each saying it came from this check. Exits 0 when every check passes.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import puppeteer, { type CDPSession, type Page, type Protocol } from 'puppeteer-core';
import { z } from 'zod';
import { extensionFiles } from '../src/index.ts';

const { values } = parseArgs({ options: { chrome: { type: 'string' }, profile: { type: 'string' }, extension: { type: 'string' }, account: { type: 'string' }, workspace: { type: 'string', default: '' }, port: { type: 'string', default: '9339' } } });
if (!values.chrome || !values.profile || !values.extension || !values.account) throw new Error('Pass --chrome, --profile, --extension and --account');
const PAGE = 'https://httpbin.org/';
const Choices = z.object({ workspaces: z.array(z.object({ projectId: z.string(), workspaceId: z.string(), name: z.string(), approved: z.boolean() })).optional(), error: z.string().optional() });

// The extension as this checkout builds it, in the folder the profile paired. Chrome keeps a copy of an unpacked
// extension's service worker in the profile and may run that instead of the new files: the copy goes first.
const folder = values.extension;
// Chrome's id of an unpacked extension: the first 32 hex digits of SHA-256 of its folder's path, as letters a to p.
const extensionId = [...new Bun.CryptoHasher('sha256').update(folder).digest('hex').slice(0, 32)].map(digit => String.fromCharCode(97 + Number.parseInt(digit, 16))).join('');
await rm(join(values.profile, 'Default', 'Service Worker'), { recursive: true, force: true });
for (const [name, content] of Object.entries(extensionFiles(values.account))) { await mkdir(dirname(join(folder, name)), { recursive: true }); await writeFile(join(folder, name), content); }
const chrome = Bun.spawn([values.chrome, '--headless=new', `--user-data-dir=${values.profile}`, '--disable-features=DisableLoadExtensionCommandLineSwitch', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${folder}`, `--load-extension=${folder}`, `--remote-debugging-port=${values.port}`, '--window-size=1280,860', '--no-first-run', 'about:blank'], { stdout: 'ignore', stderr: 'ignore' });
let connecting = await puppeteer.connect({ browserURL: `http://127.0.0.1:${values.port}`, defaultViewport: null, protocolTimeout: 60_000 }).catch(() => undefined);
for (let attempt = 0; attempt < 50 && !connecting; attempt++) { await Bun.sleep(200); connecting = await puppeteer.connect({ browserURL: `http://127.0.0.1:${values.port}`, defaultViewport: null, protocolTimeout: 60_000 }).catch(() => undefined); }
if (!connecting) throw new Error('Chrome did not start');
const browser = connecting;
const browserSession = await browser.target().createCDPSession();

/** The extension's service worker target, which Chrome starts again after it stops. */
async function worker() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const { targetInfos } = await browserSession.send('Target.getTargets');
    const found = targetInfos.find(info => info.type === 'service_worker' && info.url === `chrome-extension://${extensionId}/background.js`);
    if (found) return found;
    await Bun.sleep(200);
  }
  throw new Error('The extension has no service worker');
}
/** Runs `run` in the extension's popup page, as the popup does: its messages and Chrome APIs. */
async function inPopup<T>(run: (page: Page) => Promise<T>): Promise<T> {
  const popup = await browser.newPage();
  try { await worker(); await popup.goto(`chrome-extension://${extensionId}/popup.html`); return await run(popup); }
  finally { await popup.close(); }
}

type DomNode = Protocol.DOM.Node;
/** The page's elements, closed shadow roots included, as the inspector sees them. */
async function find(cdp: CDPSession, test: (node: DomNode) => boolean): Promise<DomNode[]> {
  const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  const found: DomNode[] = [];
  const walk = (node: DomNode) => { if (test(node)) found.push(node); for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child); };
  walk(root);
  return found;
}
/** A button with this label that is drawn (it has a box: nothing holding it is display:none). */
async function visibleButton(cdp: CDPSession, label: string) {
  const buttons = await find(cdp, node => node.nodeName === 'BUTTON' && (node.children ?? []).some(child => child.nodeType === 3 && child.nodeValue === label));
  for (const node of buttons) if (await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null)) return node;
  return undefined;
}
/** The text GitSpace draws on the page (under `data-gitspace-overlay` hosts, closed shadow roots included). */
async function overlayText(cdp: CDPSession) {
  const texts: string[] = [];
  const walk = (node: DomNode) => { if (node.nodeType === 3 && node.nodeValue.trim()) texts.push(node.nodeValue.trim()); for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) walk(child); };
  for (const host of await find(cdp, node => (node.attributes ?? []).includes('data-gitspace-overlay'))) walk(host);
  return texts.join(' | ');
}
/** Whether a text field is drawn on the page (it has a box). */
async function visibleField(cdp: CDPSession) {
  for (const node of await find(cdp, node => node.nodeName === 'TEXTAREA')) if (await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null)) return true;
  return false;
}
/** A real click at the middle of an element. */
async function click(page: Page, cdp: CDPSession, node: DomNode) {
  const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId });
  const [x1 = 0, y1 = 0, x2 = 0, , , y3 = 0] = model.content;
  await page.mouse.click((x1 + x2) / 2, (y1 + y3) / 2);
}
/** Whether `check` holds within `ms`. */
async function until(check: () => Promise<boolean>, ms = 4000) {
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(150)) if (await check()) return true;
  return check();
}
/** The middle of each numbered pin drawn now. */
async function pinCentres(cdp: CDPSession) {
  const centres: { x: number; y: number }[] = [];
  for (const node of await find(cdp, node => node.nodeName === 'BUTTON' && /^\d+$/.test((node.children ?? []).map(child => child.nodeValue).join('')))) {
    const box = await cdp.send('DOM.getBoxModel', { backendNodeId: node.backendNodeId }).catch(() => null);
    const [x1 = 0, y1 = 0, x2 = 0, , , y3 = 0] = box?.model.content ?? [];
    if (box) centres.push({ x: (x1 + x2) / 2, y: (y1 + y3) / 2 });
  }
  return centres;
}
/** Comment mode shows its strip, whose button says Done (Esc). */
const commentMode = async (cdp: CDPSession) => Boolean(await visibleButton(cdp, 'Done (Esc)'));

// A tab of a workspace group on httpbin.org, in front.
const page = await browser.newPage();
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
const connection = await inPopup(async popup => {
  for (let attempt = 0; attempt < 60; attempt++) {
    const state = z.object({ connection: z.string() }).loose().parse(await popup.evaluate(() => chrome.runtime.sendMessage({ popupState: true })));
    if (state.connection === 'connected') return state.connection;
    await Bun.sleep(1000);
  }
  return 'not connected';
});
if (connection !== 'connected') throw new Error('The extension did not connect to the account within a minute');
const choices = Choices.parse(await inPopup(popup => popup.evaluate(() => chrome.runtime.sendMessage({ workspaceChoices: true }))));
const workspace = choices.workspaces?.find(item => item.approved && item.name.toLowerCase().includes(values.workspace.toLowerCase()));
if (!workspace) throw new Error(`No approved workspace matching "${values.workspace}": ${choices.error ?? JSON.stringify(choices.workspaces?.map(item => item.name))}`);
await inPopup(async popup => {
  const tabId = z.number().parse(await popup.evaluate(url => chrome.tabs.query({ url: `${url}*` }).then(tabs => tabs[0]?.id), PAGE));
  await popup.evaluate(message => chrome.runtime.sendMessage(message), { addTab: { tabId, projectId: workspace.projectId, workspaceId: workspace.workspaceId } });
});

const results: { scenario: string; check: string; ok: boolean }[] = [];
const record = (scenario: string, check: string, ok: boolean) => { results.push({ scenario, check, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario}: ${check}`); };

/** Comment mode on, from the toolbar's Comment button, as you turn it on. */
async function turnOn(cdp: CDPSession) {
  if (!await until(async () => Boolean(await visibleButton(cdp, 'Comment')), 8000)) return false;
  const button = await visibleButton(cdp, 'Comment');
  if (!button) return false;
  await click(page, cdp, button);
  return until(() => commentMode(cdp));
}
/** The extension's service worker stops, as Chrome stops an idle one; the next event starts a new one. */
async function restartWorker() {
  await browserSession.send('Target.closeTarget', { targetId: (await worker()).targetId });
  await Bun.sleep(1000);
}
/** The toolbar of extension 5.12.5, which drew it in a CDP isolated world of its own through the debugger: the
 * toolbar an earlier version leaves on a page when the extension updates. */
const EARLIER_OVERLAY = await (async () => {
  const source = Bun.spawnSync(['git', 'show', '83e133d1:packages/browser-extension/src/overlay.ts'], { cwd: import.meta.dir });
  if (!source.success) throw new Error('git show of the 5.12.5 overlay failed');
  const file = join(await mkdtemp(join(tmpdir(), 'gitspace-overlay-')), 'overlay.ts');
  await writeFile(file, source.stdout);
  return z.object({ browserOverlayFunction: z.string() }).parse(await import(file)).browserOverlayFunction;
})();
/** A toolbar in comment mode that an earlier version drew in a world of its own, its session gone. */
async function staleToolbar() {
  const session = await page.createCDPSession();
  const { frameTree } = await session.send('Page.getFrameTree');
  const world = await session.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'earlier-session' });
  const show = { mode: 'idle', workspace: workspace?.name ?? '', agent: null, doing: null, binding: '__earlierSession', capture: 'ready', recording: null, comments: true };
  const view = { bar: true, name: 'You', workspace: workspace?.name ?? '', threads: [], hover: null, draft: null, busy: null, done: null, focus: null, error: null };
  for (const command of [{ show }, { comment: view }]) await session.send('Runtime.callFunctionOn', { functionDeclaration: `function(json) { return (${EARLIER_OVERLAY}).call(this, JSON.parse(json)); }`, arguments: [{ value: JSON.stringify(command) }], executionContextId: world.executionContextId, returnByValue: true });
  await session.detach();
}

const scenarios: { name: string; fresh(): Promise<void>; underway(): Promise<void> }[] = [
  { name: 'plain session', fresh: async () => {}, underway: async () => {} },
  { name: 'service worker restarted', fresh: async () => {}, underway: restartWorker },
  { name: 'toolbar left by an earlier session', fresh: staleToolbar, underway: async () => {} },
];
for (const scenario of scenarios) {
  const cdp = await page.createCDPSession();
  /** A freshly loaded page in front, with what the scenario leaves on it, comment mode on, then what it does after. */
  const commenting = async () => {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.bringToFront();
    await scenario.fresh();
    const on = await turnOn(cdp);
    await scenario.underway();
    return on;
  };
  try {
    if (!await commenting()) { record(scenario.name, 'Comment turns comment mode on', false); continue; }
    await page.keyboard.press('Escape');
    record(scenario.name, 'Esc leaves comment mode', await until(async () => !await commentMode(cdp)));

    await commenting();
    const done = await visibleButton(cdp, 'Done (Esc)');
    if (done) await click(page, cdp, done);
    record(scenario.name, 'Done leaves comment mode', await until(async () => !await commentMode(cdp)));

    await commenting();
    // The page's threads as the comment tool counts them ("· 16 comments"): it shows at once and changes when the
    // extension's list of them comes.
    const threads = async () => Number(/· (\d+) comments?/.exec(await overlayText(cdp))?.[1] ?? -1);
    // A spot away from every pin an earlier check left (a click on one opens that thread instead of a new comment).
    const taken = await pinCentres(cdp);
    let spot = { x: 0, y: 0 };
    for (let attempt = 0; attempt < 200; attempt++) {
      spot = { x: 120 + Math.floor(Math.random() * 900), y: 330 + Math.floor(Math.random() * 300) };
      if (taken.every(pin => Math.hypot(pin.x - spot.x, pin.y - spot.y) > 48)) break;
    }
    await page.mouse.click(spot.x, spot.y);
    let posted = false;
    // The draft's field, clicked once it is drawn (each redraw of the popover draws it anew).
    const fieldClicked = async () => {
      for (const field of await find(cdp, node => node.nodeName === 'TEXTAREA')) if (await click(page, cdp, field).then(() => true, () => false)) return true;
      return false;
    };
    if (await until(fieldClicked)) {
      await page.keyboard.type(`End-to-end check (${scenario.name}) ${new Date().toISOString()}`);
      // The draft is ready once the extension read what was clicked: its line names it instead of "On …".
      await until(async () => (await find(cdp, node => node.nodeType === 3 && node.nodeValue.startsWith('On ') && !node.nodeValue.startsWith('On …'))).length > 0, 8000);
      // The threads before posting, once their list came (a service worker that started again lists them anew).
      let before = await threads();
      for (let steady = Date.now(); Date.now() - steady < 1500; await Bun.sleep(150)) { const now = await threads(); if (now !== before) { before = now; steady = Date.now(); } }
      const post = await visibleButton(cdp, 'Comment');
      if (post) await click(page, cdp, post);
      // Posted: the draft closed and the page has one more thread.
      posted = await until(async () => !await visibleField(cdp) && await threads() === before + 1, 10_000);
    }
    record(scenario.name, 'a comment posts', posted);
    // What GitSpace's toolbar showed instead, the draft and any failure it said among it.
    if (!posted) console.log(`      ${JSON.stringify(await overlayText(cdp))}`);
    await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  } finally { await cdp.detach().catch(() => {}); }
}

await browser.close().catch(() => {});
chrome.kill();
const failed = results.filter(result => !result.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
