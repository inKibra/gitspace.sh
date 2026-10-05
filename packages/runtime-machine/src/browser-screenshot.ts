/** Fixed isolated-world functions shared with the generated extension. No caller-supplied code. */
export const browserScreenshotPrepareFunction = `function(boxes) {
  const key = '__gitspaceBrowserMask';
  if (globalThis[key]) throw new Error('Screenshot mask already active');
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  const root = host.attachShadow({mode:'closed'});
  const styles = [];
  const cover = (rect, label) => {
    const el = document.createElement('div');
    el.style.cssText = 'position:absolute;background:#111;color:white;font:12px monospace;overflow:hidden';
    el.style.left = rect.x+'px'; el.style.top = rect.y+'px';
    el.style.width = rect.width+'px'; el.style.height = rect.height+'px';
    el.textContent = label; root.appendChild(el);
  };
  const scan = (parent) => {
    const style = document.createElement('style');
    const custom = [...parent.querySelectorAll('*')].filter(el=>el.localName.includes('-')).map(el=>el.localName);
    style.textContent = ['input','textarea','select','[contenteditable]','iframe','canvas','video',...custom].join(',') + '{visibility:hidden!important}';
    (parent === document ? document.documentElement : parent).appendChild(style); styles.push(style);
    for (const el of parent.querySelectorAll('*')) {
      if (el.matches('input,textarea,select,[contenteditable],iframe,canvas,video')) cover(el.getBoundingClientRect(), '[masked]');
      if (el.shadowRoot) scan(el.shadowRoot);
    }
  };
  scan(document);
  for (const box of boxes) cover({x:box.x,y:box.y,width:Math.max(28,box.ref.length*8),height:16},box.ref);
  document.documentElement.appendChild(host); globalThis[key] = {host,styles};
  return {width:innerWidth,height:innerHeight};
}`;
export const browserScreenshotRestoreFunction = `function() { const mask=globalThis.__gitspaceBrowserMask; mask?.host.remove(); for(const style of mask?.styles ?? []) style.remove(); delete globalThis.__gitspaceBrowserMask; }`;
