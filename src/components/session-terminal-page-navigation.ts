export type PageDirection = 'up' | 'down';

interface ScrollboxPageNavigationState {
  scrollHeight: number;
  viewportHeight: number;
}

interface ViewportPageNavigationState {
  direction: PageDirection;
  viewportY: number;
  baseY: number;
}

export function shouldConsumePageNavigationInScrollbox({
  scrollHeight,
  viewportHeight,
}: ScrollboxPageNavigationState): boolean {
  return scrollHeight > viewportHeight;
}

export function canConsumePageNavigationInViewport({
  direction,
  viewportY,
  baseY,
}: ViewportPageNavigationState): boolean {
  if (direction === 'up') {
    return baseY > 0 || viewportY > 0;
  }

  return viewportY < baseY;
}

export function getPageNavigationEscapeSequence(direction: PageDirection): string {
  return direction === 'up' ? '\x1b[5~' : '\x1b[6~';
}
