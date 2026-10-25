/** The toolbar icon (the agreed look is account-web's BrowsersMockExtension `ExtensionIcon`): GitSpace's mark, the
 * favicon's green `>_`, and what this Chrome is doing, readable at a glance. Drawn in the service worker
 * (`OffscreenCanvas`), so the extension ships no image files; the count of what works and the `!` are the action's
 * badge. */

/** Off (grey, struck through); on and connected with nothing running (a green dot); working, while an agent acts or a
 * capture records (a blue ring); needs you: on but not connected, not paired, or refused as incompatible (an amber
 * ring). */
export type ToolbarState = 'off' | 'on' | 'working' | 'attention';

/** The ring of a working or attention icon, and the badge behind its count or `!`. */
export const TOOLBAR_TONE: Record<'working' | 'attention', string> = { working: '#1a73e8', attention: '#f59e0b' };
const GREEN = '#22c55e';

/** The favicon's `>_` (on a 512 grid) in a `size` square at `x`, `y`: a chevron and a line, each a green gradient, or
 * grey when off. */
function mark(context: OffscreenCanvasRenderingContext2D, x: number, y: number, size: number, grey: boolean): void {
  context.save();
  context.translate(x, y);
  context.scale(size / 512, size / 512);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  context.lineWidth = 42;
  if (grey) context.globalAlpha = 0.45;
  const chevron = context.createLinearGradient(0, 85, 0, 381);
  chevron.addColorStop(0, grey ? '#5c5c5c' : '#037935');
  chevron.addColorStop(1, grey ? '#9a9a9a' : '#05e063');
  context.strokeStyle = chevron;
  context.beginPath(); context.moveTo(85, 106); context.lineTo(213, 233); context.lineTo(85, 360); context.stroke();
  const line = context.createLinearGradient(0, 398, 0, 426);
  line.addColorStop(0, grey ? '#5c5c5c' : '#037935');
  line.addColorStop(1, grey ? '#8f8f8f' : '#06c958');
  context.strokeStyle = line;
  context.beginPath(); context.moveTo(256, 405); context.lineTo(426, 405); context.stroke();
  context.restore();
}

/** Draws the icon for `state` on a `size`×`size` canvas, on a 32-unit grid. */
export function drawToolbarIcon(context: OffscreenCanvasRenderingContext2D, size: number, state: ToolbarState): void {
  context.clearRect(0, 0, size, size);
  context.save();
  context.scale(size / 32, size / 32);
  if (state === 'working' || state === 'attention') {
    context.strokeStyle = TOOLBAR_TONE[state];
    context.lineWidth = 2.5;
    context.beginPath(); context.arc(16, 16, 14.5, 0, Math.PI * 2); context.stroke();
    mark(context, 5, 5, 22, false);
  } else mark(context, 0, 0, 32, state === 'off');
  if (state === 'off') {
    context.strokeStyle = '#737373';
    context.lineWidth = 2.5;
    context.lineCap = 'round';
    context.beginPath(); context.moveTo(5, 27); context.lineTo(27, 5); context.stroke();
  }
  if (state === 'on') {
    context.fillStyle = GREEN;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath(); context.arc(26, 26, 4.5, 0, Math.PI * 2); context.fill(); context.stroke();
  }
  context.restore();
}
