import { BACKGROUND_SOURCE, OFFSCREEN_SOURCE, POPUP_SOURCE } from './bundle.generated.js';

export { relayCommandAllowed } from './commands.js';
export { verifyRelayAuthorization } from './authorization.js';

/** The popup (`popup.js` fills it in): plain HTML and CSS in GitSpace's look, light or dark with Chrome. */
const POPUP_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>GitSpace</title><style>
:root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--text:#16181d;--muted:#6b7280;--line:#e4e6eb;--green:#1f9d55;--blue:#1a73e8;--amber:#b7791f;--red:#d93025}
@media (prefers-color-scheme:dark){:root{--bg:#0f1115;--card:#171a21;--text:#e8eaed;--muted:#9aa0a6;--line:#2a2e37;--green:#3fb950;--amber:#f9ab00;--red:#f28b82}}
*{box-sizing:border-box}
body{margin:0;width:360px;font:13px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--text)}
header{display:flex;align-items:center;gap:10px;padding:14px 16px 8px}
.mark{width:30px;height:30px;flex:none}
.brand{flex:1;min-width:0}.brand strong{display:block;font-size:15px;line-height:1.2}
.muted{color:var(--muted);font-size:12px}
#account{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.switch{position:relative;width:52px;height:30px;flex:none;border:0;border-radius:999px;padding:0;background:#9aa0a6;cursor:pointer;transition:background .15s}
.switch::after{content:"";position:absolute;top:3px;left:3px;width:24px;height:24px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.3);transition:transform .15s}
.switch[aria-checked="true"]{background:var(--green)}.switch[aria-checked="true"]::after{transform:translateX(22px)}
.connection{display:flex;align-items:center;gap:8px;margin:0 16px 10px;font-weight:500}
.connection .dot{background:var(--muted)}
[data-connection="connected"] .connection .dot{background:var(--green)}
[data-connection="connecting"] .connection .dot,[data-connection="update"] .connection .dot,[data-connection="unpaired"] .connection .dot{background:var(--amber)}
.dot{width:9px;height:9px;border-radius:50%;flex:none;display:inline-block}
.alert{margin:0 16px 10px;color:var(--amber);font-size:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;margin:0 12px 10px;padding:10px 12px}
h2{margin:0 0 6px;font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--muted)}
ul,ol{list-style:none;margin:0;padding:0}
.group,.row{display:flex;align-items:center;gap:8px;padding:6px 0}.group+.group{border-top:1px solid var(--line)}
.grow{flex:1;min-width:0}.name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
button{font:inherit;font-size:12px;font-weight:500;color:inherit;background:transparent;border:1px solid var(--line);border-radius:8px;padding:4px 10px;cursor:pointer}
button:hover:not(:disabled){border-color:var(--blue);color:var(--blue)}button:disabled{opacity:.5;cursor:default}
button.danger{color:var(--red)}button.danger:hover:not(:disabled){border-color:var(--red);color:var(--red)}
.actions{margin:0 12px 10px}.actions button{width:100%;padding:7px 10px;background:var(--card)}
details summary{cursor:pointer;font-weight:600;color:var(--muted);list-style-position:inside}
details[open] summary{margin-bottom:8px}
code{display:block;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;word-break:break-all;padding:6px 8px;border-radius:8px;background:var(--bg);margin:4px 0 8px}
form{display:flex;gap:6px;margin:8px 0}form label{flex:1}
input{width:100%;font:inherit;font-size:12px;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:5px 8px}
input[type=checkbox]{width:auto;margin:0}
select{font:inherit;font-size:12px;color:inherit;background:var(--bg);border:1px solid var(--line);border-radius:8px;padding:4px 6px}
#share-new .row{justify-content:space-between}#share-new label{display:flex;align-items:center;gap:6px}
.share{padding:4px 0}.share+.share{border-top:1px solid var(--line)}.share .muted{margin:2px 0}.share>button{margin-top:6px}
.viewers{font-size:12px}.guest{margin-left:4px;padding:0 5px;border-radius:999px;border:1px solid var(--line);color:var(--muted);font-size:10px}
#runs li{font-size:11px;color:var(--muted);padding:3px 0;border-top:1px solid var(--line)}
.rec{display:inline-flex;align-items:center;gap:5px;color:var(--red);font-weight:700;font-size:12px}.rec::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--red)}
#tab-capture{margin-top:4px}#tab-capture .muted{flex:1}
#message{margin:0 16px 12px;font-size:12px;color:var(--muted)}#message:empty{display:none}
</style></head><body>
<header><svg class="mark" viewBox="0 0 32 32" aria-hidden="true"><rect width="32" height="32" rx="7" fill="#0f1115"/><path d="M9 10.5l6 5.5-6 5.5M17.5 21.5H23" fill="none" stroke="#3fb950" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>
<div class="brand"><strong>GitSpace</strong><span id="account" class="muted"></span></div>
<button id="enabled" class="switch" type="button" role="switch" aria-checked="false" aria-label="GitSpace in this Chrome"></button></header>
<p class="connection" role="status"><span class="dot"></span><span id="connection-text"></span></p>
<p id="compatibility" class="alert" role="alert" hidden></p>
<section class="card"><h2>Using this Chrome</h2><ul id="groups"></ul><p id="no-groups" class="muted">No workspace is using this Chrome.</p></section>
<section id="this-tab" class="card" hidden><h2>This tab</h2><div class="row"><span id="tab-dot" class="dot"></span><span id="tab-group" class="grow name"></span><button id="ungroup" type="button">Remove from group</button></div>
<div id="tab-capture" class="row"><span id="capture-state" class="muted"></span><button id="capture" type="button">Capture</button></div></section>
<section id="share" class="card" hidden><h2>Share this tab</h2>
<div id="share-new"><div class="row"><label><input id="share-comment" type="checkbox">Comments</label><select id="share-expiry" aria-label="The link ends after"><option value="15">15 minutes</option><option value="60" selected>1 hour</option><option value="480">8 hours</option><option value="1440">24 hours</option></select><button id="share-copy" type="button">Copy link</button></div>
<p id="share-comment-hint" class="muted">Comments need the tab in a workspace group</p><p id="share-unavailable" class="muted" hidden></p></div>
<ul id="shares"></ul></section>
<section id="recordings-card" class="card" hidden><h2>Recording</h2><ul id="recordings"></ul></section>
<div class="actions"><button id="snooze" type="button">Off for 1 hour</button></div>
<details id="identity" class="card"><summary>Identity &amp; pairing</summary>
<p class="muted">Browser identity — compare this fingerprint with the one GitSpace shows when you pair. Extension public key fingerprint (SHA-256):</p><code id="fingerprint"></code>
<form id="pair"><label><input id="code" autocomplete="off" required placeholder="Account pairing details" aria-label="Account pairing details"></label><button>Pair</button></form>
<button id="reset" type="button" class="danger">Reset identity</button>
<h2 style="margin-top:12px">Recent scripts</h2><ol id="runs"></ol><p id="no-runs" class="muted">No scripts have run here yet.</p>
</details>
<p id="message" role="status"></p>
<script src="popup.js"></script></body></html>`;

/** The unpacked extension for one account: the service worker reaches the account it was downloaded from; the
 * offscreen document records the tabs you capture. */
export function extensionFiles(accountUrl: string): Record<string, string> {
  return {
    'background.js': `const GITSPACE_ACCOUNT_URL = ${JSON.stringify(accountUrl)};\n${BACKGROUND_SOURCE}`,
    'popup.js': POPUP_SOURCE,
    'popup.html': POPUP_HTML,
    'offscreen.js': OFFSCREEN_SOURCE,
    'offscreen.html': '<!doctype html><html><head><meta charset="utf-8"><title>GitSpace recorder</title></head><body><script src="offscreen.js"></script></body></html>',
    'manifest.json': JSON.stringify({ manifest_version: 3, name: 'GitSpace Browser Relay', version: '5.6.0', minimum_chrome_version: '124', permissions: ['debugger', 'tabs', 'tabGroups', 'alarms', 'storage', 'downloads', 'tabCapture', 'offscreen'], host_permissions: [`${new URL(accountUrl).origin}/*`], background: { service_worker: 'background.js' }, action: { default_popup: 'popup.html', default_title: 'GitSpace' } }),
  };
}
