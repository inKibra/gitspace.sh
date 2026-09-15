/** Keep touch shells inside the visible viewport without reflowing pinch zoom. */
export function observeAppViewport(): () => void {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};

  const touch = window.matchMedia('(pointer: coarse)');
  const style = document.documentElement.style;
  let frame = 0;
  let height = -1;
  let top = -1;
  let bottom = -1;

  const clear = () => {
    style.removeProperty('--app-viewport-height');
    style.removeProperty('--app-viewport-top');
    style.removeProperty('--app-viewport-bottom');
    height = top = bottom = -1;
  };
  const update = () => {
    frame = 0;
    if (!touch.matches) { clear(); return; }
    // The OS keyboard changes the visual viewport, not dvh. Pinch zoom also
    // changes it, but must keep the existing layout available to zoom and pan.
    if (viewport.scale !== 1) return;
    const nextTop = Math.max(0, viewport.offsetTop);
    const nextBottom = Math.max(0, document.documentElement.clientHeight - nextTop - viewport.height);
    if (height !== viewport.height) style.setProperty('--app-viewport-height', `${height = viewport.height}px`);
    if (top !== nextTop) style.setProperty('--app-viewport-top', `${top = nextTop}px`);
    if (bottom !== nextBottom) style.setProperty('--app-viewport-bottom', `${bottom = nextBottom}px`);
  };
  const schedule = () => { if (!frame) frame = window.requestAnimationFrame(update); };

  update();
  viewport.addEventListener('resize', schedule);
  viewport.addEventListener('scroll', schedule);
  window.addEventListener('resize', schedule);
  touch.addEventListener('change', schedule);
  return () => {
    window.cancelAnimationFrame(frame);
    viewport.removeEventListener('resize', schedule);
    viewport.removeEventListener('scroll', schedule);
    window.removeEventListener('resize', schedule);
    touch.removeEventListener('change', schedule);
    clear();
  };
}
