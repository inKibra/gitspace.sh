/** The toolbar icon: the GitSpace mark (a dark rounded square with a green `>_`) and what this Chrome is doing,
 * readable at a glance. Drawn in the service worker (`OffscreenCanvas`), so the extension ships no image files. */

/** Off; on and connected with nothing running; a script running somewhere; a capture recording a tab; on but not
 * connected, not paired, or refused as incompatible. */
export type ToolbarState = 'off' | 'idle' | 'working' | 'recording' | 'attention';

const GREEN = '#3fb950';
const BLUE = '#1a73e8';
const AMBER = '#f9ab00';
const RED = '#d93025';
/** The mark's square and its `>_`, by state: grey and faded when off. */
const MARK: Record<ToolbarState, { square: string; prompt: string }> = {
  off: { square: '#9aa0a6', prompt: '#e8eaed' },
  idle: { square: '#0f1115', prompt: GREEN },
  working: { square: '#0f1115', prompt: GREEN },
  recording: { square: '#0f1115', prompt: GREEN },
  attention: { square: '#0f1115', prompt: GREEN },
};

/** Draws the icon for `state` on a `size`×`size` canvas, on a 32-unit grid. */
export function drawToolbarIcon(context: OffscreenCanvasRenderingContext2D, size: number, state: ToolbarState): void {
  context.clearRect(0, 0, size, size);
  context.save();
  context.scale(size / 32, size / 32);
  context.lineCap = 'round';
  context.lineJoin = 'round';
  const ringed = state === 'working' || state === 'recording';
  const inset = ringed ? 3 : 1;
  context.fillStyle = MARK[state].square;
  context.beginPath();
  context.roundRect(inset, inset, 32 - inset * 2, 32 - inset * 2, 7);
  context.fill();
  if (ringed) {
    context.strokeStyle = state === 'recording' ? RED : BLUE;
    context.lineWidth = 3;
    context.beginPath();
    context.roundRect(1.5, 1.5, 29, 29, 8);
    context.stroke();
  }
  context.strokeStyle = MARK[state].prompt;
  context.lineWidth = 3;
  context.beginPath();
  context.moveTo(9, 10.5); context.lineTo(15, 16); context.lineTo(9, 21.5);
  context.moveTo(17.5, 21.5); context.lineTo(23, 21.5);
  context.stroke();
  if (state === 'off') {
    context.strokeStyle = '#ffffff';
    context.lineWidth = 6;
    context.beginPath(); context.moveTo(5, 27); context.lineTo(27, 5); context.stroke();
    context.strokeStyle = '#5f6368';
    context.lineWidth = 3;
    context.beginPath(); context.moveTo(5, 27); context.lineTo(27, 5); context.stroke();
  }
  if (state === 'idle') {
    context.fillStyle = GREEN;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath(); context.arc(25.5, 25.5, 5, 0, Math.PI * 2); context.fill(); context.stroke();
  }
  if (state === 'recording') {
    context.fillStyle = RED;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 2;
    context.beginPath(); context.arc(24.5, 9.5, 5, 0, Math.PI * 2); context.fill(); context.stroke();
  }
  if (state === 'attention') {
    context.fillStyle = AMBER;
    context.strokeStyle = '#ffffff';
    context.lineWidth = 1.5;
    context.beginPath(); context.arc(24.5, 24.5, 7, 0, Math.PI * 2); context.fill(); context.stroke();
    context.strokeStyle = '#202124';
    context.lineWidth = 2.5;
    context.beginPath(); context.moveTo(24.5, 20.5); context.lineTo(24.5, 25); context.stroke();
    context.fillStyle = '#202124';
    context.beginPath(); context.arc(24.5, 28.2, 1.4, 0, Math.PI * 2); context.fill();
  }
  context.restore();
}
