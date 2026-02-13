export type PageDirection = 'up' | 'down';

interface ScrollboxPageNavigationState {
  direction: PageDirection;
  scrollTop: number;
  scrollHeight: number;
  viewportHeight: number;
}

interface ViewportPageNavigationState {
  direction: PageDirection;
  viewportY: number;
  baseY: number;
}

export function shouldConsumePageNavigationInScrollbox({
  direction,
  scrollTop,
  scrollHeight,
  viewportHeight,
}: ScrollboxPageNavigationState): boolean {
  const maxScrollTop = Math.max(0, scrollHeight - viewportHeight);
  if (maxScrollTop <= 0) {
    return false;
  }

  if (direction === 'up') {
    return scrollTop > 0;
  }

  return scrollTop < maxScrollTop;
}

export function canConsumePageNavigationInViewport({
  direction,
  viewportY,
  baseY,
}: ViewportPageNavigationState): boolean {
  if (direction === 'up') {
    return viewportY < baseY;
  }

  return viewportY > 0;
}

export function getPageNavigationEscapeSequence(direction: PageDirection): string {
  return direction === 'up' ? '\x1b[5~' : '\x1b[6~';
}
