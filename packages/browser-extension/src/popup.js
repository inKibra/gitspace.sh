// The extension's popup: whether GitSpace is on in this Chrome and connected, with the switch and "Off for 1 hour";
// the workspace groups using this Chrome, each stoppable and shown on request; the workspace group of this tab, which
// the tab can leave; and, folded away, this Chrome's identity fingerprint, pairing, reset and the latest scripts.
const $ = id => document.getElementById(id);
const CONNECTION = { connected: 'Connected', connecting: 'Connecting…', off: 'Off', update: 'Update required', unpaired: 'Not paired' };
let state;
/** Sends one request to the service worker; most answer with the popup's next state. */
async function request(message) { const result = await chrome.runtime.sendMessage(message); if (result?.error) throw new Error(result.error); return result; }
/** Text only: group names come from workspaces. */
function element(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function button(label, className, onClick) { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', onClick); return node; }
function render(next) {
  state = next;
  $('account').textContent = next.account;
  $('enabled').setAttribute('aria-checked', String(next.enabled));
  document.body.dataset.connection = next.connection;
  const until = next.reenableAt ? ` until ${new Date(next.reenableAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}` : '';
  $('connection-text').textContent = CONNECTION[next.connection] + (next.connection === 'off' ? until : '');
  $('compatibility').textContent = next.compatibility || '';
  $('compatibility').hidden = !next.compatibility;
  $('snooze').hidden = !next.enabled;
  $('groups').replaceChildren(...next.groups.map(group => {
    const item = element('li', 'group');
    const dot = element('span', 'dot'); dot.style.background = group.color;
    const text = element('div', 'grow');
    text.append(element('div', 'name', group.name), element('div', 'muted', group.running ? `running ${group.running} ${group.running === 1 ? 'script' : 'scripts'}` : `idle · ${group.tabs} ${group.tabs === 1 ? 'tab' : 'tabs'}`));
    const stop = button('Stop', 'danger', () => act({ stopGroup: group.groupId }, 'Stopped.'));
    stop.disabled = !group.running;
    item.append(dot, text, stop, button('Show', '', () => act({ focusGroup: group.groupId }, '')));
    return item;
  }));
  $('no-groups').hidden = next.groups.length > 0;
  $('this-tab').hidden = !next.activeTab;
  if (next.activeTab) { $('tab-dot').style.background = next.activeTab.color; $('tab-group').textContent = next.activeTab.name; }
  // Pairing is the first thing an unpaired Chrome needs.
  if (next.connection === 'unpaired') $('identity').open = true;
  $('fingerprint').textContent = next.fingerprint || 'No identity. Pair to generate a key.';
  $('runs').replaceChildren(...next.log.map(entry => element('li', '', `${new Date(entry.startedAt).toLocaleString()} · ${entry.workspace.groupName} · ${entry.scriptSha256.slice(0, 12)} · ${entry.commands} commands · ${entry.endReason}`)));
  $('no-runs').hidden = next.log.length > 0;
}
/** One popup action; while it runs, the popup's buttons wait. */
async function act(message, success) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach(node => { node.disabled = true; });
  try { render(await request(typeof message === 'function' ? message() : message)); $('message').textContent = success; }
  catch (error) { $('message').textContent = error.message; }
  finally { buttons.forEach(node => { node.disabled = false; }); if (state) render(state); }
}
/** Pairing and reset answer `ok`; the popup then reads its state again. */
async function identity(message, success) {
  try { await request(message()); $('code').value = ''; render(await request({ popupState: true })); $('message').textContent = success; }
  catch (error) { $('message').textContent = error.message; }
}
async function refresh() { try { render(await request({ popupState: true })); } catch (error) { $('message').textContent = error.message; } }
$('enabled').addEventListener('click', () => { void act({ setEnabled: { enabled: !state?.enabled } }, ''); });
$('snooze').addEventListener('click', () => { void act({ setEnabled: { enabled: false, minutes: 60 } }, 'Off for 1 hour.'); });
$('ungroup').addEventListener('click', () => { if (state?.activeTab) void act({ ungroupTab: state.activeTab.tabId }, 'This tab left the workspace group.'); });
$('pair').addEventListener('submit', event => { event.preventDefault(); void identity(() => { const pairing = JSON.parse($('code').value); if (!pairing.code || !pairing.pairingId || !Number.isSafeInteger(pairing.generation) || pairing.trust?.algorithm !== 'Ed25519' || !pairing.trust.accountId || !pairing.trust.publicKey || Date.parse(pairing.expiresAt) <= Date.now()) throw new Error('Copy fresh pairing details from GitSpace: Plugins → Browsers → Pair a Chrome'); return { pair: pairing }; }, 'Compare the fingerprint above with GitSpace Settings, then confirm there before agents can use this Chrome.'); });
$('reset').addEventListener('click', () => { void identity(() => ({ resetIdentity: true }), 'Identity reset. Forget this Chrome in GitSpace (Plugins → Browsers → Manage Chrome), then pair it again.'); });
void refresh();
// Scripts start and end while the popup is open.
setInterval(() => { void refresh(); }, 1500);
